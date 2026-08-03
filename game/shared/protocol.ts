/**
 * Wire protocol shared by the browser client and the Node game server.
 *
 * Keep this file free of any DOM or Node imports — it is compiled into both
 * bundles. Every message is a JSON object with a `t` discriminator.
 */

export const PROTOCOL_VERSION = 1

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

// ── Helpers shared by both sides ─────────────────────────────────────────────

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
