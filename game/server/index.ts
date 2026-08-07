import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  isValidLobbyCode,
  type ClientMessage,
  type ErrorCode,
  type InputMessage,
  type LobbyStatus,
  type LobbyView,
  type ServerMessage,
  type StateMessage,
} from '../shared/protocol.js'
import { InMemoryLobbyStore, RedisLobbyStore, type LobbyStore } from './lobby-store.js'
import { connectRedis, type RedisConnections } from './redis.js'
import { createLocalRelay, createRedisRelay, type Relay, type RelayEnvelope } from './relay.js'
import {
  IDLE_LOBBY_TTL_MS,
  LobbyFullError,
  LobbyInProgressError,
  addPlayer,
  beginRound,
  canStart,
  createLobby,
  findPlayer,
  generateLobbyCode,
  recordRoundResult,
  removePlayer,
  resetMatch,
  startBlockedReason,
  toView,
  type LobbyRecord,
} from './lobby.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// Compiled layout is dist-server/server/index.js, so the Vite build sits two
// levels up in dist/.
const clientDir = path.resolve(here, '../../dist')

const port = Number(process.env.PORT) || 8080

// Multi-instance support is opt-in via configuration. With REDIS_URL set,
// lobbies are shared and messages cross instances; without it the server is a
// single-process affair, which is all local development and the tests need.
const redisUrl = process.env.REDIS_URL?.trim()

let redis: RedisConnections | null = null
let store: LobbyStore = new InMemoryLobbyStore()

if (redisUrl) {
  // Fail loudly rather than quietly degrading. A server that starts without the
  // cache it was configured for looks healthy while every lobby code silently
  // becomes invisible to the other instances — the exact bug this replaced.
  redis = await connectRedis(redisUrl)
  store = new RedisLobbyStore(redis.commands)
  console.log('[whatabomb] lobby state shared via Redis')
} else {
  console.log('[whatabomb] no REDIS_URL — single-instance lobby state')
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = express()

app.get('/healthz', async (_req, res) => {
  res.json({
    ok: true,
    protocol: PROTOCOL_VERSION,
    lobbies: await store.size(),
    instance: process.env.WEBSITE_INSTANCE_ID?.slice(0, 8) ?? 'local',
    // Whether this instance is sharing lobby state. If this ever reports
    // "local" in production, lobby codes have gone back to being per-instance
    // and cross-instance joins will fail.
    lobbyState: redis ? 'shared' : 'local',
  })
})

// Hashed asset filenames are safe to cache hard; index.html must not be.
app.use(
  express.static(clientDir, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache')
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }),
)

// Single page app: anything not matched by a real file returns index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  res.sendFile(path.join(clientDir, 'index.html'), err => {
    if (err) next(err)
  })
})

const server = createServer(app)

// ── WebSocket ────────────────────────────────────────────────────────────────

interface Connection {
  socket: WebSocket
  playerId: string | null
  lobbyCode: string | null
  lastSeen: number
  /** Sliding window used to throttle abusive clients. */
  windowStart: number
  windowCount: number
}

const connections = new Map<WebSocket, Connection>()

/**
 * Sockets grouped by the lobby they are seated in.
 *
 * Delivery used to scan every connection on the instance and filter, which is
 * fine for one lobby and quadratic for a hundred: with Redis every instance
 * sees every envelope for every lobby, and a match in progress produces up to
 * thirty of them a second. That put the cost of one busy lobby onto every
 * player of every other one. The index makes delivery cost what it should —
 * the number of people actually being written to.
 */
const lobbyConnections = new Map<string, Set<Connection>>()

/** Seat a connection in a lobby, keeping the index in step. */
function seatConnection(connection: Connection, code: string, playerId: string): void {
  unseatConnection(connection)
  connection.lobbyCode = code
  connection.playerId = playerId
  let seated = lobbyConnections.get(code)
  if (!seated) {
    seated = new Set()
    lobbyConnections.set(code, seated)
  }
  seated.add(connection)
}

/** Take a connection out of whatever lobby it was in. Safe to call twice. */
function unseatConnection(connection: Connection): void {
  const code = connection.lobbyCode
  connection.lobbyCode = null
  connection.playerId = null
  if (!code) return
  const seated = lobbyConnections.get(code)
  if (!seated) return
  seated.delete(connection)
  if (seated.size === 0) lobbyConnections.delete(code)
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
})

// With Redis, every instance both publishes and receives; without it, delivery
// is a direct call. Either way the rest of the server only ever addresses
// players, never sockets on a particular machine.
const relay: Relay = redis
  ? await createRedisRelay(redis.commands, redis.subscriber, deliverLocally)
  : createLocalRelay(deliverLocally)

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(message))
}

function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { t: 'error', code, message })
}

/**
 * Deliver to whichever of the addressed players this instance is holding.
 *
 * Other instances run the same thing over their own sockets, so between them
 * everyone addressed is reached exactly once, wherever they happen to be
 * pinned.
 */
function sendToLocal(code: string, playerIds: string[] | null, message: ServerMessage): void {
  const seated = lobbyConnections.get(code)
  if (!seated) return
  const wanted = playerIds ? new Set(playerIds) : null
  for (const connection of seated) {
    if (!connection.playerId) continue
    if (wanted && !wanted.has(connection.playerId)) continue
    send(connection.socket, message)
  }
}

/**
 * Who is in each lobby and who hosts it, cached per instance.
 *
 * Gameplay traffic — inputs and world snapshots — needs the host id and the
 * roster on every single message. Reading those from Redis each time would put
 * a network round trip in the movement path, so instead the cache is refreshed
 * from the lobby views that already flow past on the relay. It is derived data
 * only: anything that changes a lobby still writes to the store.
 */
interface MatchContext {
  code: string
  hostId: string
  playerIds: string[]
  status: LobbyStatus
}

const matchCache = new Map<string, MatchContext>()

function rememberLobby(view: LobbyView): void {
  const host = view.players.find(p => p.isHost)
  if (!host) return
  matchCache.set(view.code, {
    code: view.code,
    hostId: host.id,
    playerIds: view.players.map(p => p.id),
    status: view.status,
  })
}

/** Cached roster for this connection's lobby, falling back to the store once. */
async function matchContext(connection: Connection): Promise<MatchContext | null> {
  if (!connection.lobbyCode) return null
  const cached = matchCache.get(connection.lobbyCode)
  if (cached) return cached

  const lobby = await store.get(connection.lobbyCode)
  if (!lobby) return null
  const view = toView(lobby)
  rememberLobby(view)
  return matchCache.get(connection.lobbyCode) ?? null
}

/** Deliver a relayed envelope to whichever of its addressees are local. */
function deliverLocally(envelope: RelayEnvelope): void {
  // Every instance sees every envelope, so all of them keep an accurate roster
  // even for lobbies they currently hold no sockets for.
  const carried = (envelope.message as { lobby?: LobbyView }).lobby
  if (carried) rememberLobby(carried)

  sendToLocal(envelope.code, envelope.to, envelope.message)
}

/**
 * Send to players, wherever they are.
 *
 * Everything that has to reach someone other than the caller goes through here:
 * a player's socket may well be pinned to a different instance, so addressing a
 * local socket list directly would silently drop them.
 */
function relayTo(code: string, to: string[] | null, message: ServerMessage): void {
  relay.publish({ code, to, message })
}

function broadcastLobby(lobby: LobbyRecord): void {
  relayTo(lobby.code, null, { t: 'lobby', lobby: toView(lobby) })
}

async function loadLobbyFor(connection: Connection): Promise<LobbyRecord | undefined> {
  if (!connection.lobbyCode) return undefined
  return store.get(connection.lobbyCode)
}

/**
 * Forward one piece of gameplay traffic. Pure relay: the server never opens a
 * snapshot or judges a move, it only decides who is entitled to hear it.
 */
function relayGameplay(
  match: MatchContext,
  connection: Connection,
  message: InputMessage | StateMessage,
): void {
  if (match.status !== 'playing') return

  if (message.t === 'input') {
    // Guests send inputs; only the host needs them.
    if (!connection.playerId) return
    relayTo(match.code, [match.hostId], {
      t: 'relayInput',
      playerId: connection.playerId,
      seq: Number(message.seq) || 0,
      dx: Math.sign(Number(message.dx) || 0),
      dy: Math.sign(Number(message.dy) || 0),
      bomb: Boolean(message.bomb),
      // Timing the host needs, passed through untouched. Both are read only
      // against a clock the reader already owns, so the relay has no business
      // rewriting them — see InputMessage.
      at: Number(message.at) || 0,
      ackTick: Number(message.ackTick) || 0,
    })
    return
  }

  // Only the host may describe the world.
  if (match.hostId !== connection.playerId) return
  const guests = match.playerIds.filter(id => id !== match.hostId)
  if (guests.length === 0) return

  relayTo(match.code, guests, {
    t: 'relayState',
    tick: Number(message.tick) || 0,
    payload: message.payload,
  })
}

/**
 * Cheap per-connection rate limit. Gameplay traffic is chatty, so the ceiling is
 * generous — this only exists to stop a runaway or hostile client.
 */
const RATE_LIMIT_WINDOW_MS = 1000
const RATE_LIMIT_MAX_MESSAGES = 120

function overRateLimit(connection: Connection): boolean {
  const now = Date.now()
  if (now - connection.windowStart >= RATE_LIMIT_WINDOW_MS) {
    connection.windowStart = now
    connection.windowCount = 0
  }
  connection.windowCount++
  return connection.windowCount > RATE_LIMIT_MAX_MESSAGES
}

wss.on('connection', socket => {
  const connection: Connection = {
    socket,
    playerId: null,
    lobbyCode: null,
    lastSeen: Date.now(),
    windowStart: Date.now(),
    windowCount: 0,
  }
  connections.set(socket, connection)
  send(socket, { t: 'welcome', protocol: PROTOCOL_VERSION })

  socket.on('pong', () => {
    connection.lastSeen = Date.now()
  })

  socket.on('message', raw => {
    connection.lastSeen = Date.now()

    if (overRateLimit(connection)) {
      sendError(socket, 'rate_limited', 'Slow down')
      return
    }

    let message: ClientMessage
    try {
      message = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      sendError(socket, 'bad_request', 'Malformed JSON')
      return
    }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
      sendError(socket, 'bad_request', 'Missing message type')
      return
    }

    // Inputs and snapshots take a synchronous path whenever the roster is
    // already cached, which is all the time once a match is under way.
    //
    // Not only for the saved allocations. Every handler here is independent, so
    // two messages that both suspend on an await resume in whatever order their
    // awaits happen to settle — and a message that takes the slow path can
    // therefore overtake one sent before it. Gameplay traffic is the one kind
    // where that matters and the one kind that never needs to wait for
    // anything, so it is kept off the async path entirely.
    if (message.t === 'input' || message.t === 'state') {
      const match = connection.lobbyCode ? matchCache.get(connection.lobbyCode) : undefined
      if (match) {
        relayGameplay(match, connection, message)
        return
      }
    }

    handleMessage(connection, message).catch(err => {
      console.error('[ws] handler failed', err)
      sendError(socket, 'internal', 'Something went wrong')
    })
  })

  socket.on('close', () => {
    const { lobbyCode, playerId } = connection
    unseatConnection(connection)
    connections.delete(socket)
    if (lobbyCode && playerId) {
      void releaseSeat(lobbyCode, playerId).catch(err => {
        console.error('[ws] releasing seat failed', err)
      })
    }
  })

  socket.on('error', err => {
    console.error('[ws] socket error', err)
  })
})

async function handleMessage(connection: Connection, message: ClientMessage): Promise<void> {
  const { socket } = connection

  switch (message.t) {
    case 'ping': {
      send(socket, { t: 'pong', ts: typeof message.ts === 'number' ? message.ts : 0 })
      return
    }

    case 'create': {
      if (connection.lobbyCode) {
        sendError(socket, 'already_in_lobby', 'Leave your current lobby first')
        return
      }
      const code = await generateLobbyCode(store)
      const lobby = createLobby(code, message.name)
      await store.set(code, lobby)

      seatConnection(connection, code, lobby.hostId)
      send(socket, { t: 'joined', youId: lobby.hostId, lobby: toView(lobby) })
      return
    }

    case 'join': {
      if (connection.lobbyCode) {
        sendError(socket, 'already_in_lobby', 'Leave your current lobby first')
        return
      }
      if (!isValidLobbyCode(message.code)) {
        sendError(socket, 'bad_request', 'Codes are 6 digits')
        return
      }
      // Locked: two players joining through two different instances at the same
      // moment would otherwise read the same roster and the second write would
      // erase the first player's seat.
      type JoinOutcome =
        | { ok: false; code: ErrorCode; reason: string }
        | { ok: true; lobby: LobbyRecord; playerId: string }

      const outcome = await store.withLock(message.code, async (): Promise<JoinOutcome> => {
        const lobby = await store.get(message.code)
        if (!lobby) {
          return {
            ok: false,
            code: 'lobby_not_found',
            reason: 'No lobby with that code — check the host is on this same site',
          }
        }

        try {
          const player = addPlayer(lobby, message.name)
          await store.set(lobby.code, lobby)
          return { ok: true, lobby, playerId: player.id }
        } catch (err) {
          if (err instanceof LobbyFullError) {
            return { ok: false, code: 'lobby_full', reason: err.message }
          }
          if (err instanceof LobbyInProgressError) {
            return { ok: false, code: 'lobby_in_progress', reason: err.message }
          }
          throw err
        }
      })

      if (!outcome.ok) {
        sendError(socket, outcome.code, outcome.reason)
        return
      }

      seatConnection(connection, outcome.lobby.code, outcome.playerId)

      send(socket, { t: 'joined', youId: outcome.playerId, lobby: toView(outcome.lobby) })
      broadcastLobby(outcome.lobby)
      return
    }

    case 'resume': {
      // A returning client reclaiming the seat held for it by handleDisconnect.
      if (connection.lobbyCode) {
        sendError(socket, 'already_in_lobby', 'Leave your current lobby first')
        return
      }
      if (!isValidLobbyCode(message.code) || typeof message.playerId !== 'string') {
        sendError(socket, 'bad_request', 'Malformed resume')
        return
      }

      const resumed = await store.withLock(message.code, async () => {
        const lobby = await store.get(message.code)
        if (!lobby) return null
        const player = findPlayer(lobby, message.playerId)
        if (!player) return null

        player.connected = true
        player.disconnectedAt = null
        await store.set(lobby.code, lobby)
        return lobby
      })

      if (!resumed) {
        // The seat is gone — the grace period lapsed or the lobby closed. Say
        // so plainly so the client stops retrying and offers a fresh start.
        sendError(socket, 'not_in_lobby', 'That match has moved on without you')
        return
      }

      seatConnection(connection, resumed.code, message.playerId)
      send(socket, { t: 'joined', youId: message.playerId, lobby: toView(resumed) })
      broadcastLobby(resumed)
      return
    }

    case 'leave': {
      const { lobbyCode, playerId } = connection
      unseatConnection(connection)
      if (lobbyCode && playerId) await releaseSeat(lobbyCode, playerId, { immediate: true })
      return
    }

    case 'ready': {
      if (!connection.lobbyCode || !connection.playerId) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      const playerId = connection.playerId
      const ready = Boolean(message.ready)

      const updated = await store.withLock(connection.lobbyCode, async () => {
        const lobby = await loadLobbyFor(connection)
        if (!lobby) return null
        const player = findPlayer(lobby, playerId)
        if (!player) return null
        player.ready = ready
        await store.set(lobby.code, lobby)
        return lobby
      })

      if (!updated) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      broadcastLobby(updated)
      return
    }

    case 'start': {
      if (!connection.lobbyCode || !connection.playerId) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      const playerId = connection.playerId
      // One seed for everyone so all clients generate an identical arena.
      const seed = randomInt(0, 2 ** 31 - 1)

      type StartOutcome =
        | { ok: false; code: ErrorCode; reason: string }
        | { ok: true; lobby: LobbyRecord }

      const outcome = await store.withLock(connection.lobbyCode, async (): Promise<StartOutcome> => {
        const lobby = await loadLobbyFor(connection)
        if (!lobby) {
          return { ok: false, code: 'not_in_lobby', reason: 'You are not in a lobby' }
        }
        if (lobby.hostId !== playerId) {
          return { ok: false, code: 'not_host', reason: 'Only the host can start the match' }
        }
        if (!canStart(lobby)) {
          return {
            ok: false,
            code: 'cannot_start',
            reason: startBlockedReason(lobby) ?? 'Cannot start yet',
          }
        }
        beginRound(lobby)
        await store.set(lobby.code, lobby)
        return { ok: true, lobby }
      })

      if (!outcome.ok) {
        sendError(socket, outcome.code, outcome.reason)
        return
      }

      const { lobby } = outcome
      relayTo(lobby.code, null, {
        t: 'matchStart',
        seed,
        round: lobby.round,
        hostId: lobby.hostId,
        lobby: toView(lobby),
      })
      return
    }

    case 'input':
    case 'state': {
      // Only reached when the roster was not cached — see relayGameplay, which
      // handles these synchronously in the common case.
      const match = await matchContext(connection)
      if (match) relayGameplay(match, connection, message)
      return
    }

    case 'roundResult': {
      if (!connection.lobbyCode || !connection.playerId) return
      const playerId = connection.playerId
      const claimedWinner = message.winnerId

      const outcome = await store.withLock(connection.lobbyCode, async () => {
        const lobby = await loadLobbyFor(connection)
        if (!lobby || lobby.hostId !== playerId) return null
        if (lobby.status !== 'playing') return null

        const winnerId =
          typeof claimedWinner === 'string' && findPlayer(lobby, claimedWinner)
            ? claimedWinner
            : null

        const { matchWinnerId } = recordRoundResult(lobby, winnerId)
        await store.set(lobby.code, lobby)
        const view = toView(lobby)

        // A decided match rolls back to a fresh scoreboard so the group can
        // immediately play again with the same code.
        if (matchWinnerId) {
          resetMatch(lobby)
          await store.set(lobby.code, lobby)
        }
        return { lobby, view, winnerId, matchWinnerId }
      })

      if (!outcome) return

      relayTo(outcome.lobby.code, null, {
        t: 'roundOver',
        winnerId: outcome.winnerId,
        lobby: outcome.view,
        matchWinnerId: outcome.matchWinnerId,
      })
      if (outcome.matchWinnerId) broadcastLobby(outcome.lobby)
      return
    }

    default: {
      sendError(socket, 'bad_request', `Unknown message type`)
    }
  }
}

/**
 * Give up a seat, either holding it for a reconnect or vacating it outright.
 *
 * Takes the code and player explicitly rather than reading them off the
 * connection: callers unseat the connection immediately, and this runs across
 * awaits, so reading them here would be reading them after they were cleared.
 */
async function releaseSeat(
  code: string,
  playerId: string,
  options: { immediate?: boolean } = {},
): Promise<void> {
  const lobby = await store.withLock(code, async () => {
    const current = await store.get(code)
    if (!current) return null

    const player = findPlayer(current, playerId)
    if (!player) return null

    if (options.immediate) {
      removePlayer(current, playerId)
    } else {
      // Hold the seat briefly so a refresh or flaky connection does not end a match.
      player.connected = false
      player.ready = false
      player.disconnectedAt = Date.now()
    }

    if (current.players.length === 0) {
      await store.delete(code)
      matchCache.delete(code)
      return null
    }

    await store.set(code, current)
    return current
  })

  if (!lobby) return
  broadcastLobby(lobby)
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

// Drop sockets that stopped answering pings, so seats are not held forever.
const heartbeat = setInterval(() => {
  const now = Date.now()
  for (const connection of connections.values()) {
    if (now - connection.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      connection.socket.terminate()
      continue
    }
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.ping()
    }
  }
}, HEARTBEAT_INTERVAL_MS)

/**
 * Reap abandoned lobbies and expired reconnect grace periods.
 *
 * `connected` is only meaningful across the whole cluster, so this deliberately
 * reads the shared record rather than local socket state — a player connected
 * to another instance must not look absent from here.
 */
const sweep = setInterval(() => {
  void (async () => {
    const now = Date.now()
    const lobbies = await store.values()

    // Forget lobbies that no longer exist.
    //
    // The roster cache is filled from relay traffic, which every instance sees
    // for every lobby — so every instance ends up holding an entry for every
    // lobby in the cluster, while only the one that happens to reap a lobby
    // deletes its own copy. The others kept theirs for the life of the process.
    // Reconciling against the store here is what stops that being a slow leak
    // on every instance but one. Anything wrongly dropped — a lobby created
    // between the scan and now — is simply re-read from the store on its next
    // message.
    const alive = new Set(lobbies.map(lobby => lobby.code))
    for (const code of [...matchCache.keys()]) {
      if (!alive.has(code)) matchCache.delete(code)
    }

    for (const snapshot of lobbies) {
      // Re-read under the lock: a join landing on another instance between the
      // scan and the write would otherwise be erased by this pass.
      const result = await store.withLock(snapshot.code, async () => {
        const lobby = await store.get(snapshot.code)
        if (!lobby) return null

        let rosterChanged = false
        for (const player of [...lobby.players]) {
          if (
            !player.connected &&
            player.disconnectedAt !== null &&
            now - player.disconnectedAt > RECONNECT_GRACE_MS
          ) {
            removePlayer(lobby, player.id)
            rosterChanged = true
          }
        }

        // `updatedAt` only moves on a mutation, so a host sitting in an open
        // lobby waiting for friends looks idle. Expiring on that alone deleted
        // lobbies out from under people who were still connected and watching
        // the code on screen — the joiner then got "no lobby with that code"
        // for a code that was, from the host's side, plainly still there. A
        // lobby is only ever reaped once nobody is connected to it.
        const occupied = lobby.players.some(p => p.connected)
        if (!occupied && (lobby.players.length === 0 || now - lobby.updatedAt > IDLE_LOBBY_TTL_MS)) {
          await store.delete(lobby.code)
          matchCache.delete(lobby.code)
          return null
        }
        if (occupied) lobby.updatedAt = now

        await store.set(lobby.code, lobby)
        return { lobby, rosterChanged }
      })

      if (result?.rosterChanged) broadcastLobby(result.lobby)
    }
  })()
}, 15_000)

server.listen(port, () => {
  console.log(`[whatabomb] listening on :${port}`)
  console.log(`[whatabomb] serving client from ${clientDir}`)
})

function shutdown(signal: string): void {
  console.log(`[whatabomb] ${signal} received, shutting down`)
  // Closing the Redis connections is what tears the relay down; the relay
  // itself holds nothing of its own to release.
  void redis?.close()
  clearInterval(heartbeat)
  clearInterval(sweep)
  for (const connection of connections.values()) connection.socket.close(1001, 'Server shutting down')
  wss.close()
  server.close(() => process.exit(0))
  // Do not hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
