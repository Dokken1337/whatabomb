/**
 * Who hears what during a match, against the real server over real sockets.
 *
 *   npm run build:server && npm run test:server
 *
 * Gameplay traffic takes a different path through the server from everything
 * else: it is answered synchronously off a cached roster rather than through
 * the async lobby handlers, and it is addressed to particular players rather
 * than broadcast. Both of those are easy to get subtly wrong in a way that
 * still looks like a working game — a snapshot echoed back to its own author
 * costs bandwidth and nothing else, and an input delivered to the wrong player
 * is invisible until two people are moving at once.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, connect } from './harness.mjs'

const PORT = 8098
let server

before(async () => {
  server = await startServer(PORT)
})

after(() => {
  server?.stop()
})

async function joinedClient(name, code) {
  const client = connect(server.url)
  await client.open()
  await client.next('welcome')
  client.send(code ? { t: 'join', code, name } : { t: 'create', name })
  const joined = await client.next('joined')
  return { client, id: joined.youId, lobby: joined.lobby }
}

/** A started three-player match: one host, two guests. */
async function startedMatch() {
  const host = await joinedClient('Host')
  const code = host.lobby.code
  const guestA = await joinedClient('GuestA', code)
  const guestB = await joinedClient('GuestB', code)

  for (const player of [host, guestA, guestB]) {
    player.client.send({ t: 'ready', ready: true })
  }

  // Ready flags land as a series of lobby broadcasts; wait for the one that
  // says everyone is in rather than counting them.
  for (let attempt = 0; attempt < 8; attempt++) {
    const view = (await host.client.next('lobby')).lobby
    if (view.canStart) break
  }

  host.client.send({ t: 'start' })
  await Promise.all([
    host.client.next('matchStart'),
    guestA.client.next('matchStart'),
    guestB.client.next('matchStart'),
  ])

  return { host, guestA, guestB, code }
}

test('a guest input reaches the host and nobody else', async () => {
  const { host, guestA, guestB } = await startedMatch()

  guestA.client.send({ t: 'input', seq: 1, dx: 0, dy: 1, bomb: false, at: 12_345, ackTick: 0 })

  const relayed = await host.client.next('relayInput')
  assert.equal(relayed.playerId, guestA.id)
  assert.equal(relayed.seq, 1)
  assert.equal(relayed.dy, 1)
  assert.equal(relayed.at, 12_345, 'the sender clock is passed through untouched')

  assert.equal(
    await guestB.client.silence('relayInput'),
    null,
    'guests must not be told about each other s keypresses — only the host simulates',
  )
  assert.equal(await guestA.client.silence('relayInput'), null, 'nor echoed to the sender')

  for (const p of [host, guestA, guestB]) p.client.close()
})

test('a host snapshot reaches every guest and is not echoed back', async () => {
  const { host, guestA, guestB } = await startedMatch()

  host.client.send({ t: 'state', tick: 999, payload: { players: [], bombs: [] } })

  const [toA, toB] = await Promise.all([
    guestA.client.next('relayState'),
    guestB.client.next('relayState'),
  ])
  assert.equal(toA.tick, 999)
  assert.equal(toB.tick, 999)
  assert.deepEqual(toA.payload, { players: [], bombs: [] }, 'payload is relayed verbatim')

  assert.equal(
    await host.client.silence('relayState'),
    null,
    'the host already knows what it just sent',
  )

  for (const p of [host, guestA, guestB]) p.client.close()
})

test('a guest cannot describe the world', async () => {
  const { host, guestA, guestB } = await startedMatch()

  guestA.client.send({ t: 'state', tick: 1, payload: { cheated: true } })

  assert.equal(await guestB.client.silence('relayState'), null)
  assert.equal(await host.client.silence('relayState'), null)

  for (const p of [host, guestA, guestB]) p.client.close()
})

test('gameplay traffic before the match starts goes nowhere', async () => {
  const host = await joinedClient('Host')
  const guest = await joinedClient('Guest', host.lobby.code)
  await host.client.next('lobby')

  guest.client.send({ t: 'input', seq: 1, dx: 1, dy: 0, bomb: false, at: 1, ackTick: 0 })
  host.client.send({ t: 'state', tick: 1, payload: {} })

  assert.equal(await host.client.silence('relayInput'), null)
  assert.equal(await guest.client.silence('relayState'), null)

  host.client.close()
  guest.client.close()
})

test('a dropped socket holds its seat and the rest are told', async () => {
  const { host, guestA, guestB } = await startedMatch()

  guestA.client.close()

  const view = (await host.client.next('lobby')).lobby
  const seat = view.players.find(p => p.id === guestA.id)
  assert.ok(seat, 'the seat is held rather than vacated, so a reconnect can reclaim it')
  assert.equal(seat.connected, false, 'and is reported as absent so the host stops moving them')
  assert.equal(view.players.length, 3)

  host.client.close()
  guestB.client.close()
})

test('a returning player reclaims the seat and its traffic follows', async () => {
  const { host, guestA, guestB, code } = await startedMatch()

  guestA.client.close()
  await host.client.next('lobby')

  const returned = connect(server.url)
  await returned.open()
  await returned.next('welcome')
  returned.send({ t: 'resume', code, playerId: guestA.id })
  const rejoined = await returned.next('joined')
  assert.equal(rejoined.youId, guestA.id, 'same seat, not a new one')
  assert.equal(
    rejoined.lobby.players.find(p => p.id === guestA.id).connected,
    true,
  )

  // The point of reclaiming the seat: the new socket is wired up in its place.
  returned.send({ t: 'input', seq: 7, dx: -1, dy: 0, bomb: false, at: 999, ackTick: 0 })
  const relayed = await host.client.next('relayInput')
  assert.equal(relayed.playerId, guestA.id)
  assert.equal(relayed.seq, 7)

  returned.close()
  host.client.close()
  guestB.client.close()
})

test('a lobby a player has left stops delivering to them', async () => {
  const { host, guestA, guestB } = await startedMatch()

  guestA.client.send({ t: 'leave' })
  await host.client.next('lobby')

  host.client.send({ t: 'state', tick: 5, payload: {} })
  await guestB.client.next('relayState')
  assert.equal(
    await guestA.client.silence('relayState'),
    null,
    'leaving must take the socket out of the lobby, not just the roster',
  )

  for (const p of [host, guestA, guestB]) p.client.close()
})
