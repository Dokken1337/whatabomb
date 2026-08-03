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
  isValidLobbyCode,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '../shared/protocol.js'
import { InMemoryLobbyStore, type LobbyStore } from './lobby-store.js'
import {
  IDLE_LOBBY_TTL_MS,
  RECONNECT_GRACE_MS,
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
const store: LobbyStore = new InMemoryLobbyStore()

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = express()

app.get('/healthz', async (_req, res) => {
  res.json({
    ok: true,
    protocol: PROTOCOL_VERSION,
    lobbies: await store.size(),
    // Lobbies are per-process. Surfacing the instance makes a scale-out — where
    // a code created on one worker is invisible on the other — diagnosable from
    // outside instead of looking like a code that expired.
    instance: process.env.WEBSITE_INSTANCE_ID?.slice(0, 8) ?? 'local',
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

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
})

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(message))
}

function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { t: 'error', code, message })
}

/** Every open socket currently seated in `lobby`. */
function connectionsFor(lobby: LobbyRecord): Connection[] {
  const seated = new Set(lobby.players.map(p => p.id))
  return [...connections.values()].filter(c => c.playerId && seated.has(c.playerId))
}

function broadcastLobby(lobby: LobbyRecord): void {
  const view = toView(lobby)
  for (const connection of connectionsFor(lobby)) {
    send(connection.socket, { t: 'lobby', lobby: view })
  }
}

async function loadLobbyFor(connection: Connection): Promise<LobbyRecord | undefined> {
  if (!connection.lobbyCode) return undefined
  return store.get(connection.lobbyCode)
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

  socket.on('message', async raw => {
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

    try {
      await handleMessage(connection, message)
    } catch (err) {
      console.error('[ws] handler failed', err)
      sendError(socket, 'internal', 'Something went wrong')
    }
  })

  socket.on('close', () => {
    void handleDisconnect(connection)
    connections.delete(socket)
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

      connection.lobbyCode = code
      connection.playerId = lobby.hostId
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
      const lobby = await store.get(message.code)
      if (!lobby) {
        sendError(
          socket,
          'lobby_not_found',
          'No lobby with that code — check the host is on this same site',
        )
        return
      }

      let player
      try {
        player = addPlayer(lobby, message.name)
      } catch (err) {
        if (err instanceof LobbyFullError) {
          sendError(socket, 'lobby_full', err.message)
        } else if (err instanceof LobbyInProgressError) {
          sendError(socket, 'lobby_in_progress', err.message)
        } else {
          throw err
        }
        return
      }

      await store.set(lobby.code, lobby)
      connection.lobbyCode = lobby.code
      connection.playerId = player.id

      send(socket, { t: 'joined', youId: player.id, lobby: toView(lobby) })
      broadcastLobby(lobby)
      return
    }

    case 'leave': {
      await handleDisconnect(connection, { immediate: true })
      connection.lobbyCode = null
      connection.playerId = null
      return
    }

    case 'ready': {
      const lobby = await loadLobbyFor(connection)
      if (!lobby || !connection.playerId) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      const player = findPlayer(lobby, connection.playerId)
      if (!player) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      player.ready = Boolean(message.ready)
      await store.set(lobby.code, lobby)
      broadcastLobby(lobby)
      return
    }

    case 'start': {
      const lobby = await loadLobbyFor(connection)
      if (!lobby || !connection.playerId) {
        sendError(socket, 'not_in_lobby', 'You are not in a lobby')
        return
      }
      if (lobby.hostId !== connection.playerId) {
        sendError(socket, 'not_host', 'Only the host can start the match')
        return
      }
      if (!canStart(lobby)) {
        sendError(socket, 'cannot_start', startBlockedReason(lobby) ?? 'Cannot start yet')
        return
      }

      beginRound(lobby)
      await store.set(lobby.code, lobby)

      // One seed for everyone so all clients generate an identical arena.
      const seed = randomInt(0, 2 ** 31 - 1)
      const view = toView(lobby)
      for (const target of connectionsFor(lobby)) {
        send(target.socket, {
          t: 'matchStart',
          seed,
          round: lobby.round,
          hostId: lobby.hostId,
          lobby: view,
        })
      }
      return
    }

    case 'input': {
      // Guests send inputs; only the host needs them.
      const lobby = await loadLobbyFor(connection)
      if (!lobby || !connection.playerId || lobby.status !== 'playing') return

      const host = connectionsFor(lobby).find(c => c.playerId === lobby.hostId)
      if (!host) return
      send(host.socket, {
        t: 'relayInput',
        playerId: connection.playerId,
        seq: Number(message.seq) || 0,
        dx: Math.sign(Number(message.dx) || 0),
        dy: Math.sign(Number(message.dy) || 0),
        bomb: Boolean(message.bomb),
      })
      return
    }

    case 'state': {
      // Only the host may describe the world.
      const lobby = await loadLobbyFor(connection)
      if (!lobby || lobby.hostId !== connection.playerId || lobby.status !== 'playing') return

      for (const target of connectionsFor(lobby)) {
        if (target.playerId === lobby.hostId) continue
        send(target.socket, {
          t: 'relayState',
          tick: Number(message.tick) || 0,
          payload: message.payload,
        })
      }
      return
    }

    case 'roundResult': {
      const lobby = await loadLobbyFor(connection)
      if (!lobby || lobby.hostId !== connection.playerId) return
      if (lobby.status !== 'playing') return

      const winnerId =
        typeof message.winnerId === 'string' && findPlayer(lobby, message.winnerId)
          ? message.winnerId
          : null

      const { matchWinnerId } = recordRoundResult(lobby, winnerId)
      await store.set(lobby.code, lobby)

      const view = toView(lobby)
      for (const target of connectionsFor(lobby)) {
        send(target.socket, { t: 'roundOver', winnerId, lobby: view, matchWinnerId })
      }

      // A decided match rolls back to a fresh scoreboard so the group can
      // immediately play again with the same code.
      if (matchWinnerId) {
        resetMatch(lobby)
        await store.set(lobby.code, lobby)
        broadcastLobby(lobby)
      }
      return
    }

    default: {
      sendError(socket, 'bad_request', `Unknown message type`)
    }
  }
}

async function handleDisconnect(
  connection: Connection,
  options: { immediate?: boolean } = {},
): Promise<void> {
  if (!connection.lobbyCode || !connection.playerId) return
  const lobby = await store.get(connection.lobbyCode)
  if (!lobby) return

  const player = findPlayer(lobby, connection.playerId)
  if (!player) return

  if (options.immediate) {
    removePlayer(lobby, connection.playerId)
  } else {
    // Hold the seat briefly so a refresh or flaky connection does not end a match.
    player.connected = false
    player.ready = false
    player.disconnectedAt = Date.now()
  }

  if (lobby.players.length === 0) {
    await store.delete(lobby.code)
    return
  }

  await store.set(lobby.code, lobby)
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

// Reap abandoned lobbies and expired reconnect grace periods.
const sweep = setInterval(() => {
  void (async () => {
    const now = Date.now()
    for (const lobby of await store.values()) {
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
      // lobbies out from under people who were still connected and watching the
      // code on screen — the joiner then got "no lobby with that code" for a
      // code that was, from the host's side, plainly still there. A lobby is
      // only ever reaped once nobody is connected to it.
      const occupied = lobby.players.some(p => p.connected)
      if (!occupied && (lobby.players.length === 0 || now - lobby.updatedAt > IDLE_LOBBY_TTL_MS)) {
        await store.delete(lobby.code)
        continue
      }
      if (occupied) lobby.updatedAt = now

      await store.set(lobby.code, lobby)
      if (rosterChanged) broadcastLobby(lobby)
    }
  })()
}, 15_000)

server.listen(port, () => {
  console.log(`[whatabomb] listening on :${port}`)
  console.log(`[whatabomb] serving client from ${clientDir}`)
})

function shutdown(signal: string): void {
  console.log(`[whatabomb] ${signal} received, shutting down`)
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
