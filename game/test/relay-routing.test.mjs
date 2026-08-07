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

/** Reconnect as an existing seat. `inMatch` says whether the arena survived. */
async function resumeAs(code, playerId, inMatch) {
  const client = connect(server.url)
  await client.open()
  await client.next('welcome')
  client.send({ t: 'resume', code, playerId, inMatch })
  const joined = await client.next('joined')
  return { client, joined }
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
  const [started] = await Promise.all([
    host.client.next('matchStart'),
    guestA.client.next('matchStart'),
    guestB.client.next('matchStart'),
  ])

  return { host, guestA, guestB, code, seed: started.seed }
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

test('a repeated round result is only scored once', async () => {
  // The host repeats an unacknowledged result until the round actually ends,
  // because a single dropped one would strand everybody in a finished arena.
  // That is only safe if the server ignores the repeats.
  const { host, guestA, guestB } = await startedMatch()

  host.client.send({ t: 'roundResult', winnerId: host.id })
  const first = await host.client.next('roundOver')
  assert.equal(first.winnerId, host.id)
  assert.equal(first.lobby.players.find(p => p.id === host.id).wins, 1)

  for (let i = 0; i < 3; i++) host.client.send({ t: 'roundResult', winnerId: host.id })
  assert.equal(
    await host.client.silence('roundOver', 400),
    null,
    'a result for a round that already ended is ignored, not scored again',
  )

  for (const p of [host, guestA, guestB]) p.client.close()
})

test('a match started while somebody is away leaves them out', async () => {
  const host = await joinedClient('Host')
  const code = host.lobby.code
  const guest = await joinedClient('Guest', code)
  const absent = await joinedClient('Absent', code)
  await host.client.next('lobby')

  for (const p of [host, guest, absent]) p.client.send({ t: 'ready', ready: true })
  for (let i = 0; i < 8; i++) {
    if ((await host.client.next('lobby')).lobby.canStart) break
  }

  // They drop just before the start. Their seat is held for the grace period,
  // but every start rule counts only the connected — so the match can begin
  // with a seat the server holds and no client has built a character for.
  absent.client.close()
  await host.client.next('lobby')

  host.client.send({ t: 'start' })
  const started = await host.client.next('matchStart')

  assert.equal(started.lobby.players.length, 2, 'the held seat is freed rather than orphaned')
  assert.ok(
    !started.lobby.players.some(p => p.id === absent.id),
    'nobody is seated in a match no client has a character for',
  )

  host.client.close()
  guest.client.close()
})

test('a guest that reloads mid-round is handed the match again', async () => {
  const { host, guestA, guestB, code, seed } = await startedMatch()

  // A reload looks exactly like a dropped socket from the server's side. The
  // difference is that this client no longer has an arena, so its seat alone
  // is no use to it — without the seed it cannot rebuild the board everyone
  // else is standing on, and it would sit in the lobby until the round ended.
  guestA.client.close()
  await host.client.next('lobby')

  const returned = await resumeAs(code, guestA.id, false)
  assert.equal(returned.joined.youId, guestA.id)

  const restart = await returned.client.next('matchStart')
  assert.equal(restart.seed, seed, 'the same arena everyone else is playing in')
  assert.equal(restart.hostId, host.id, 'and it knows who is simulating')

  // The round carries on for everyone — this is a rejoin, not a restart.
  assert.equal(await host.client.silence('roundOver'), null)
  host.client.send({ t: 'state', tick: 11, payload: {} })
  assert.equal((await returned.client.next('relayState')).tick, 11)

  returned.client.close()
  host.client.close()
  guestB.client.close()
})

test('a blip is resumed without rebuilding the arena', async () => {
  const { host, guestA, guestB, code } = await startedMatch()

  guestA.client.close()
  await host.client.next('lobby')

  // This client still has its arena, so handing it the match again would tear
  // down a perfectly good one and restart it from the spawn positions.
  const returned = await resumeAs(code, guestA.id, true)
  assert.equal(
    await returned.client.silence('matchStart'),
    null,
    'a client that kept its world is left to carry on with it',
  )

  returned.client.close()
  host.client.close()
  guestB.client.close()
})

test('a host that reloads mid-round ends it rather than stranding everyone', async () => {
  const { host, guestA, guestB, code } = await startedMatch()

  host.client.close()
  await guestA.client.next('lobby')

  // The host is the only client holding the world. Coming back without it,
  // there is nothing to resume: nobody else ever had the fuses or the bomb
  // ownership. Left alone, the seat looks healthy and every guest waits on a
  // simulation that no longer exists.
  const returned = await resumeAs(code, host.id, false)

  const [overA, overB] = await Promise.all([
    guestA.client.next('roundOver'),
    guestB.client.next('roundOver'),
  ])
  assert.equal(overA.winnerId, null, 'the round is replayed, not awarded')
  assert.equal(overA.lobby.status, 'waiting')
  assert.equal(overB.lobby.status, 'waiting')
  assert.equal(
    returned.joined.lobby.players.length, 3,
    'and nobody loses their seat over it',
  )

  returned.client.close()
  guestA.client.close()
  guestB.client.close()
})

test('losing the host ends the round instead of hanging it', async () => {
  const { host, guestA, guestB } = await startedMatch()

  // The host is the only client simulating. If it goes and nobody says so, the
  // other two sit in an arena that has stopped, with no way out but a reload:
  // nothing inside a running match can end a round on its own.
  host.client.send({ t: 'leave' })

  const [overA, overB] = await Promise.all([
    guestA.client.next('roundOver'),
    guestB.client.next('roundOver'),
  ])
  assert.equal(overA.winnerId, null, 'an abandoned round is replayed, not awarded')
  assert.equal(overA.matchWinnerId, null)
  assert.equal(overA.lobby.status, 'waiting', 'and everyone lands back in the lobby')
  assert.equal(overB.winnerId, null)
  assert.ok(
    overA.lobby.players.some(p => p.isHost),
    'somebody is promoted so the next round can be started',
  )

  guestA.client.close()
  guestB.client.close()
})

test('dropping below two players ends the round', async () => {
  const host = await joinedClient('Host')
  const guest = await joinedClient('Guest', host.lobby.code)
  await host.client.next('lobby')
  for (const p of [host, guest]) p.client.send({ t: 'ready', ready: true })
  for (let i = 0; i < 6; i++) {
    if ((await host.client.next('lobby')).lobby.canStart) break
  }
  host.client.send({ t: 'start' })
  await Promise.all([host.client.next('matchStart'), guest.client.next('matchStart')])

  guest.client.send({ t: 'leave' })

  const over = await host.client.next('roundOver')
  assert.equal(over.winnerId, null)
  assert.equal(over.lobby.status, 'waiting')

  host.client.close()
  guest.client.close()
})

test('a round survives a guest leaving when enough players remain', async () => {
  const { host, guestA, guestB } = await startedMatch()

  guestB.client.send({ t: 'leave' })
  const view = (await host.client.next('lobby')).lobby
  assert.equal(view.players.length, 2)
  assert.equal(view.status, 'playing', 'two players is still a match')

  // And gameplay traffic keeps flowing to whoever is left.
  host.client.send({ t: 'state', tick: 42, payload: {} })
  const relayed = await guestA.client.next('relayState')
  assert.equal(relayed.tick, 42)

  host.client.close()
  guestA.client.close()
  guestB.client.close()
})

test('reclaiming a seat closes the socket that held it', async () => {
  const { host, guestA, guestB, code } = await startedMatch()

  // The old socket is still open — this is a client that reconnected before
  // the heartbeat noticed the first one had gone. Both would hold the seat.
  const closed = new Promise(resolve => guestA.client.socket.once('close', resolve))

  const returning = connect(server.url)
  await returning.open()
  await returning.next('welcome')
  returning.send({ t: 'resume', code, playerId: guestA.id })
  await returning.next('joined')

  await closed

  // Exactly one delivery, to the new socket.
  host.client.send({ t: 'state', tick: 7, payload: {} })
  const first = await returning.next('relayState')
  assert.equal(first.tick, 7)
  assert.equal(await returning.silence('relayState'), null, 'not delivered twice')

  returning.close()
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
