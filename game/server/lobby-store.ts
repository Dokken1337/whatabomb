import type { LobbyRecord } from './lobby.js'
import type { RedisLikeClient } from './redis.js'

/**
 * Persistence boundary for lobby state.
 *
 * Game logic never touches a concrete store, so the in-memory and Redis
 * implementations are interchangeable.
 *
 * Shared state is only half of what multi-instance play needs: WebSockets stay
 * pinned to the instance that accepted them, so messages also have to cross
 * instances — that is the relay's job, see relay.ts.
 */
export interface LobbyStore {
  get(code: string): Promise<LobbyRecord | undefined>
  set(code: string, lobby: LobbyRecord): Promise<void>
  delete(code: string): Promise<void>
  has(code: string): Promise<boolean>
  /** Every lobby, used by the idle sweep. */
  values(): Promise<LobbyRecord[]>
  size(): Promise<number>
  /**
   * Run `mutate` with exclusive access to one lobby.
   *
   * Read-modify-write on a lobby is no longer safe on its own: two players can
   * join through two different instances at the same moment, and the second
   * write would otherwise erase the first player's seat.
   */
  withLock<T>(code: string, mutate: () => Promise<T>): Promise<T>
}

/**
 * Single-process store. Correct only on a single instance — with more than one,
 * a code created here is invisible to every other instance.
 *
 * Kept for local development and the test suite, where there is one process by
 * definition and running a Redis is pure friction.
 */
export class InMemoryLobbyStore implements LobbyStore {
  private lobbies = new Map<string, LobbyRecord>()

  /** One process, one event loop: an await boundary is all the exclusion needed. */
  async withLock<T>(_code: string, mutate: () => Promise<T>): Promise<T> {
    return mutate()
  }

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

/** Key prefixes, namespaced so the cache can be shared with anything else. */
const LOBBY_PREFIX = 'whatabomb:lobby:'
const LOCK_PREFIX = 'whatabomb:lock:'

/**
 * Backstop expiry on the stored record.
 *
 * The idle sweep is the primary reaper, but it only runs while an instance is
 * alive. A TTL means a lobby orphaned by a crash cannot sit in the cache
 * forever. It is refreshed on every write, and the sweep writes every occupied
 * lobby each pass, so a lobby someone is sitting in never approaches it.
 */
const RECORD_TTL_MS = 60 * 60_000

/** Long enough to cover a read-modify-write, short enough to self-heal. */
const LOCK_TTL_MS = 5_000
const LOCK_RETRY_MS = 25
const LOCK_WAIT_MS = 3_000

/** Release only if we still hold it — never drop a lock that has been re-taken. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Lobby state shared by every App Service instance.
 *
 * This is what makes a code created on one instance resolvable from all of
 * them; the socket fan-out that goes with it lives in relay.ts.
 */
export class RedisLobbyStore implements LobbyStore {
  private client: RedisLikeClient

  constructor(client: RedisLikeClient) {
    this.client = client
  }

  async get(code: string): Promise<LobbyRecord | undefined> {
    const raw = await this.client.get(LOBBY_PREFIX + code)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as LobbyRecord
    } catch {
      // A corrupt record is worse than none: drop it so a fresh code can be
      // allocated rather than failing every join for that code forever.
      console.error(`[store] discarding unparseable lobby ${code}`)
      await this.delete(code)
      return undefined
    }
  }

  async set(code: string, lobby: LobbyRecord): Promise<void> {
    await this.client.set(LOBBY_PREFIX + code, JSON.stringify(lobby), { PX: RECORD_TTL_MS })
  }

  async delete(code: string): Promise<void> {
    await this.client.del(LOBBY_PREFIX + code)
  }

  async has(code: string): Promise<boolean> {
    return (await this.client.exists(LOBBY_PREFIX + code)) > 0
  }

  /** SCAN rather than KEYS: the sweep must never block the cache. */
  private async keys(): Promise<string[]> {
    const found: string[] = []
    let cursor = '0'
    do {
      const batch = await this.client.scan(cursor, { MATCH: `${LOBBY_PREFIX}*`, COUNT: 100 })
      cursor = batch.cursor
      found.push(...batch.keys)
    } while (cursor !== '0')
    return found
  }

  async values(): Promise<LobbyRecord[]> {
    const keys = await this.keys()
    if (keys.length === 0) return []
    const raw = await this.client.mGet(keys)
    const lobbies: LobbyRecord[] = []
    for (const entry of raw) {
      if (!entry) continue
      try {
        lobbies.push(JSON.parse(entry) as LobbyRecord)
      } catch {
        // Skip; get() cleans these up when the code is next touched.
      }
    }
    return lobbies
  }

  async size(): Promise<number> {
    return (await this.keys()).length
  }

  async withLock<T>(code: string, mutate: () => Promise<T>): Promise<T> {
    const key = LOCK_PREFIX + code
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const deadline = Date.now() + LOCK_WAIT_MS

    let held = false
    while (Date.now() < deadline) {
      const acquired = await this.client.set(key, token, { NX: true, PX: LOCK_TTL_MS })
      if (acquired) {
        held = true
        break
      }
      await sleep(LOCK_RETRY_MS)
    }

    // Proceed unlocked rather than dropping the player's action entirely: a
    // contended lobby is still better served by a possible lost update than by
    // a join that silently does nothing.
    if (!held) console.warn(`[store] lock timeout for lobby ${code}, proceeding unlocked`)

    try {
      return await mutate()
    } finally {
      if (held) {
        try {
          await this.client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] })
        } catch (err) {
          // The TTL clears it shortly regardless.
          console.error('[store] lock release failed', err)
        }
      }
    }
  }
}
