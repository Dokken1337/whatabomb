/**
 * Integration test for the lobby rules, run against the real compiled server
 * over real WebSockets.
 *
 *   npm run build:server && npm run test:server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const PORT = 8099
const URL = `ws://127.0.0.1:${PORT}/ws`

let serverProcess

before(async () => {
  serverProcess = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  // Wait for the listen line before connecting.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000)
    serverProcess.stdout.on('data', chunk => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
})

after(() => {
  serverProcess?.kill()
})

/** A socket wrapper that queues messages so tests can await them by type. */
function connect() {
  const socket = new WebSocket(URL)
  const queue = []
  const waiters = []

  socket.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    const waiterIndex = waiters.findIndex(w => w.type === msg.t)
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    } else {
      queue.push(msg)
    }
  })

  return {
    socket,
    open: () => new Promise(res => socket.once('open', res)),
    send: msg => socket.send(JSON.stringify(msg)),
    /** Resolve with the next message of `type`, checking already-queued ones. */
    next(type, timeoutMs = 5000) {
      const queued = queue.findIndex(m => m.t === type)
      if (queued !== -1) return Promise.resolve(queue.splice(queued, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${type}"`)),
          timeoutMs,
        )
        waiters.push({ type, resolve, timer })
      })
    },
    close: () => socket.close(),
  }
}

async function joinedClient(name, code) {
  const client = connect()
  await client.open()
  await client.next('welcome')
  client.send(code ? { t: 'join', code, name } : { t: 'create', name })
  const joined = await client.next('joined')
  return { client, joined }
}

test('host creates a lobby and gets a 6 digit code', async () => {
  const { client, joined } = await joinedClient('Host')
  assert.match(joined.lobby.code, /^\d{6}$/)
  assert.equal(joined.lobby.players.length, 1)
  assert.equal(joined.lobby.players[0].isHost, true)
  assert.equal(joined.lobby.config.rounds, 3, 'defaults to best of 3')
  assert.equal(joined.lobby.config.lives, 3, 'defaults to 3 lives')
  client.close()
})

test('a lone host cannot start', async () => {
  const { client, joined } = await joinedClient('Host')
  assert.equal(joined.lobby.canStart, false)
  assert.match(joined.lobby.startBlockedReason, /1 more player/)
  client.close()
})

test('joining with an unknown code is rejected', async () => {
  const client = connect()
  await client.open()
  await client.next('welcome')
  client.send({ t: 'join', code: '000000', name: 'Nobody' })
  const err = await client.next('error')
  assert.equal(err.code, 'lobby_not_found')
  client.close()
})

test('names are clamped to 8 characters', async () => {
  const { client, joined } = await joinedClient('WayTooLongName')
  assert.equal(joined.lobby.players[0].name, 'WayTooLo')
  client.close()
})

test('two players ready up and the host starts the match', async () => {
  const host = await joinedClient('Host')
  const code = host.joined.lobby.code
  const guest = await joinedClient('Guest', code)

  // Host is told about the join.
  const afterJoin = await host.client.next('lobby')
  assert.equal(afterJoin.lobby.players.length, 2)
  assert.equal(afterJoin.lobby.canStart, false, 'nobody is ready yet')

  host.client.send({ t: 'ready', ready: true })
  await host.client.next('lobby')
  guest.client.send({ t: 'ready', ready: true })

  let view
  for (let i = 0; i < 4; i++) {
    view = (await host.client.next('lobby')).lobby
    if (view.canStart) break
  }
  assert.equal(view.canStart, true, 'both ready should unblock start')
  assert.equal(view.startBlockedReason, null)

  host.client.send({ t: 'start' })
  const hostStart = await host.client.next('matchStart')
  const guestStart = await guest.client.next('matchStart')

  assert.equal(hostStart.seed, guestStart.seed, 'both clients must build the same arena')
  assert.equal(hostStart.round, 1)
  assert.equal(hostStart.hostId, host.joined.youId)

  host.client.close()
  guest.client.close()
})

test('a guest cannot start the match', async () => {
  const host = await joinedClient('Host')
  const code = host.joined.lobby.code
  const guest = await joinedClient('Guest', code)

  host.client.send({ t: 'ready', ready: true })
  guest.client.send({ t: 'ready', ready: true })
  await guest.client.next('lobby')

  guest.client.send({ t: 'start' })
  const err = await guest.client.next('error')
  assert.equal(err.code, 'not_host')

  host.client.close()
  guest.client.close()
})

test('a fifth player is refused', async () => {
  const host = await joinedClient('P1')
  const code = host.joined.lobby.code
  const others = []
  for (const name of ['P2', 'P3', 'P4']) {
    others.push(await joinedClient(name, code))
  }

  const fifth = connect()
  await fifth.open()
  await fifth.next('welcome')
  fifth.send({ t: 'join', code, name: 'P5' })
  const err = await fifth.next('error')
  assert.equal(err.code, 'lobby_full')
  assert.match(err.message, /4 players/)

  fifth.close()
  host.client.close()
  for (const o of others) o.client.close()
})

test('round wins accumulate and decide a best of three', async () => {
  const host = await joinedClient('Host')
  const code = host.joined.lobby.code
  const guest = await joinedClient('Guest', code)
  const hostId = host.joined.youId

  const playRound = async () => {
    host.client.send({ t: 'ready', ready: true })
    guest.client.send({ t: 'ready', ready: true })
    let view
    for (let i = 0; i < 6; i++) {
      view = (await host.client.next('lobby')).lobby
      if (view.canStart) break
    }
    assert.equal(view.canStart, true)
    host.client.send({ t: 'start' })
    await host.client.next('matchStart')
    await guest.client.next('matchStart')
    host.client.send({ t: 'roundResult', winnerId: hostId })
    return host.client.next('roundOver')
  }

  const first = await playRound()
  assert.equal(first.matchWinnerId, null, 'one win is not a best of three')
  assert.equal(first.lobby.players.find(p => p.id === hostId).wins, 1)
  assert.equal(first.lobby.round, 2, 'advances to the next round')

  const second = await playRound()
  assert.equal(second.matchWinnerId, hostId, 'two wins takes best of three')

  host.client.close()
  guest.client.close()
})

test('leaving hands the host role to the next player', async () => {
  const host = await joinedClient('Host')
  const code = host.joined.lobby.code
  const guest = await joinedClient('Guest', code)
  // The join is broadcast to everyone seated, including the joiner, so drain
  // both queues before asserting on what the leave produces.
  await host.client.next('lobby')
  await guest.client.next('lobby')

  host.client.send({ t: 'leave' })
  const view = (await guest.client.next('lobby')).lobby
  assert.equal(view.players.length, 1)
  assert.equal(view.players[0].isHost, true, 'remaining player is promoted')
  assert.equal(view.players[0].name, 'Guest')

  host.client.close()
  guest.client.close()
})
