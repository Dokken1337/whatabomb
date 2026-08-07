/**
 * Multi-instance lobby behaviour.
 *
 * This is the regression guard for the bug that made online play unusable: the
 * App Service plan was running several instances, each holding lobbies in its
 * own memory, so a code created on one was invisible to the others and the
 * joiner was told it did not exist.
 *
 * The compiled store and relay are exercised against one shared fake Redis,
 * standing in for two instances talking to the same cache. That keeps the test
 * hermetic; the workflow additionally runs the real server against a real Redis.
 *
 *   npm run build:server && npm run test:server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RedisLobbyStore } from '../dist-server/server/lobby-store.js'
import { createRedisRelay } from '../dist-server/server/relay.js'
import { addPlayer, createLobby } from '../dist-server/server/lobby.js'

/**
 * Minimal stand-in for the slice of node-redis the server uses.
 *
 * One instance of this is shared by both "instances", which is exactly the
 * property under test: shared state and a shared pub/sub channel.
 */
function createFakeRedis() {
  const values = new Map()
  const expiries = new Map()
  const subscribers = new Map()

  const live = key => {
    const expiresAt = expiries.get(key)
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      values.delete(key)
      expiries.delete(key)
      return false
    }
    return values.has(key)
  }

  const client = {
    async get(key) {
      return live(key) ? values.get(key) : null
    },
    async set(key, value, options = {}) {
      if (options.NX && live(key)) return null
      values.set(key, value)
      if (options.PX) expiries.set(key, Date.now() + options.PX)
      else expiries.delete(key)
      return 'OK'
    },
    async del(key) {
      const had = live(key)
      values.delete(key)
      expiries.delete(key)
      return had ? 1 : 0
    },
    async exists(key) {
      return live(key) ? 1 : 0
    },
    async scan(cursor, options = {}) {
      const prefix = (options.MATCH ?? '*').replace(/\*$/, '')
      const keys = [...values.keys()].filter(k => live(k) && k.startsWith(prefix))
      return { cursor: '0', keys }
    },
    async mGet(keys) {
      return keys.map(k => (live(k) ? values.get(k) : null))
    },
    async eval(_script, { keys, arguments: args }) {
      // Only the compare-and-delete release script is used.
      if (live(keys[0]) && values.get(keys[0]) === args[0]) {
        values.delete(keys[0])
        expiries.delete(keys[0])
        return 1
      }
      return 0
    },
    async publish(channel, message) {
      const listeners = subscribers.get(channel) ?? []
      // Redis delivers asynchronously; mirror that so the test cannot pass on
      // accidental synchronous ordering.
      for (const listener of listeners) setImmediate(() => listener(message))
      return listeners.length
    },
    async subscribe(channel, listener) {
      const listeners = subscribers.get(channel) ?? []
      listeners.push(listener)
      subscribers.set(channel, listeners)
    },
  }

  return client
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('a lobby created on one instance is readable from another', async () => {
  const redis = createFakeRedis()
  const instanceA = new RedisLobbyStore(redis)
  const instanceB = new RedisLobbyStore(redis)

  const lobby = createLobby('424242', 'HostA')
  await instanceA.set(lobby.code, lobby)

  const seenByB = await instanceB.get('424242')
  assert.ok(seenByB, 'instance B could not see the lobby instance A created')
  assert.equal(seenByB.code, '424242')
  assert.equal(seenByB.players[0].name, 'HostA')
  assert.equal(await instanceB.has('424242'), true)
})

test('a player joining on one instance is visible to the other', async () => {
  const redis = createFakeRedis()
  const instanceA = new RedisLobbyStore(redis)
  const instanceB = new RedisLobbyStore(redis)

  await instanceA.set('515151', createLobby('515151', 'HostA'))

  // The guest arrives on the other instance, as a load balancer would send them.
  await instanceB.withLock('515151', async () => {
    const lobby = await instanceB.get('515151')
    addPlayer(lobby, 'GuestB')
    await instanceB.set('515151', lobby)
  })

  const fromA = await instanceA.get('515151')
  assert.equal(fromA.players.length, 2)
  assert.deepEqual(
    fromA.players.map(p => p.name),
    ['HostA', 'GuestB'],
  )
})

test('the lock serialises simultaneous joins on different instances', async () => {
  const redis = createFakeRedis()
  const instanceA = new RedisLobbyStore(redis)
  const instanceB = new RedisLobbyStore(redis)

  await instanceA.set('616161', createLobby('616161', 'Host'))

  const join = (store, name) =>
    store.withLock('616161', async () => {
      const lobby = await store.get('616161')
      // Force the interleaving that loses a seat when unsynchronised.
      await new Promise(resolve => setTimeout(resolve, 5))
      addPlayer(lobby, name)
      await store.set('616161', lobby)
    })

  await Promise.all([join(instanceA, 'PlayerA'), join(instanceB, 'PlayerB')])

  const final = await instanceA.get('616161')
  assert.equal(final.players.length, 3, 'a concurrent join overwrote the other player')
  const names = final.players.map(p => p.name).sort()
  assert.deepEqual(names, ['Host', 'PlayerA', 'PlayerB'])
  // Slots must still be unique, or two players share a spawn corner and colour.
  const slots = final.players.map(p => p.slot)
  assert.equal(new Set(slots).size, slots.length, 'duplicate slots were handed out')
})

test('relayed messages reach players held by another instance', async () => {
  const redis = createFakeRedis()
  const deliveredToA = []
  const deliveredToB = []

  const relayA = await createRedisRelay(redis, redis, env => deliveredToA.push(env))
  const relayB = await createRedisRelay(redis, redis, env => deliveredToB.push(env))

  relayA.publish({
    code: '727272',
    to: null,
    message: { t: 'lobby', lobby: { code: '727272', players: [] } },
  })
  await tick()

  assert.equal(deliveredToB.length, 1, 'instance B never received the broadcast')
  assert.equal(deliveredToB[0].message.t, 'lobby')
  // The publisher is subscribed too, so its own players go down the same path.
  assert.equal(deliveredToA.length, 1, 'the publishing instance skipped its own players')
})

test('an addressed message is delivered to every instance for filtering', async () => {
  const redis = createFakeRedis()
  const seen = []
  await createRedisRelay(redis, redis, env => seen.push(env))

  const relay = await createRedisRelay(redis, redis, () => {})
  relay.publish({
    code: '838383',
    to: ['host-id'],
    message: { t: 'relayInput', playerId: 'guest-id', seq: 1, dx: 1, dy: 0, bomb: false },
  })
  await tick()

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].to, ['host-id'], 'the addressee list did not survive the round trip')
  assert.equal(seen[0].message.playerId, 'guest-id')
})

test('a seat claimed on one instance is evicted on the other', async () => {
  // The case this exists for: a client reconnects and the load balancer sends
  // it to a different instance from the one holding its old socket. Evicting
  // locally cannot reach that socket, so both instances kept the seat and every
  // message addressed to that player was written twice — including snapshots,
  // whose one-shot blast events then detonated the same bomb twice on screen.
  const redis = createFakeRedis()
  const seenByA = []
  const seenByB = []

  const relayA = await createRedisRelay(redis, redis, env => seenByA.push(env))
  await createRedisRelay(redis, redis, env => seenByB.push(env))

  relayA.publish({
    code: '565656',
    to: null,
    evictSeat: { playerId: 'player-1', exceptConnectionId: 'conn-new' },
  })
  await tick()

  assert.equal(seenByB.length, 1, 'the eviction never reached the other instance')
  assert.deepEqual(seenByB[0].evictSeat, { playerId: 'player-1', exceptConnectionId: 'conn-new' })
  assert.equal(seenByB[0].message, undefined, 'an eviction carries no client message')
  // And it comes back to the publisher too, which is how the local case is
  // served by the same path rather than by a second copy of the rule.
  assert.equal(seenByA.length, 1)
})

test('a malformed envelope does not take the relay down', async () => {
  const redis = createFakeRedis()
  const seen = []
  await createRedisRelay(redis, redis, env => seen.push(env))

  await redis.publish('whatabomb:relay', 'not json at all')
  await tick()
  assert.equal(seen.length, 0)

  // The relay must still be working afterwards.
  const relay = await createRedisRelay(redis, redis, () => {})
  relay.publish({ code: '949494', to: null, message: { t: 'pong', ts: 1 } })
  await tick()
  assert.equal(seen.length, 1, 'the relay stopped delivering after a bad message')
})

// ── Real two-instance run ────────────────────────────────────────────────────
// The tests above prove the pieces against a fake. This one reproduces the
// original bug end to end: two server processes, one shared Redis, a lobby
// created through one and joined through the other. Skipped unless a Redis is
// available; the workflow provides one as a service container.

import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const REDIS_URL = process.env.REDIS_URL

function startInstance(port) {
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, PORT: String(port), REDIS_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', d => process.stderr.write(`[:${port}] ${d}`))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`instance ${port} never listened`)), 20000)
    child.stdout.on('data', d => {
      if (String(d).includes('listening on')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', code => reject(new Error(`instance ${port} exited early (${code})`)))
  })
}

function open(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const inbox = []
  socket.on('message', raw => inbox.push(JSON.parse(raw.toString())))
  const ready = new Promise((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  const waitFor = async (type, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = inbox.find(m => m.t === type)
      if (hit) return hit
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for "${type}"; saw ${inbox.map(m => m.t).join(', ') || 'nothing'}`)
  }
  return { socket, inbox, ready, waitFor, send: m => socket.send(JSON.stringify(m)) }
}

test(
  'a lobby created on one instance can be joined from another',
  { skip: REDIS_URL ? false : 'set REDIS_URL to run the real two-instance test' },
  async t => {
    const [instanceA, instanceB] = await Promise.all([startInstance(8097), startInstance(8098)])
    t.after(() => {
      instanceA.kill()
      instanceB.kill()
    })

    const host = open(8097)
    const guest = open(8098)
    await Promise.all([host.ready, guest.ready])
    t.after(() => {
      host.socket.close()
      guest.socket.close()
    })

    host.send({ t: 'create', name: 'HostA' })
    const created = await host.waitFor('joined')
    const code = created.lobby.code

    // The join lands on a completely different process — this is the exact
    // request that used to come back as "no lobby with that code".
    guest.send({ t: 'join', code, name: 'GuestB' })
    const joined = await guest.waitFor('joined')
    assert.equal(joined.lobby.code, code)
    assert.equal(joined.lobby.players.length, 2)

    // And the host, on the other instance, must be told about the new player —
    // that is the relay, not just the shared store.
    const broadcast = await host.waitFor('lobby')
    assert.equal(broadcast.lobby.players.length, 2)
    assert.deepEqual(
      broadcast.lobby.players.map(p => p.name).sort(),
      ['GuestB', 'HostA'],
    )

    // Ready state set on B has to reach A as well.
    guest.send({ t: 'ready', ready: true })
    const deadline = Date.now() + 5000
    let sawReady = false
    while (Date.now() < deadline && !sawReady) {
      sawReady = host.inbox.some(
        m => m.t === 'lobby' && m.lobby.players.some(p => p.name === 'GuestB' && p.ready),
      )
      if (!sawReady) await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(sawReady, 'ready state did not cross instances')
  },
)
