/**
 * The two protocol rules that fail silently.
 *
 *   npm run build:server && npm run test:server
 *
 * Neither of these is the sort of thing a play test catches. A loadout field
 * missing from the change signature is never resent, so guests render a stale
 * value for the rest of the round and nothing anywhere reports an error; a
 * reconnect schedule that runs out early looks exactly like a connection that
 * genuinely could not be recovered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECONNECT_GRACE_MS,
  playerStatsSignature,
  reconnectBackoff,
} from '../dist-server/shared/protocol.js'

/** A loadout with nothing picked up yet. */
const baseStats = () => ({
  lives: 3,
  invulnerable: false,
  bombs: 1,
  blast: 1,
  speed: 1,
  kick: false,
  throwing: false,
  shield: 0,
  pierce: false,
  ghost: 0,
  powerBomb: 0,
  lineBomb: false,
})

/** One meaningful change per field, whatever its type. */
const bump = value => {
  if (typeof value === 'boolean') return !value
  // Ghost is compared per displayed second, so a change has to clear one.
  return value + 1000
}

test('every loadout field is covered by the change signature', () => {
  const base = baseStats()
  const signature = playerStatsSignature(base)

  for (const field of Object.keys(base)) {
    const changed = { ...base, [field]: bump(base[field]) }
    assert.notEqual(
      playerStatsSignature(changed),
      signature,
      `changing "${field}" does not change the signature, so the host would ` +
        `never resend it and guests would keep the value they started with`,
    )
  }
})

test('an unchanged loadout is not resent', () => {
  assert.equal(playerStatsSignature(baseStats()), playerStatsSignature(baseStats()))
})

test('the ghost countdown does not resend the loadout every tick', () => {
  // Eight seconds of ghost, run down at the simulation rate. Comparing it
  // exactly would report a change on all ~240 of these and the whole scheme
  // would carry the full loadout thirty times a second, which is what it
  // exists to avoid.
  const signatures = new Set()
  for (let ghost = 8000; ghost > 0; ghost -= 33) {
    signatures.add(playerStatsSignature({ ...baseStats(), ghost }))
  }
  assert.ok(
    signatures.size <= 9,
    `ghost produced ${signatures.size} distinct signatures over its 8s life; ` +
      `it should change only as the displayed second ticks over`,
  )
})

test('ghost expiring is still reported', () => {
  const nearly = playerStatsSignature({ ...baseStats(), ghost: 40 })
  const gone = playerStatsSignature({ ...baseStats(), ghost: 0 })
  assert.notEqual(nearly, gone)
})

test('the reconnect schedule outlasts the seat the server holds', () => {
  const delays = reconnectBackoff()
  const total = delays.reduce((sum, delay) => sum + delay, 0)
  assert.ok(
    total > RECONNECT_GRACE_MS,
    `giving up after ${total}ms abandons a seat held for ${RECONNECT_GRACE_MS}ms`,
  )
  // Still prompt about the first try: a blip should recover in well under a
  // second, not after the backoff has wound up.
  assert.ok(delays[0] <= 500, `first retry waits ${delays[0]}ms`)
  // And bounded, so a client cannot sit in a retry loop indefinitely.
  assert.ok(delays.length < 20, `${delays.length} attempts is a retry loop`)
})
