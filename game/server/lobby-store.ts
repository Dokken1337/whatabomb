import type { LobbyRecord } from './lobby.js'

/**
 * Persistence boundary for lobby state.
 *
 * Game logic never touches a concrete store, so swapping the in-memory
 * implementation for Redis later is one new file plus a config flag — no
 * changes to the lobby rules or the socket handling.
 *
 * Note that Redis would only solve *shared state*. WebSocket connections stay
 * pinned to the instance that accepted them, so running more than one instance
 * would additionally need a pub/sub relay between instances.
 */
export interface LobbyStore {
  get(code: string): Promise<LobbyRecord | undefined>
  set(code: string, lobby: LobbyRecord): Promise<void>
  delete(code: string): Promise<void>
  has(code: string): Promise<boolean>
  /** Every lobby, used by the idle sweep. */
  values(): Promise<LobbyRecord[]>
  size(): Promise<number>
}

/**
 * Single-process store. Lobbies are lost on restart, which is acceptable while
 * the app runs on one instance and matches are short.
 */
export class InMemoryLobbyStore implements LobbyStore {
  private lobbies = new Map<string, LobbyRecord>()

  async get(code: string): Promise<LobbyRecord | undefined> {
    return this.lobbies.get(code)
  }

  async set(code: string, lobby: LobbyRecord): Promise<void> {
    this.lobbies.set(code, lobby)
  }

  async delete(code: string): Promise<void> {
    this.lobbies.delete(code)
  }

  async has(code: string): Promise<boolean> {
    return this.lobbies.has(code)
  }

  async values(): Promise<LobbyRecord[]> {
    return [...this.lobbies.values()]
  }

  async size(): Promise<number> {
    return this.lobbies.size
  }
}
