/**
 * A whole online match, simulated headlessly.
 *
 *   npm run build:server && npm run test:server
 *
 * Two ends, a wire with latency between them, and a virtual clock. This models
 * what main.ts actually does — a guest predicting on its tick and reconciling
 * by replay, a host folding inputs in as they arrive and simulating on its own
 * tick — using the same movement primitives both really use.
 *
 * The point is to catch disagreement deterministically. Driving two browser
 * tabs by hand cannot: their timers throttle, their frames drop, and every
 * measurement window lands somewhere slightly different. Here the clock is a
 * number and every run is identical.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accrue,
  isDue,
  settle,
  run,
  replay,
} from '../dist-server/shared/movement.js'

const TICK = 33
const SNAPSHOT_EVERY = 66

/** An arena with a wall down one side, so "blocked" is exercised too. */
const openWorld = () => (x, y) => x >= 0 && x < 12 && y >= 0 && y < 12

// ── The host ────────────────────────────────────────────────────────────────

function newHost(x, y, delay) {
  return {
    x, y, credit: delay, delay,
    input: { dx: 0, dy: 0 },
    lastInputAt: null,
    creditedSinceInput: 0,
    inputSeq: -1,
  }
}

/** main.ts settleHeldDirection + beginHeldDirection, on an arriving input. */
function hostAcceptInput(h, msg, canWalk) {
  if (msg.seq <= h.inputSeq) return
  h.inputSeq = msg.seq

  const previous = h.lastInputAt
  const credited = h.creditedSinceInput
  h.creditedSinceInput = 0

  if (Number.isFinite(msg.at) && msg.at > 0) {
    h.lastInputAt = msg.at
    const { dx, dy } = h.input // the direction being released
    if (previous === null || (dx === 0 && dy === 0)) {
      h.credit = Math.min(h.credit, h.delay)
    } else {
      const owed = Math.min(Math.max(msg.at - previous, 0), 1000)
      h.credit += owed - credited
      for (let taken = 0; taken < 2 && h.credit >= h.delay; taken++) {
        if (!canWalk(h.x + dx, h.y + dy)) { h.credit = settle(h.credit, h.delay, false); break }
        h.x += dx; h.y += dy
        h.credit = settle(h.credit, h.delay, true)
      }
      // Give back steps that were never earned. While a release is in flight
      // the host keeps applying the direction, so it can overshoot; negative
      // credit is exactly "I spent more than I was owed", one step per delay.
      for (let given = 0; given < 2 && h.credit < 0; given++) {
        if (!canWalk(h.x - dx, h.y - dy)) { h.credit = 0; break }
        h.x -= dx; h.y -= dy
        h.credit += h.delay
      }
      if (h.credit < 0) h.credit = 0
    }
  }

  h.input = { dx: msg.dx, dy: msg.dy }

  // beginHeldDirection: spend what a fresh press has already earned.
  const { dx, dy } = h.input
  if (dx !== 0 || dy !== 0) {
    if (h.credit >= h.delay) {
      if (canWalk(h.x + dx, h.y + dy)) {
        h.x += dx; h.y += dy
        h.credit = settle(h.credit, h.delay, true)
      } else {
        h.credit = settle(h.credit, h.delay, false)
      }
    }
  }
}

/** main.ts stepNetPlayer, one tick. */
function hostTick(h, stepMs, canWalk) {
  const { dx, dy } = h.input
  const holding = dx !== 0 || dy !== 0
  h.credit = accrue(h.credit, stepMs, h.delay, holding)
  if (!holding) return
  h.creditedSinceInput += stepMs
  if (!isDue(h.credit, h.delay)) return
  if (canWalk(h.x + dx, h.y + dy)) {
    h.x += dx; h.y += dy
    h.credit = settle(h.credit, h.delay, true)
  } else {
    h.credit = settle(h.credit, h.delay, false)
  }
}

const hostSnapshot = h => ({
  x: h.x, y: h.y, credit: h.credit,
  ackSeq: h.inputSeq,
  simAt: (h.lastInputAt ?? 0) + h.creditedSinceInput,
})

// ── The guest ───────────────────────────────────────────────────────────────

function newGuest(x, y, delay) {
  return {
    x, y, credit: delay, delay, sent: [], seq: 0, lastSignature: null,
    auth: { x, y, credit: delay },
    simAt: 0,
    // No authoritative ground to stand on: set while a reconnect is pending, so
    // nothing is derived until the host says something again.
    blind: false,
  }
}

/** publishLocalInput: send only on change, stamped on our own clock. */
function guestPublish(g, input, now) {
  const signature = `${input.dx},${input.dy}`
  if (signature === g.lastSignature) return null
  g.lastSignature = signature
  const msg = { seq: ++g.seq, dx: input.dx, dy: input.dy, at: input.since ?? now }
  g.sent.push(msg)
  return msg
}

/**
 * Where the guest is, derived rather than accumulated.
 *
 * Stepping a local clock forward in tick-sized lumps and *also* re-deriving
 * from the host gave two answers for the same question: a tick grants a whole
 * 33ms even when the key was only held for 27 of them, while the host is told
 * the exact duration. Deriving both ways from the same inputs removes the
 * disagreement by removing the second answer.
 */
function guestDerive(g, now, canWalk) {
  if (g.blind) return
  const d = replay(g.auth, g.delay, g.sent, g.simAt, now, canWalk)
  g.x = d.x; g.y = d.y; g.credit = d.credit
}

/** reconcileLocal: re-derive from the authoritative state. */
function guestReconcile(g, snap, now, canWalk) {
  while (g.sent.length > 1 && g.sent[0].seq < snap.ackSeq) g.sent.shift()
  g.auth = { x: snap.x, y: snap.y, credit: snap.credit }
  g.simAt = snap.simAt
  g.blind = false
  guestDerive(g, now, canWalk)
}

/**
 * The scene's onState handler: throw away everything predicted across a gap.
 *
 * The inputs still in the buffer are stamped from before the outage, and the
 * host — told by the server that this player had gone — stopped simulating
 * them at the moment they left. Replaying the buffer against whatever it says
 * next would therefore charge the whole outage to a direction that has been
 * held throughout, and spend it walking.
 */
function guestResumed(g) {
  g.sent.length = 0
  g.blind = true
  g.lastSignature = null
}

// ── The wire ────────────────────────────────────────────────────────────────

/**
 * Run a scripted match and report what each end believed, moment by moment.
 *
 * `script` is a list of [holdMs, dx, dy]; a zero direction is a pause.
 */
function playMatch({
  script,
  oneWay = 80,
  delay = 150,
  canWalk = openWorld(),
  /** `{ from, until }` in ms from the start: the guest's socket is down. */
  outage = null,
  /** Whether the guest discards its prediction on coming back. */
  recoverPrediction = true,
}) {
  const h = newHost(5, 5, delay)
  const g = newGuest(5, 5, delay)

  const toHost = []
  const toGuest = []
  const timeline = []

  // A real clock is never zero at match start: performance.now() is already
  // thousands of milliseconds in. Starting from zero would have inputs stamped
  // `at: 0`, which the host rightly rejects — that is the value the relay uses
  // for a missing field.
  const T0 = 10_000
  const phases = []
  let cursor = T0
  for (const [ms, dx, dy] of script) {
    phases.push({ from: cursor, until: cursor + ms, dx, dy })
    cursor += ms
  }
  const heldAt = t => {
    const p = phases.find(p => t >= p.from && t < p.until)
    // `since` is when this direction actually began — what a key handler knows
    // and a poll does not.
    return p ? { dx: p.dx, dy: p.dy, since: p.from } : { dx: 0, dy: 0, since: cursor }
  }
  const total = cursor + 1500 // let everything settle

  const outageFrom = outage ? T0 + outage.from : Infinity
  const outageUntil = outage ? T0 + outage.until : -Infinity
  let wasDown = false

  let lastSnapshotAt = T0
  for (let t = T0; t <= total; t += TICK) {
    const down = t >= outageFrom && t < outageUntil
    if (down && !wasDown) {
      // The server tells the host this player has gone, and the host stops
      // simulating them — otherwise a held direction walks a disconnected
      // character across the arena for the whole outage. See the scene's
      // onLobby handler.
      h.input = { dx: 0, dy: 0 }
      h.creditedSinceInput = 0
    }
    if (!down && wasDown && recoverPrediction) guestResumed(g)
    wasDown = down

    // Guest tick: publish on change, then predict.
    const held = heldAt(t)
    const msg = guestPublish(g, held, t)
    if (msg && !down) toHost.push({ at: t + oneWay, msg })
    guestDerive(g, t, canWalk)

    // Host tick: take delivered input, then simulate, then maybe report.
    while (toHost.length && toHost[0].at <= t) hostAcceptInput(h, toHost.shift().msg, canWalk)
    hostTick(h, TICK, canWalk)
    if (t - lastSnapshotAt >= SNAPSHOT_EVERY) {
      lastSnapshotAt = t
      if (!down) toGuest.push({ at: t + oneWay, snap: hostSnapshot(h) })
    }

    // Guest applies whatever has arrived.
    while (toGuest.length && toGuest[0].at <= t) {
      guestReconcile(g, toGuest.shift().snap, t, canWalk)
    }

    timeline.push({ t, held, guest: [g.x, g.y], host: [h.x, h.y] })
  }
  return { host: h, guest: g, timeline }
}

/** The largest single-frame jump the guest made, in tiles. */
function largestJump(timeline) {
  let worst = 0
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i]
    const jump = Math.abs(b.guest[0] - a.guest[0]) + Math.abs(b.guest[1] - a.guest[1])
    if (jump > worst) worst = jump
  }
  return worst
}

/**
 * Moves the guest made with nobody driving it.
 *
 * Both ends of the interval must be idle. A step that lands just after the key
 * came up was still *earned* while it was down — crediting the exact hold
 * duration means the last step of a run can surface a fraction of a tick late,
 * and that is correct, not phantom.
 */
function phantomMoves(timeline) {
  const out = []
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i]
    const moved = a.guest[0] !== b.guest[0] || a.guest[1] !== b.guest[1]
    const idleThroughout =
      a.held.dx === 0 && a.held.dy === 0 && b.held.dx === 0 && b.held.dy === 0
    if (moved && idleThroughout) out.push({ t: b.t, from: a.guest, to: b.guest })
  }
  return out
}

/** Guest moves that go against the direction actually being held. */
function backwardMoves(timeline) {
  const sign = n => (n > 0 ? 1 : n < 0 ? -1 : 0)
  const out = []
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1], b = timeline[i]
    const mx = b.guest[0] - a.guest[0], my = b.guest[1] - a.guest[1]
    if (mx === 0 && my === 0) continue
    const { dx, dy } = b.held
    if (dx === 0 && dy === 0) continue
    if ((dx && sign(mx) === -sign(dx)) || (dy && sign(my) === -sign(dy))) {
      out.push({ t: b.t, from: a.guest, to: b.guest, held: [dx, dy] })
    }
  }
  return out
}

// ── The tests ───────────────────────────────────────────────────────────────

test('a steady run leaves both ends on the same tile', () => {
  const { host, guest } = playMatch({ script: [[900, 0, 1]] })
  assert.deepEqual([guest.x, guest.y], [host.x, host.y])
})

test('a guest never moves while nothing is held', () => {
  const { timeline } = playMatch({
    script: [[600, 0, 1], [500, 0, 0], [600, 1, 0], [500, 0, 0]],
  })
  const phantom = phantomMoves(timeline)
  assert.deepEqual(phantom, [], `moved with nothing held: ${JSON.stringify(phantom)}`)
})

test('a guest is never pushed against the direction it is holding', () => {
  const { timeline } = playMatch({
    script: [[600, 0, 1], [400, 0, 0], [600, 0, -1], [400, 0, 0], [600, 1, 0]],
  })
  const backward = backwardMoves(timeline)
  assert.deepEqual(backward, [], `pushed backwards: ${JSON.stringify(backward)}`)
})

test('doubling back repeatedly still converges', () => {
  const script = []
  for (let i = 0; i < 6; i++) {
    script.push([420, 0, 1], [260, 0, 0], [420, 0, -1], [260, 0, 0])
  }
  const { host, guest, timeline } = playMatch({ script })
  assert.deepEqual([guest.x, guest.y], [host.x, host.y])
  assert.deepEqual(phantomMoves(timeline), [])
  assert.deepEqual(backwardMoves(timeline), [])
})

test('short taps agree at every latency', () => {
  for (const oneWay of [10, 40, 80, 150, 250]) {
    const { host, guest, timeline } = playMatch({
      script: [[70, 0, 1], [300, 0, 0], [90, 1, 0], [300, 0, 0], [60, 0, -1], [400, 0, 0]],
      oneWay,
    })
    assert.deepEqual(
      [guest.x, guest.y], [host.x, host.y],
      `ends disagree at one-way ${oneWay}ms: guest ${guest.x},${guest.y} host ${host.x},${host.y}`,
    )
    assert.deepEqual(phantomMoves(timeline), [], `phantom at one-way ${oneWay}ms`)
  }
})

test('speed does not break agreement', () => {
  for (const delay of [150, 135, 120, 105, 90]) {
    const { host, guest, timeline } = playMatch({
      script: [[500, 0, 1], [300, 0, 0], [500, 0, -1], [400, 0, 0]],
      delay,
      oneWay: 120,
    })
    assert.deepEqual(
      [guest.x, guest.y], [host.x, host.y],
      `ends disagree at ${delay}ms per tile`,
    )
    assert.deepEqual(phantomMoves(timeline), [], `phantom at ${delay}ms per tile`)
  }
})

/**
 * A four-second drop in the middle of a long hold — the worst shape for this,
 * because both ends have every reason to believe the player is still walking
 * and neither is told otherwise until it is over.
 */
const acrossADrop = {
  script: [[600, 0, 1], [4000, 0, 1], [600, 0, 1], [600, 0, 0]],
  outage: { from: 600, until: 4600 },
}

test('a reconnecting guest does not walk the outage off', () => {
  const { host, guest, timeline } = playMatch(acrossADrop)

  assert.deepEqual(
    [guest.x, guest.y], [host.x, host.y],
    `ends disagree after a reconnect: guest ${guest.x},${guest.y} host ${host.x},${host.y}`,
  )
  assert.ok(
    largestJump(timeline) <= 1,
    `the guest jumped ${largestJump(timeline)} tiles at once; coming back should ` +
      `resume from where the host says, not replay the whole gap`,
  )
})

test('keeping the pre-drop prediction is what would teleport them', () => {
  // The same match with the recovery left out, to show the reset is carrying
  // real weight rather than being belt and braces. Without it the buffer still
  // holds an input stamped before the outage, and the first snapshot back
  // charges the entire gap to it.
  const { timeline } = playMatch({ ...acrossADrop, recoverPrediction: false })
  assert.ok(
    largestJump(timeline) > 1,
    'expected the unfixed path to jump, so this test still proves something',
  )
})

test('a wall the guest can also see does not cause disagreement', () => {
  // Everything past y=7 is solid; both ends know it.
  const canWalk = (x, y) => x >= 0 && x < 12 && y >= 0 && y <= 7
  const { host, guest, timeline } = playMatch({
    script: [[1200, 0, 1], [400, 0, 0]],
    canWalk,
  })
  assert.deepEqual([guest.x, guest.y], [host.x, host.y])
  assert.deepEqual(backwardMoves(timeline), [])
})
