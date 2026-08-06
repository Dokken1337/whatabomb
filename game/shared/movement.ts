/**
 * The movement clock, shared by the host's simulation and a guest's prediction.
 *
 * This exists as its own module for one reason: it is the only part of the
 * netcode that has to produce *identical* results on two different machines,
 * and it was previously spread across the host's step loop, a guest's
 * prediction and a reconciliation heuristic — three copies of the same rule,
 * each drifting from the others. Every online movement bug in this game so far
 * has been one of those copies disagreeing with another.
 *
 * Nothing here touches the DOM, Babylon, or a socket. It is plain arithmetic
 * over plain values, so it can be driven directly from `node --test` instead of
 * being measured through two browser tabs.
 *
 * ── Why credit rather than a "time of last move" stamp ──
 *
 * Both ends gate a step on the same delay, but each can only act when its own
 * timer happens to fire. Stamping the time of the last move silently rounds
 * every wait up to that moment and throws the remainder away, so the two ends
 * step at slightly different rates and drift apart for as long as anyone is
 * moving. Banking the remainder makes the rate exact on both.
 *
 * It also makes replay possible: because credit accumulates linearly, running
 * 300ms as one chunk gives the same result as running it as ten ticks of 30ms.
 * A guest can therefore re-derive its position from the host's state in a
 * single pass, without having to reproduce the host's exact tick boundaries.
 */

/** Where a player is, and how much time they have banked toward moving. */
export interface MoveState {
  x: number
  y: number
  /** Milliseconds banked toward the next step. */
  credit: number
}

/** A direction being held. Zero on both axes means standing still. */
export interface HeldInput {
  dx: number
  dy: number
}

/**
 * Can a player occupy this tile?
 *
 * Supplied by the caller because it depends on the live world — walls, crates,
 * bombs, other players — which is deliberately not this module's business.
 */
export type CanWalk = (x: number, y: number) => boolean

/** One input as it was sent, stamped on the sender's own clock. */
export interface TimedInput {
  seq: number
  dx: number
  dy: number
  /** Sender's clock when this input was raised. Only ever differenced. */
  at: number
}

/** Steps a single replay may take, so a bad timestamp cannot run away. */
const MAX_REPLAY_STEPS = 64

/**
 * Add elapsed time to the clock.
 *
 * Standing still banks at most one step, so nobody can wait around storing up
 * time and then cross several tiles at once. A non-finite `stepMs` is ignored
 * rather than allowed through: one NaN in the credit is permanent, because
 * every later comparison against it is false, and the player simply never moves
 * again.
 */
export function accrue(credit: number, stepMs: number, delay: number, holding: boolean): number {
  const banked = credit + (Number.isFinite(stepMs) ? stepMs : 0)
  if (!holding) return Math.min(banked, delay)
  return banked
}

/** Is a step due? */
export function isDue(credit: number, delay: number): boolean {
  return credit >= delay
}

/**
 * Charge for a step that happened, or hold the clock at the ready for one that
 * was refused.
 *
 * A refused step must not bank time, or walking into a wall for a second and
 * then turning away would spend that second crossing several tiles at once.
 */
export function settle(credit: number, delay: number, stepped: boolean): number {
  return stepped ? credit - delay : delay
}

/**
 * Speed levels past this do nothing, so the pickup stops counting there.
 *
 * Pinned to where the delay floor bites: a counter that keeps climbing after
 * the character has stopped getting faster is just a number lying on the HUD.
 */
export const MAX_SPEED = 5

/**
 * Milliseconds between steps at a given speed level.
 *
 * 150ms down to 90ms in five steps. The floor is a game-feel decision with a
 * netcode consequence attached: speed multiplies every disagreement between
 * what a player sees and what the host knows, because the gap is measured in
 * tiles and a faster player covers more of them per round trip. At 60ms a tile
 * — where this floor used to sit — a 300ms round trip is five tiles of honest
 * disagreement. At 90ms it is three.
 *
 * The step is 15ms rather than 30 so the floor still takes five pickups to
 * reach. Dropping the ceiling without also softening the step would have made
 * the whole pickup two useful levels deep.
 */
export function moveDelayForSpeed(speed: number): number {
  return Math.max(90, 150 - (Math.min(speed, MAX_SPEED) - 1) * 15)
}

/**
 * Run a player forward over a span of time under one held direction.
 *
 * Takes as many steps as the banked time pays for, stopping early if something
 * is in the way. Chunk size does not matter — see the note at the top — which
 * is what lets a guest replay a long span in one call and still land exactly
 * where a host that ticked through it would have.
 */
export function run(
  state: MoveState,
  input: HeldInput,
  elapsedMs: number,
  delay: number,
  canWalk: CanWalk,
): MoveState {
  const holding = input.dx !== 0 || input.dy !== 0
  let credit = accrue(state.credit, elapsedMs, delay, holding)
  let x = state.x
  let y = state.y
  if (!holding) return { x, y, credit }

  for (let taken = 0; taken < MAX_REPLAY_STEPS && isDue(credit, delay); taken++) {
    const tx = x + input.dx
    const ty = y + input.dy
    if (!canWalk(tx, ty)) {
      credit = settle(credit, delay, false)
      break
    }
    x = tx
    y = ty
    credit = settle(credit, delay, true)
  }
  return { x, y, credit }
}

/**
 * Re-derive where a predicting player has actually got to.
 *
 * The authority reports where a player was as of `simThrough` — a moment on
 * that player's *own* clock, which the authority learned from their input
 * stamps and hands straight back. Everything the player has done since is still
 * in their input buffer, so the position now is simply the authoritative state
 * with those inputs run on top of it.
 *
 * This replaces guessing. The previous approach kept a trail of tiles and asked
 * whether the authority was standing on one of them — which works only while a
 * player moves forwards, and breaks precisely when they double back, because a
 * trail cannot then tell "behind me" apart from "wrong". Re-deriving has no
 * such blind spot: the result disagrees with the authority only where the
 * authority knows something the player genuinely could not.
 *
 * `inputs` must be ordered by `seq`. Entries the authority has already folded
 * in are ignored, so the caller can keep a generous buffer.
 */
export function replay(
  authoritative: MoveState,
  delay: number,
  inputs: TimedInput[],
  simThrough: number,
  nowAt: number,
  canWalk: CanWalk,
): MoveState {
  let state = authoritative
  if (!Number.isFinite(simThrough) || !Number.isFinite(nowAt)) return state

  let cursor = simThrough
  for (let i = 0; i < inputs.length; i++) {
    const current = inputs[i]
    const next = inputs[i + 1]
    // The span this input was held for, clipped to what the authority has not
    // already simulated and to the present.
    const from = Math.max(cursor, current.at)
    const until = Math.min(next ? next.at : nowAt, nowAt)
    if (until <= from) continue

    state = run(state, current, until - from, delay, canWalk)
    cursor = until
  }
  return state
}

/**
 * The input in effect at a given moment, or null if the buffer starts later.
 *
 * Replay needs this when the authority has simulated past the start of the
 * buffer: the direction being held at `simThrough` may have been set by an
 * input the authority already acknowledged.
 */
export function inputAt(inputs: TimedInput[], at: number): TimedInput | null {
  let found: TimedInput | null = null
  for (const input of inputs) {
    if (input.at <= at) found = input
    else break
  }
  return found
}

// ── Drawing somebody else ────────────────────────────────────────────────────
//
// A player you are not predicting can only be drawn from what the authority
// reported, which arrives in lumps and at uneven spacing. Chasing the newest
// report means the model is permanently trying to reach somewhere it never
// quite gets to, and has to be allowed to hurry — which looks like the
// character is faster than they are.
//
// Buffering the reports and drawing a fixed moment *behind* the newest one
// removes the chase entirely: there are always two known positions either side
// of the moment being drawn, so it is an interpolation rather than a pursuit.
// The cost is that other players are shown slightly in the past, which they
// already were — this only makes the delay steady instead of varying, and it is
// the variation that reads as stutter.

/** One reported position, stamped when it was received. */
export interface Waypoint {
  x: number
  y: number
  at: number
}

/**
 * Record where a player has been reported, as steps that can be walked.
 *
 * A report can carry more than one tile of movement, and one that crosses a
 * corner moves on both axes at once. Interpolating straight to it would cut
 * that corner — the character slides diagonally through a wall. Splitting the
 * move into single orthogonal steps, sharing the time it took, keeps every
 * segment on the grid.
 *
 * A jump too large to be walking is a correction, not movement. Animating those
 * only makes it look like the character chose to go, so the trail is dropped and
 * the new position stands alone.
 */
export function appendWaypoints(
  buffer: Waypoint[],
  x: number,
  y: number,
  at: number,
  maxWalkableJump: number,
  minStepMs: number,
  notBefore: number,
): void {
  const last = buffer[buffer.length - 1]
  if (!last) {
    buffer.push({ x, y, at })
    return
  }
  const gap = Math.abs(x - last.x) + Math.abs(y - last.y)
  if (gap === 0) return
  if (gap > maxWalkableJump) {
    buffer.length = 0
    buffer.push({ x, y, at })
    return
  }

  // Never schedule a step into a moment already drawn.
  //
  // After a stall the trail's last stamp is stale, and hanging the new steps
  // off it puts every one of them in the past — so playback does not walk
  // them, it arrives at the end of them, which is the character flickering
  // across the board. Restarting from the moment being drawn is what keeps a
  // refill a walk.
  const base = Math.max(last.at, notBefore)

  // Share the time across the steps it must have taken — but never less than
  // the steps could physically have taken. Several reports can land in the same
  // instant, and timing the walk by when we heard about it would cram a second
  // of travel into a millisecond. How long those steps really took is not a
  // guess: a player cannot cross a tile faster than their own move delay.
  const span = Math.max(1, at - base, gap * minStepMs)
  let cx = last.x
  let cy = last.y
  let taken = 0
  while (cx !== x) {
    cx += Math.sign(x - cx)
    taken++
    buffer.push({ x: cx, y: cy, at: base + (span * taken) / gap })
  }
  while (cy !== y) {
    cy += Math.sign(y - cy)
    taken++
    buffer.push({ x: cx, y: cy, at: base + (span * taken) / gap })
  }
}

/**
 * Where a player was at a given moment, between the positions either side of it.
 *
 * Deliberately never extrapolates. Running past the newest report and guessing
 * where somebody is heading is what produces movement with nobody driving it —
 * a character that keeps walking after its player stopped. Out of reports, it
 * holds still until more arrive, which is honest: we do not know.
 */
export function sampleAt(buffer: Waypoint[], at: number): { x: number; y: number } | null {
  if (buffer.length === 0) return null
  const first = buffer[0]
  if (at <= first.at) return { x: first.x, y: first.y }

  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i]
    const b = buffer[i + 1]
    if (at >= b.at) continue
    const span = b.at - a.at
    const t = span > 0 ? (at - a.at) / span : 1
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }

  const last = buffer[buffer.length - 1]
  return { x: last.x, y: last.y }
}

/** Drop waypoints already behind the moment being drawn, keeping one for the lerp. */
export function pruneWaypoints(buffer: Waypoint[], at: number): void {
  while (buffer.length > 2 && buffer[1].at <= at) buffer.shift()
}
