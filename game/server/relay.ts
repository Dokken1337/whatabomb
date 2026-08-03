import type { ServerMessage } from '../shared/protocol.js'
import type { RedisLikeClient } from './redis.js'

/**
 * One message, addressed to players rather than to sockets.
 *
 * The sender does not know — and must not care — which instance holds a given
 * player's WebSocket. It names the players; every instance delivers to whoever
 * it happens to be holding.
 */
export interface RelayEnvelope {
  /** Lobby the message belongs to. */
  code: string
  /** Player ids to deliver to, or null for everyone seated in the lobby. */
  to: string[] | null
  message: ServerMessage
}

/** Hands an envelope to whichever local sockets it is addressed to. */
export type DeliverLocally = (envelope: RelayEnvelope) => void

export interface Relay {
  publish(envelope: RelayEnvelope): void
  close(): Promise<void>
}

const CHANNEL = 'whatabomb:relay'

/**
 * Single-process relay: delivery is just a function call.
 *
 * Used for local development and the tests, where there is nothing to cross.
 */
export function createLocalRelay(deliver: DeliverLocally): Relay {
  return {
    publish(envelope) {
      deliver(envelope)
    },
    async close() {},
  }
}

/**
 * Cross-instance relay over Redis pub/sub.
 *
 * Every instance subscribes to one channel and delivers whatever it is holding
 * a socket for. The publisher is subscribed too, so its own local players are
 * served by the same path — there is no separate local case to keep in sync.
 *
 * One channel for all lobbies means every instance sees every envelope,
 * including for lobbies it has nobody in. At this scale that is far cheaper
 * than the bookkeeping of subscribing and unsubscribing per lobby as players
 * come and go; revisit if concurrent lobbies ever reach the hundreds.
 */
export async function createRedisRelay(
  publisher: RedisLikeClient,
  subscriber: RedisLikeClient,
  deliver: DeliverLocally,
): Promise<Relay> {
  await subscriber.subscribe(CHANNEL, raw => {
    let envelope: RelayEnvelope
    try {
      envelope = JSON.parse(raw) as RelayEnvelope
    } catch {
      console.error('[relay] dropping unparseable envelope')
      return
    }
    if (!envelope || typeof envelope.code !== 'string' || !envelope.message) return
    try {
      deliver(envelope)
    } catch (err) {
      // A failure delivering to one instance must not stop the others.
      console.error('[relay] local delivery failed', err)
    }
  })

  return {
    publish(envelope) {
      // Fire and forget: gameplay traffic is a continuous stream, and awaiting
      // a round trip per snapshot would add latency for no benefit. A dropped
      // publish costs one frame, which the next snapshot corrects.
      void publisher.publish(CHANNEL, JSON.stringify(envelope)).catch(err => {
        console.error('[relay] publish failed', err)
      })
    },
    async close() {},
  }
}
