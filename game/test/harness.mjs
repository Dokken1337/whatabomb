/**
 * Shared plumbing for the tests that drive the real server over real sockets.
 *
 * Kept out of the test files so that adding a second one does not mean a second
 * copy of the socket bookkeeping, which is the part most likely to be subtly
 * different between them and hardest to notice when it is.
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

/**
 * Start the compiled server on `port` and resolve once it is listening.
 *
 * Returns a handle with `url` and `stop()`.
 */
export async function startServer(port) {
  const process_ = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process_.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000)
    process_.stdout.on('data', chunk => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    stop: () => process_.kill(),
  }
}

/** A socket wrapper that queues messages so tests can await them by type. */
export function connect(url) {
  const socket = new WebSocket(url)
  const queue = []
  const waiters = []

  socket.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    const waiterIndex = waiters.findIndex(w => w.type === msg.t)
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    } else {
      queue.push(msg)
    }
  })

  return {
    socket,
    open: () => new Promise(res => socket.once('open', res)),
    send: msg => socket.send(JSON.stringify(msg)),
    /** Resolve with the next message of `type`, checking already-queued ones. */
    next(type, timeoutMs = 5000) {
      const queued = queue.findIndex(m => m.t === type)
      if (queued !== -1) return Promise.resolve(queue.splice(queued, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${type}"`)),
          timeoutMs,
        )
        waiters.push({ type, resolve, timer })
      })
    },
    /**
     * Resolve with whatever of `type` turned up within `ms`, or null.
     *
     * The routing tests are mostly about who does *not* hear something, and a
     * message wrongly delivered arrives just as promptly as a right one — so
     * the wait only has to outlast the delivery path, not the network.
     */
    async silence(type, ms = 300) {
      try {
        return await this.next(type, ms)
      } catch {
        return null
      }
    },
    close: () => socket.close(),
  }
}
