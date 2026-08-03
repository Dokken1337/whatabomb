import { randomInt, randomUUID } from 'node:crypto'
import {
  DEFAULT_MATCH_CONFIG,
  LOBBY_CODE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  sanitizeName,
  winsNeeded,
  type LobbyStatus,
  type LobbyView,
  type MatchConfig,
} from '../shared/protocol.js'
import type { LobbyStore } from './lobby-store.js'

export interface LobbyPlayer {
  id: string
  name: string
  ready: boolean
  connected: boolean
  slot: number
  wins: number
  /** Set when the socket drops; the seat is held briefly for a reconnect. */
  disconnectedAt: number | null
}

export interface LobbyRecord {
  code: string
  hostId: string
  status: LobbyStatus
  config: MatchConfig
  round: number
  players: LobbyPlayer[]
  createdAt: number
  updatedAt: number
}

/** Grace period a disconnected player keeps their seat before being dropped. */
export const RECONNECT_GRACE_MS = 30_000

/** A lobby with nobody connected is swept after this long. */
export const IDLE_LOBBY_TTL_MS = 10 * 60_000

const MAX_CODE_ATTEMPTS = 50

export class LobbyFullError extends Error {}
export class LobbyInProgressError extends Error {}

/** Generate an unused zero-padded numeric code. */
export async function generateLobbyCode(store: LobbyStore): Promise<string> {
  const ceiling = 10 ** LOBBY_CODE_LENGTH
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    // randomInt is uniform and crypto-backed, so codes are not guessable in order.
    const code = String(randomInt(0, ceiling)).padStart(LOBBY_CODE_LENGTH, '0')
    if (!(await store.has(code))) return code
  }
  throw new Error('Could not allocate a free lobby code')
}

export function createLobby(code: string, hostName: unknown): LobbyRecord {
  const now = Date.now()
  const host: LobbyPlayer = {
    id: randomUUID(),
    name: sanitizeName(hostName, 0),
    ready: false,
    connected: true,
    slot: 0,
    wins: 0,
    disconnectedAt: null,
  }
  return {
    code,
    hostId: host.id,
    status: 'waiting',
    config: { ...DEFAULT_MATCH_CONFIG },
    round: 1,
    players: [host],
    createdAt: now,
    updatedAt: now,
  }
}

/** Lowest free slot index, so colours and spawn corners stay stable. */
function nextFreeSlot(lobby: LobbyRecord): number {
  const taken = new Set(lobby.players.map(p => p.slot))
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    if (!taken.has(slot)) return slot
  }
  return -1
}

export function addPlayer(lobby: LobbyRecord, name: unknown): LobbyPlayer {
  if (lobby.status === 'playing') {
    throw new LobbyInProgressError('That match has already started')
  }
  const slot = nextFreeSlot(lobby)
  if (slot < 0 || lobby.players.length >= MAX_PLAYERS) {
    throw new LobbyFullError(`That lobby already has ${MAX_PLAYERS} players`)
  }

  const player: LobbyPlayer = {
    id: randomUUID(),
    name: sanitizeName(name, slot),
    ready: false,
    connected: true,
    slot,
    wins: 0,
    disconnectedAt: null,
  }
  lobby.players.push(player)
  lobby.updatedAt = Date.now()
  return player
}

export function removePlayer(lobby: LobbyRecord, playerId: string): void {
  const index = lobby.players.findIndex(p => p.id === playerId)
  if (index === -1) return
  lobby.players.splice(index, 1)
  lobby.updatedAt = Date.now()

  // Hand the host role to whoever has been waiting longest.
  if (lobby.hostId === playerId && lobby.players.length > 0) {
    lobby.hostId = lobby.players[0].id
  }

  // A match cannot continue below the minimum, so send everyone back to the lobby.
  if (lobby.status === 'playing' && countActive(lobby) < MIN_PLAYERS) {
    lobby.status = 'waiting'
    resetReadyFlags(lobby)
  }
}

export function findPlayer(lobby: LobbyRecord, playerId: string): LobbyPlayer | undefined {
  return lobby.players.find(p => p.id === playerId)
}

export function countActive(lobby: LobbyRecord): number {
  return lobby.players.filter(p => p.connected).length
}

export function resetReadyFlags(lobby: LobbyRecord): void {
  for (const player of lobby.players) player.ready = false
  lobby.updatedAt = Date.now()
}

/**
 * Why the match cannot start yet, or null when it can.
 *
 * The player cap is enforced on join, but the "too many players" branch is kept
 * as a guard so a lobby can never start oversized even if state is restored
 * from an external store that allowed it.
 */
export function startBlockedReason(lobby: LobbyRecord): string | null {
  if (lobby.status === 'playing') return 'Match already in progress'

  const active = lobby.players.filter(p => p.connected)
  if (active.length > MAX_PLAYERS) {
    const excess = active.length - MAX_PLAYERS
    return `Too many players — ${excess} must leave`
  }
  if (active.length < MIN_PLAYERS) {
    return `Waiting for ${MIN_PLAYERS - active.length} more player${
      MIN_PLAYERS - active.length === 1 ? '' : 's'
    }`
  }

  const notReady = active.filter(p => !p.ready)
  if (notReady.length > 0) {
    return notReady.length === 1
      ? `Waiting for ${notReady[0].name}`
      : `Waiting for ${notReady.length} players to ready up`
  }
  return null
}

export function canStart(lobby: LobbyRecord): boolean {
  return startBlockedReason(lobby) === null
}

export function beginRound(lobby: LobbyRecord): void {
  lobby.status = 'playing'
  lobby.updatedAt = Date.now()
}

export interface RoundOutcome {
  matchWinnerId: string | null
}

/** Score a finished round and decide whether the match is over. */
export function recordRoundResult(lobby: LobbyRecord, winnerId: string | null): RoundOutcome {
  const winner = winnerId ? findPlayer(lobby, winnerId) : undefined
  if (winner) winner.wins++

  const target = winsNeeded(lobby.config)
  const matchWinner = lobby.players.find(p => p.wins >= target) ?? null

  if (matchWinner) {
    lobby.status = 'finished'
  } else {
    lobby.status = 'waiting'
    lobby.round++
    // Everyone re-readies between rounds so nobody is dropped into a new arena
    // while they are away from the keyboard.
    resetReadyFlags(lobby)
  }

  lobby.updatedAt = Date.now()
  return { matchWinnerId: matchWinner?.id ?? null }
}

/** Start a fresh match, keeping the same lobby and players. */
export function resetMatch(lobby: LobbyRecord): void {
  for (const player of lobby.players) player.wins = 0
  lobby.round = 1
  lobby.status = 'waiting'
  resetReadyFlags(lobby)
}

export function toView(lobby: LobbyRecord): LobbyView {
  return {
    code: lobby.code,
    status: lobby.status,
    config: lobby.config,
    round: lobby.round,
    canStart: canStart(lobby),
    startBlockedReason: startBlockedReason(lobby),
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      connected: p.connected,
      isHost: p.id === lobby.hostId,
      slot: p.slot,
      wins: p.wins,
    })),
  }
}
