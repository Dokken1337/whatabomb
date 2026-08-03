import { createClient } from 'redis'

/**
 * Redis connections used by the multi-instance lobby stack.
 *
 * A client in subscribe mode cannot issue ordinary commands, so the subscriber
 * is a separate connection rather than the one the store uses.
 */
export interface RedisConnections {
  /** Commands: lobby records and locks. Also used to publish. */
  commands: RedisLikeClient
  /** Dedicated subscriber connection. */
  subscriber: RedisLikeClient
  close(): Promise<void>
}

/**
 * The slice of the node-redis client this code depends on.
 *
 * Declared structurally so the store and relay can be unit tested against a
 * fake without standing up a real Redis.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { PX?: number; NX?: boolean }): Promise<string | null>
  del(key: string): Promise<number>
  exists(key: string): Promise<number>
  scan(cursor: string, options?: { MATCH?: string; COUNT?: number }): Promise<{ cursor: string; keys: string[] }>
  mGet(keys: string[]): Promise<Array<string | null>>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: (message: string) => void): Promise<void>
}

/** How long to wait for the initial connection before giving up. */
const CONNECT_TIMEOUT_MS = 15_000

/**
 * Open the command and subscriber connections.
 *
 * Rejects if the first connection cannot be established. Callers should treat
 * that as fatal: with Redis configured but unreachable, lobby state would
 * silently become per-instance again, which is the exact failure this stack
 * exists to prevent — better to fail the deployment's health check loudly.
 *
 * Reconnection *after* startup is left to the client, which retries on its own;
 * a brief blip should not take a running match down.
 */
export async function connectRedis(url: string): Promise<RedisConnections> {
  const make = (role: string) => {
    const client = createClient({
      url,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        // Back off, then keep trying — an App Service instance outliving a
        // cache restart should recover by itself.
        reconnectStrategy: retries => Math.min(retries * 200, 5_000),
      },
    })
    client.on('error', err => {
      console.error(`[redis:${role}]`, err instanceof Error ? err.message : err)
    })
    return client
  }

  const commands = make('commands')
  const subscriber = make('subscriber')

  await Promise.all([commands.connect(), subscriber.connect()])

  return {
    commands: commands as unknown as RedisLikeClient,
    subscriber: subscriber as unknown as RedisLikeClient,
    async close() {
      await Promise.allSettled([commands.quit(), subscriber.quit()])
    },
  }
}
