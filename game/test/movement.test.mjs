/**
 * The movement clock and replay reconciliation.
 *
 *   npm run build:server && npm run test:server
 *
 * These are the rules that have to produce identical results on two different
 * machines. Every online movement bug in this game so far has been one copy of
 * them disagreeing with another, and each one cost a long session of driving
 * two browser tabs by hand to find. They are unit tests now.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accrue,
  isDue,
  settle,
  run,
  replay,
  moveDelayForSpeed,
  appendWaypoints,
  sampleAt,
  pruneWaypoints,
} from '../dist-server/shared/movement.js'

const OPEN = () => true
const at = (x, y, credit = 0) => ({ x, y, credit })

/** Walk a state forward in fixed ticks, the way a simulation loop does. */
function tick(state, input, totalMs, sliceMs, delay, canWalk = OPEN) {
  let s = state
  let left = totalMs
  while (left > 0) {
    const slice = Math.min(sliceMs, left)
    s = run(s, input, slice, delay, canWalk)
    left -= slice
  }
  return s
}

test('a held direction steps at the rate the delay asks for', () => {
  // 600ms at 150ms per tile, starting with a full bank: the press itself plus
  // four more.
  const end = tick(at(0, 0, 150), { dx: 1, dy: 0 }, 600, 33, 150)
  assert.equal(end.x, 5)
})

test('chunk size does not change where a player ends up', () => {
  // The property replay depends on: 900ms is 900ms however it is sliced.
  const input = { dx: 1, dy: 0 }
  const oneChunk = run(at(0, 0, 0), input, 900, 150, OPEN)
  const manySlices = tick(at(0, 0, 0), input, 900, 17, 150)
  const uneven = [7, 40, 13, 200, 91, 149, 400].reduce(
    (s, ms) => run(s, input, ms, 150, OPEN),
    at(0, 0, 0),
  )
  assert.equal(oneChunk.x, manySlices.x)
  assert.equal(oneChunk.x, uneven.x)
  assert.equal(oneChunk.credit, manySlices.credit)
})

test('standing still banks at most one step', () => {
  // Ten seconds idle must not buy ten seconds of sprinting.
  const idle = tick(at(0, 0, 0), { dx: 0, dy: 0 }, 10_000, 33, 150)
  assert.equal(idle.credit, 150)
  const afterPress = run(idle, { dx: 1, dy: 0 }, 0, 150, OPEN)
  assert.equal(afterPress.x, 1, 'the banked step is spent')
  assert.equal(afterPress.credit, 0, 'and nothing is left over')
})

test('a refused step banks no time', () => {
  const wall = () => false
  const blocked = tick(at(0, 0, 0), { dx: 1, dy: 0 }, 3000, 33, 150, wall)
  assert.equal(blocked.x, 0)
  assert.equal(blocked.credit, 150, 'held at the ready, not hoarded')
  // Turning away must not cash in the three seconds spent pushing at the wall.
  const away = run(blocked, { dx: 0, dy: 1 }, 0, 150, OPEN)
  assert.equal(away.y, 1)
  assert.equal(away.credit, 0)
})

test('a non-finite elapsed time cannot poison the clock', () => {
  // This one froze a player for a whole match: one NaN in the credit makes
  // every later comparison false, so they never take another step.
  for (const bad of [NaN, undefined, Infinity, null]) {
    const s = run(at(0, 0, 0), { dx: 1, dy: 0 }, bad, 150, OPEN)
    assert.ok(Number.isFinite(s.credit), `credit stayed finite for ${bad}`)
    assert.ok(isDue(accrue(s.credit, 150, 150, true), 150), 'still able to move')
  }
})

test('two ends ticking out of phase agree on a short tap', () => {
  // The host ticks on its own timer and a guest on its own; a tap far shorter
  // than two steps used to land one tile apart depending on where each tick
  // happened to fall.
  const input = { dx: 1, dy: 0 }
  const tap = 70
  const host = tick(at(0, 0, 150), input, tap, 33, 60)
  const guest = tick(at(0, 0, 150), input, tap, 16, 60)
  assert.equal(host.x, guest.x)
  assert.equal(host.credit, guest.credit)
})

test('settle charges a taken step and holds a refused one', () => {
  assert.equal(settle(170, 150, true), 20)
  assert.equal(settle(170, 150, false), 150)
})

test('speed levels map to the delays the game advertises', () => {
  assert.equal(moveDelayForSpeed(1), 150)
  assert.equal(moveDelayForSpeed(3), 90)
  assert.equal(moveDelayForSpeed(5), 60)
  assert.equal(moveDelayForSpeed(9), 60, 'floored, never faster')
})

test('replay lands where a host that simulated the same span would', () => {
  const delay = 150
  // The player pressed right at t=1000 and is still holding at t=1600.
  const inputs = [{ seq: 1, dx: 1, dy: 0, at: 1000 }]
  // The host has simulated them through t=1200 and reported that state.
  const authoritative = tick(at(0, 0, 150), { dx: 1, dy: 0 }, 200, 33, delay)

  const predicted = replay(authoritative, delay, inputs, 1200, 1600, OPEN)
  // What the host will itself report once it catches up to t=1600.
  const eventual = tick(at(0, 0, 150), { dx: 1, dy: 0 }, 600, 33, delay)

  assert.equal(predicted.x, eventual.x)
  assert.equal(predicted.credit, eventual.credit)
})

test('replay survives doubling back — the case a tile trail cannot judge', () => {
  // Run right, then reverse. A trail-matching heuristic sees the host standing
  // on a tile the player has visited and concludes all is well, or sees one it
  // cannot place and yanks the player backwards. Re-deriving just gets it right.
  const delay = 150
  const inputs = [
    { seq: 1, dx: 1, dy: 0, at: 0 },
    { seq: 2, dx: -1, dy: 0, at: 600 },
  ]
  const authoritative = at(0, 0, 150)

  const predicted = replay(authoritative, delay, inputs, 0, 1200, OPEN)

  // By hand: 600ms right from a full bank is the press plus three more, so +4.
  // Then 600ms left from whatever was left over brings them back four.
  const forward = run(at(0, 0, 150), { dx: 1, dy: 0 }, 600, delay, OPEN)
  const back = run(forward, { dx: -1, dy: 0 }, 600, delay, OPEN)
  assert.equal(predicted.x, back.x)
  assert.equal(predicted.credit, back.credit)
  assert.ok(predicted.x < forward.x, 'the reversal actually moved them back')
})

test('replay ignores inputs the authority already folded in', () => {
  const delay = 150
  const inputs = [
    { seq: 1, dx: 1, dy: 0, at: 0 },
    { seq: 2, dx: 0, dy: 1, at: 500 },
  ]
  // Authority has simulated through t=500 — the whole first input.
  const authoritative = at(4, 0, 0)
  const predicted = replay(authoritative, delay, inputs, 500, 800, OPEN)

  assert.equal(predicted.x, 4, 'the acknowledged run is not applied twice')
  assert.ok(predicted.y > 0, 'the unacknowledged one is applied')
})

test('replay respects walls it can see', () => {
  const delay = 150
  const inputs = [{ seq: 1, dx: 1, dy: 0, at: 0 }]
  const stopAt3 = x => x <= 3
  const predicted = replay(at(0, 0, 150), delay, inputs, 0, 5000, stopAt3)
  assert.equal(predicted.x, 3)
})

test('replay is stable when nothing has happened since the authority spoke', () => {
  const delay = 150
  const inputs = [{ seq: 1, dx: 0, dy: 0, at: 100 }]
  const authoritative = at(7, 7, 40)
  const predicted = replay(authoritative, delay, inputs, 200, 900, OPEN)
  assert.equal(predicted.x, 7)
  assert.equal(predicted.y, 7)
})

// ── Drawing somebody else ───────────────────────────────────────────────────

/** Every consecutive pair must be a single orthogonal step, or it is a diagonal. */
function assertWalkable(buffer) {
  for (let i = 1; i < buffer.length; i++) {
    const step = Math.abs(buffer[i].x - buffer[i - 1].x) + Math.abs(buffer[i].y - buffer[i - 1].y)
    assert.equal(step, 1, `segment ${i} moves ${step} tiles, so it is not a walk`)
    assert.ok(buffer[i].at >= buffer[i - 1].at, 'stamps must not go backwards')
  }
}

test('a report of several tiles is split into steps that can be walked', () => {
  const buffer = []
  appendWaypoints(buffer, 5, 5, 1000, 4, 0, -Infinity)
  // Two tiles across and one down, arriving as one report — a rounded corner.
  appendWaypoints(buffer, 7, 6, 1300, 4, 0, -Infinity)
  assertWalkable(buffer)
  assert.equal(buffer.length, 4, 'origin plus three steps')
  assert.deepEqual(
    buffer.map(w => [w.x, w.y]),
    [[5, 5], [6, 5], [7, 5], [7, 6]],
  )
})

test('interpolating a corner never leaves the grid', () => {
  const buffer = []
  appendWaypoints(buffer, 0, 0, 0, 4, 0, -Infinity)
  appendWaypoints(buffer, 1, 1, 200, 4, 0, -Infinity)
  // Walk the whole span and check we are always aligned on at least one axis.
  for (let t = 0; t <= 200; t += 5) {
    const p = sampleAt(buffer, t)
    const offX = Math.abs(p.x - Math.round(p.x))
    const offY = Math.abs(p.y - Math.round(p.y))
    assert.ok(offX < 1e-9 || offY < 1e-9, `off-grid at t=${t}: ${p.x},${p.y}`)
  }
})

test('a jump too big to walk drops the trail instead of animating a teleport', () => {
  const buffer = []
  appendWaypoints(buffer, 0, 0, 0, 3, 0, -Infinity)
  appendWaypoints(buffer, 9, 9, 100, 3, 0, -Infinity)
  assert.equal(buffer.length, 1)
  assert.deepEqual([buffer[0].x, buffer[0].y], [9, 9])
})

test('a report that repeats the last position adds nothing', () => {
  const buffer = []
  appendWaypoints(buffer, 2, 2, 0, 4, 0, -Infinity)
  appendWaypoints(buffer, 2, 2, 100, 4, 0, -Infinity)
  appendWaypoints(buffer, 2, 2, 200, 4, 0, -Infinity)
  assert.equal(buffer.length, 1)
})

test('sampling between two reports interpolates', () => {
  const buffer = [
    { x: 0, y: 0, at: 0 },
    { x: 1, y: 0, at: 100 },
  ]
  assert.equal(sampleAt(buffer, 0).x, 0)
  assert.equal(sampleAt(buffer, 50).x, 0.5)
  assert.equal(sampleAt(buffer, 100).x, 1)
})

test('sampling past the newest report holds still rather than guessing', () => {
  // Extrapolating here is what produced a character still walking after its
  // player had stopped — movement with nobody driving it.
  const buffer = [
    { x: 0, y: 0, at: 0 },
    { x: 1, y: 0, at: 100 },
  ]
  for (const t of [101, 500, 10_000]) {
    assert.deepEqual(sampleAt(buffer, t), { x: 1, y: 0 }, `held at t=${t}`)
  }
})

test('sampling before the oldest report clamps to it', () => {
  const buffer = [{ x: 4, y: 4, at: 500 }]
  assert.deepEqual(sampleAt(buffer, 0), { x: 4, y: 4 })
  assert.equal(sampleAt([], 0), null)
})

test('pruning keeps enough history to interpolate from', () => {
  const buffer = [
    { x: 0, y: 0, at: 0 },
    { x: 1, y: 0, at: 100 },
    { x: 2, y: 0, at: 200 },
    { x: 3, y: 0, at: 300 },
  ]
  pruneWaypoints(buffer, 250)
  assert.ok(buffer.length >= 2, 'never pruned below a pair')
  // The moment being drawn must still sit inside the surviving span.
  assert.ok(buffer[0].at <= 250, 'kept the entry behind the render moment')
  assert.equal(sampleAt(buffer, 250).x, 2.5)
})

test('reports that arrive in a burst still play back at walking pace', () => {
  // Reports do not arrive evenly — a stall lands several at once. Timing the
  // walk purely by when we heard about it crammed a second of travel into a
  // millisecond, and the character flickered across the board at nine times
  // its real speed. A tile cannot be crossed faster than the move delay, so
  // that is the floor no matter when the news turned up.
  const delay = 150
  const buffer = []
  appendWaypoints(buffer, 0, 0, 1000, 4, delay, -Infinity)
  // Three tiles' worth, all delivered in the same instant.
  appendWaypoints(buffer, 1, 0, 1001, 4, delay, -Infinity)
  appendWaypoints(buffer, 2, 0, 1001, 4, delay, -Infinity)
  appendWaypoints(buffer, 3, 0, 1001, 4, delay, -Infinity)

  assertWalkable(buffer)
  for (let i = 1; i < buffer.length; i++) {
    const took = buffer[i].at - buffer[i - 1].at
    assert.ok(took >= delay - 1e-9, `step ${i} played back in ${took}ms`)
  }

  // And sampling across it never exceeds one tile per delay.
  let previous = sampleAt(buffer, buffer[0].at)
  for (let t = buffer[0].at; t <= buffer[buffer.length - 1].at; t += 16) {
    const now = sampleAt(buffer, t)
    const moved = Math.abs(now.x - previous.x) + Math.abs(now.y - previous.y)
    assert.ok(moved <= 16 / delay + 1e-6, `moved ${moved} tiles in 16ms`)
    previous = now
  }
})

test('a refill after a stall walks, rather than arriving all at once', () => {
  // The trail's last stamp goes stale while nothing is arriving. Hanging the
  // next steps off it schedules every one of them in a moment already drawn, so
  // playback does not walk them — it lands on the end of them. That is the
  // character flickering across the board after a hiccup.
  const delay = 150
  const buffer = []
  appendWaypoints(buffer, 0, 0, 1000, 4, delay, 900)

  // Nothing for a second; the draw cursor has long passed that stamp.
  const drawCursor = 2000
  appendWaypoints(buffer, 1, 0, 2100, 4, delay, drawCursor)
  appendWaypoints(buffer, 2, 0, 2100, 4, delay, drawCursor)

  for (const w of buffer.slice(1)) {
    assert.ok(w.at >= drawCursor, `step scheduled at ${w.at}, before the cursor`)
  }
  // And it is still a walk from where we are now, not a jump.
  const startedAt = sampleAt(buffer, drawCursor)
  const shortlyAfter = sampleAt(buffer, drawCursor + 16)
  const moved =
    Math.abs(shortlyAfter.x - startedAt.x) + Math.abs(shortlyAfter.y - startedAt.y)
  assert.ok(moved <= 16 / delay + 1e-6, `moved ${moved} tiles in one frame`)
})

test('a whole run of reports stays walkable and never runs ahead', () => {
  const buffer = []
  let t = 0
  // A player crossing the arena and turning, reported in irregular lumps.
  for (const [x, y] of [[0, 0], [2, 0], [3, 0], [3, 2], [3, 3], [5, 3]]) {
    t += 60 + Math.round(Math.random() * 80)
    appendWaypoints(buffer, x, y, t, 4, 0, -Infinity)
  }
  assertWalkable(buffer)
  const last = buffer[buffer.length - 1]
  assert.deepEqual(sampleAt(buffer, t + 5000), { x: last.x, y: last.y })
})
