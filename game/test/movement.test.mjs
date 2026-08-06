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
