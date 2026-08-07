/**
 * Wire protocol shared by the browser client and the Node game server.
 *
 * Keep this file free of any DOM or Node imports — it is compiled into both
 * bundles. Every message is a JSON object with a `t` discriminator.
 */

/**
 * Bumped whenever the wire changes shape.
 *
 * The client checks this against its own copy on `welcome` and refuses to play
 * on a mismatch. That case is real rather than theoretical: the service worker
 * caches the app shell, so a player who has not reloaded since the last deploy
 * can be running last week's bundle against today's server — and a snapshot it
 * half understands is worse than no match at all, because it looks like the
 * game working badly rather than like a stale tab.
 */
export const PROTOCOL_VERSION = 3

/** Lobby codes are always exactly this many digits, zero padded. */
export const LOBBY_CODE_LENGTH = 6

export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 4

export const MAX_NAME_LENGTH = 8

/** Defaults for an online match, per the game design. */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  rounds: 3,
  lives: 3,
}

/** Largest inbound frame we will parse, as a cheap denial-of-service guard. */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** How often the server pings idle sockets, and how long before it gives up. */
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 45_000

/**
 * How long a disconnected player keeps their seat.
 *
 * Shared rather than server-side only because it is really an agreement between
 * the two ends: the server holds the seat for this long, and the client has to
 * keep trying for at least as long or it gives up on a seat that is still there.
 * When this lived only on the server the client's backoff ran out at about 15s
 * against a 30s grace period, so half of every recoverable drop was thrown away.
 */
export const RECONNECT_GRACE_MS = 30_000

export interface MatchConfig {
  /** Best-of-N. The match ends when someone reaches ceil(rounds / 2) wins. */
  rounds: number
  /** Lives each player starts a round with. */
  lives: number
}

export type LobbyStatus = 'waiting' | 'playing' | 'finished'

export interface LobbyPlayerView {
  id: string
  name: string
  ready: boolean
  connected: boolean
  isHost: boolean
  /** Stable index 0-3, used to pick spawn corner and player colour. */
  slot: number
  /** Rounds won so far in this match. */
  wins: number
}

export interface LobbyView {
  code: string
  status: LobbyStatus
  config: MatchConfig
  players: LobbyPlayerView[]
  /** Current round number, 1-based. */
  round: number
  /** True when every rule for starting is satisfied. */
  canStart: boolean
  /** Human readable reason shown next to a disabled Ready/Start button. */
  startBlockedReason: string | null
}

// ── Client → Server ──────────────────────────────────────────────────────────

export interface CreateLobbyMessage {
  t: 'create'
  name: string
}

export interface JoinLobbyMessage {
  t: 'join'
  code: string
  name: string
}

export interface LeaveLobbyMessage {
  t: 'leave'
}

/**
 * Reclaim a seat after the socket dropped.
 *
 * The server already holds a disconnected player's seat for RECONNECT_GRACE_MS
 * so a blip does not end their match; this is how a returning client says which
 * seat is theirs. Without it a reconnecting player could only ever arrive as a
 * brand new participant, which is why any dropped socket used to be terminal.
 */
export interface ResumeLobbyMessage {
  t: 'resume'
  code: string
  playerId: string
  /**
   * Whether this client still has the arena it left with.
   *
   * A dropped socket and a reloaded page look identical from the server, and
   * they need opposite treatment: a blip should be picked up exactly where it
   * left off, whereas a client that has lost its scene needs the match handed
   * to it again — or, if it was the one simulating, needs the round called off,
   * because the world it was the sole authority for no longer exists. Only the
   * client knows which of the two happened, so it says.
   */
  inMatch: boolean
}

export interface SetReadyMessage {
  t: 'ready'
  ready: boolean
}

/** Host only. Rejected unless every start rule passes. */
export interface StartMatchMessage {
  t: 'start'
}

/**
 * A guest's input, relayed to the host which owns the simulation.
 * `seq` lets the host drop out-of-order frames without a full ack scheme.
 */
export interface InputMessage {
  t: 'input'
  seq: number
  dx: number
  dy: number
  bomb: boolean
  /**
   * The sender's own monotonic clock when this input was raised.
   *
   * Only ever read as a difference against the *same sender's* previous input,
   * which is how long they held the last direction. That is the one thing
   * arrival times cannot tell the host: network jitter stretches and squeezes
   * the gap between two messages, so timing movement by when they turned up
   * silently gave players a step more or less than they earned.
   *
   * Because it is only ever differenced against itself, it does not matter what
   * this clock is set to — two players on opposite sides of the world, with
   * wrong clocks and different time zones, still each report their own hold
   * durations correctly. Never compare it to the receiver's clock.
   */
  at: number
  /**
   * `tick` of the most recent snapshot this client applied.
   *
   * The host stamps every snapshot with its own clock and gets this back, so
   * subtracting gives the round trip measured entirely in host time — again
   * without either end needing to agree with the other about what time it is.
   */
  ackTick: number
}

/** Host only. A snapshot of the authoritative world, fanned out to guests. */
export interface StateMessage {
  t: 'state'
  tick: number
  payload: unknown
}

/** Host only. Reports who won the round so the server can score the match. */
export interface RoundResultMessage {
  t: 'roundResult'
  /** Player id of the winner, or null for a draw. */
  winnerId: string | null
}

export interface PingMessage {
  t: 'ping'
  /** Client clock, echoed back so the client can measure round-trip time. */
  ts: number
}

export type ClientMessage =
  | CreateLobbyMessage
  | JoinLobbyMessage
  | LeaveLobbyMessage
  | ResumeLobbyMessage
  | SetReadyMessage
  | StartMatchMessage
  | InputMessage
  | StateMessage
  | RoundResultMessage
  | PingMessage

// ── Server → Client ──────────────────────────────────────────────────────────

export interface WelcomeMessage {
  t: 'welcome'
  protocol: number
}

export interface JoinedMessage {
  t: 'joined'
  /** The id assigned to this connection. */
  youId: string
  lobby: LobbyView
}

/** Sent on every lobby mutation; clients should treat it as the source of truth. */
export interface LobbyMessage {
  t: 'lobby'
  lobby: LobbyView
}

export interface MatchStartMessage {
  t: 'matchStart'
  /** Seeds map generation so every client builds an identical arena. */
  seed: number
  round: number
  hostId: string
  lobby: LobbyView
}

export interface RoundOverMessage {
  t: 'roundOver'
  winnerId: string | null
  lobby: LobbyView
  /** Set when the match is decided; no further rounds will start. */
  matchWinnerId: string | null
}

/** A guest input forwarded to the host. */
export interface RelayInputMessage {
  t: 'relayInput'
  playerId: string
  seq: number
  dx: number
  dy: number
  bomb: boolean
  /** Sender's own clock — see InputMessage.at. */
  at: number
  /** Last snapshot tick the sender applied — see InputMessage.ackTick. */
  ackTick: number
}

/** A host snapshot forwarded to guests. */
export interface RelayStateMessage {
  t: 'relayState'
  tick: number
  payload: unknown
}

export type ErrorCode =
  | 'bad_request'
  | 'lobby_not_found'
  | 'lobby_full'
  | 'lobby_in_progress'
  | 'not_host'
  | 'not_in_lobby'
  | 'already_in_lobby'
  | 'cannot_start'
  | 'rate_limited'
  | 'internal'

export interface ErrorMessage {
  t: 'error'
  code: ErrorCode
  message: string
}

export interface PongMessage {
  t: 'pong'
  ts: number
}

export type ServerMessage =
  | WelcomeMessage
  | JoinedMessage
  | LobbyMessage
  | MatchStartMessage
  | RoundOverMessage
  | RelayInputMessage
  | RelayStateMessage
  | ErrorMessage
  | PongMessage

// ── World snapshot ───────────────────────────────────────────────────────────
// The host owns the simulation and ships one of these to guests each tick.
// Guests are pure renderers: they never simulate, so the two sides cannot drift.

/**
 * The half of a player that hardly ever changes.
 *
 * Split out because the other half — where they are — changes on almost every
 * snapshot, and snapshots go out up to thirty times a second. Sending a
 * player's whole loadout at that rate spends most of the match repeating
 * `"kick":false` to somebody who already knows. The host omits this group
 * while it is unchanged and the receiver simply keeps what it has.
 */
export interface SnapshotPlayerStats {
  lives: number
  invulnerable: boolean
  bombs: number
  blast: number
  /**
   * Speed level, which sets how often this player may step.
   *
   * Guests predict their own movement from their local move delay, so leaving
   * this out of the snapshot meant a guest kept stepping at the base rate after
   * picking up Speed while the host ran them at up to 2.5x that. Every snapshot
   * then arrived a tile or two ahead and yanked them forward.
   */
  speed: number
  /** Extended power-up state, so guests render and score it the same way. */
  kick: boolean
  throwing: boolean
  shield: number
  pierce: boolean
  /**
   * Remaining ghost milliseconds; drives the see-through character.
   *
   * Counts down continuously, which would defeat the whole point of a group
   * sent only on change, so the host quantises it: this is resent when the
   * displayed second ticks over, and the receiver runs the clock down in
   * between. That is the same thing guests already do with bomb fuses.
   */
  ghost: number
  powerBomb: number
  lineBomb: boolean
}

export interface SnapshotPlayer {
  /**
   * Lobby slot, not player id.
   *
   * Both identify the player exactly, but a slot is one digit and an id is a
   * 36-character UUID — repeated per player, per snapshot, thirty times a
   * second, which made identity the single largest thing on the wire. The
   * roster maps slots to ids once at match start.
   */
  slot: number
  /** Grid coordinates. Visual smoothing is the receiver's business. */
  x: number
  y: number
  alive: boolean
  /** Facing, so remote characters animate the right way. */
  dx: number
  dy: number
  /**
   * True while this player is actually holding a direction.
   *
   * Separate from `dx`/`dy`, which are the *last* direction faced and so never
   * return to zero once someone has moved. Driving the walk cycle off those
   * left every character on a guest's screen jogging on the spot forever.
   */
  moving: boolean
  /**
   * Highest input sequence the host has folded into this player.
   *
   * Guests predict their own movement locally; this tells them how much of
   * what they sent the host has already accounted for, so a snapshot that
   * predates their latest input does not yank them backwards.
   */
  ackSeq: number
  /**
   * The player's banked movement time on the host.
   *
   * Replay has to start from the same clock as well as the same tile, or it
   * re-derives a position from a different amount of change owed.
   */
  credit: number
  /**
   * The moment, on *this player's own clock*, the host has simulated them
   * through.
   *
   * The host learns it from their input stamps and hands it straight back, so
   * the player can replay exactly the span the host has not covered yet. Like
   * `at`, it never crosses a clock boundary: it is the player's own number
   * coming home.
   */
  simAt: number
  /** Present only when it differs from what was last sent. */
  stats?: SnapshotPlayerStats
}

export interface SnapshotBomb {
  /**
   * Stable identity. Without it a receiver cannot tell a bomb that moved from
   * one that was destroyed and replaced, so kicked and thrown bombs teleported.
   */
  id: number
  x: number
  y: number
  /** Milliseconds left on the fuse, for the pulse animation. */
  timer: number
  blast: number
  /**
   * Slot of whoever laid it, or -1 for a bomb with no networked owner.
   *
   * Guests predict their own bomb placement, and the one thing that decides
   * whether a press will be honoured is how many bombs that player already has
   * out. Without an owner a guest cannot count its own, so it has to place
   * hopefully and take the bomb away again when the host declines — which is a
   * visible flicker at exactly the moment the player is trying to judge a gap.
   */
  owner: number
}

export interface SnapshotPowerUp {
  x: number
  y: number
  type: string
}

export interface WorldSnapshot {
  players: SnapshotPlayer[]
  bombs: SnapshotBomb[]
  /**
   * Present only when the set of loose power-ups changed.
   *
   * They change a handful of times a round — a crate opens, someone walks over
   * one — and otherwise sat on the wire in full thirty times a second.
   */
  powerUps?: SnapshotPowerUp[]
  /** Tiles that detonated since the last snapshot, replayed as visuals. */
  blasts: Array<[number, number]>
  /** Crates destroyed since the last snapshot. */
  cleared: Array<[number, number]>
  /**
   * Which crates are still standing, as one character per tile, row by row.
   *
   * Sent with a full snapshot only. `cleared` is a one-shot event — carried by
   * exactly one snapshot and gone from the next — so a guest that was away when
   * it went out never learns that crate was destroyed, and there is nothing in
   * the protocol that would ever mention it again. It then renders crates that
   * are not there and, worse, predicts its own movement against them: it
   * refuses to walk through a gap the host is happy to let it through, so every
   * step near the mistake has to be corrected. Of everything a snapshot
   * describes, the arena was the only part that was never restated.
   */
  crates?: string
  /**
   * True when nothing has been left out, so the receiver can rebuild from this
   * one message alone.
   *
   * Everything omitted above is omitted because the receiver was told once and
   * is assumed to still know. A guest that reconnects mid-round was not: it
   * missed the snapshot that carried the loadouts and would otherwise render
   * the rest of the match from whatever it happened to start with. The host
   * sends one of these every second, which costs almost nothing and means no
   * receiver can be permanently wrong about anything.
   */
  full?: boolean
}

// ── Helpers shared by both sides ─────────────────────────────────────────────

/**
 * What makes one loadout different from another, on the wire.
 *
 * The host omits `stats` while this is unchanged, so anything missing from here
 * is a field that can change without a guest ever being told — it will render
 * and predict from a stale value for the rest of the round. Adding a power-up
 * therefore means adding it here; `test/protocol.test.mjs` fails if it is
 * forgotten.
 *
 * Ghost is deliberately compared at the resolution it is *displayed* at rather
 * than exactly. It counts down every tick, so an exact comparison would report
 * a change on every single snapshot and the whole scheme would buy nothing;
 * receivers run the clock down themselves in between, exactly as they already
 * do with bomb fuses.
 */
export function playerStatsSignature(stats: SnapshotPlayerStats): string {
  return (
    `${stats.lives},${stats.invulnerable ? 1 : 0},${stats.bombs},${stats.blast},` +
    `${stats.speed},${stats.kick ? 1 : 0}${stats.throwing ? 1 : 0}` +
    `${stats.pierce ? 1 : 0}${stats.lineBomb ? 1 : 0},` +
    `${stats.shield},${stats.powerBomb},${Math.ceil(stats.ghost / 1000)}`
  )
}

/**
 * How long to wait before each reconnect attempt, in milliseconds.
 *
 * Derived from the grace period rather than written out, because the two are
 * really one decision: giving up before the server does throws away a seat that
 * is still there, and the player is told to start a new match for no reason.
 * A hand-written list stopped at 15.5s against a 30s grace period, so half of
 * every recoverable drop was abandoned early.
 */
export function reconnectBackoff(): number[] {
  const delays: number[] = []
  let total = 0
  let delay = 500
  // Doubling, capped, until the attempts between them span the whole period.
  while (total <= RECONNECT_GRACE_MS) {
    delays.push(delay)
    total += delay
    delay = Math.min(delay * 2, 5000)
  }
  return delays
}

/** Wins needed to take a best-of-N match. */
export function winsNeeded(config: MatchConfig): number {
  return Math.ceil(config.rounds / 2)
}

/** Trim and clamp a display name; falls back to a slot-based default. */
export function sanitizeName(name: unknown, slot: number): string {
  const raw = typeof name === 'string' ? name.trim() : ''
  // Strip control characters so a name cannot corrupt a rendered list.
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, MAX_NAME_LENGTH)
  return cleaned.length > 0 ? cleaned : `Player ${slot + 1}`
}

/** True when `value` looks like a well formed lobby code. */
export function isValidLobbyCode(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^\\d{${LOBBY_CODE_LENGTH}}$`).test(value)
}
