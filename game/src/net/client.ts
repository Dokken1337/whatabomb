import {
  type ClientMessage,
  type ErrorMessage,
  type LobbyView,
  type MatchStartMessage,
  type RelayInputMessage,
  type RelayStateMessage,
  type RoundOverMessage,
  type ServerMessage,
} from '../../shared/protocol'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed'

export interface NetHandlers {
  onState?: (state: ConnectionState) => void
  onLobby?: (lobby: LobbyView) => void
  onJoined?: (youId: string, lobby: LobbyView) => void
  onMatchStart?: (msg: MatchStartMessage) => void
  onRoundOver?: (msg: RoundOverMessage) => void
  onRelayInput?: (msg: RelayInputMessage) => void
  onRelayState?: (msg: RelayStateMessage) => void
  onError?: (msg: ErrorMessage) => void
}

/** Build the WebSocket URL for whatever origin the page was served from. */
function defaultUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

/**
 * Thin typed wrapper around the lobby WebSocket.
 *
 * Deliberately dumb: it owns the socket lifecycle and message dispatch, and
 * nothing else. Lobby state lives on the server and arrives as `lobby`
 * messages, so this class never tries to model it.
 */
export class NetClient {
  private socket: WebSocket | null = null
  private handlers: NetHandlers = {}
  private state: ConnectionState = 'idle'
  private pingTimer: ReturnType<typeof setInterval> | null = null

  /** Assigned by the server on join; null until then. */
  youId: string | null = null
  /** Last lobby snapshot received, for UI that renders on demand. */
  lobby: LobbyView | null = null
  /** Round-trip time in ms, refreshed by the keepalive ping. */
  latency = 0

  private url: string

  // Written out rather than a parameter property: the client tsconfig sets
  // erasableSyntaxOnly, which disallows that shorthand.
  constructor(url: string = defaultUrl()) {
    this.url = url
  }

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers
  }

  getState(): ConnectionState {
    return this.state
  }

  isConnected(): boolean {
    return this.state === 'open'
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.handlers.onState?.(state)
  }

  connect(): Promise<void> {
    if (this.socket && (this.state === 'open' || this.state === 'connecting')) {
      return Promise.resolve()
    }
    this.setState('connecting')

    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.url)
      } catch (err) {
        this.setState('closed')
        reject(err)
        return
      }
      this.socket = socket

      const failFast = () => {
        this.setState('closed')
        reject(new Error('Could not reach the game server'))
      }

      socket.addEventListener('open', () => {
        this.setState('open')
        // Keeps intermediaries from dropping an idle socket and doubles as a
        // latency probe for the lobby UI.
        this.pingTimer = setInterval(() => {
          this.send({ t: 'ping', ts: Date.now() })
        }, 20_000)
        resolve()
      })

      socket.addEventListener('error', failFast, { once: true })

      socket.addEventListener('close', () => {
        this.stopPing()
        this.socket = null
        this.youId = null
        this.lobby = null
        this.setState('closed')
      })

      socket.addEventListener('message', event => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          return
        }
        this.dispatch(msg)
      })
    })
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        break
      case 'joined':
        this.youId = msg.youId
        this.lobby = msg.lobby
        this.handlers.onJoined?.(msg.youId, msg.lobby)
        break
      case 'lobby':
        this.lobby = msg.lobby
        this.handlers.onLobby?.(msg.lobby)
        break
      case 'matchStart':
        this.lobby = msg.lobby
        this.handlers.onMatchStart?.(msg)
        break
      case 'roundOver':
        this.lobby = msg.lobby
        this.handlers.onRoundOver?.(msg)
        break
      case 'relayInput':
        this.handlers.onRelayInput?.(msg)
        break
      case 'relayState':
        this.handlers.onRelayState?.(msg)
        break
      case 'error':
        this.handlers.onError?.(msg)
        break
      case 'pong':
        this.latency = Date.now() - msg.ts
        break
    }
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  createLobby(name: string): void {
    this.send({ t: 'create', name })
  }

  joinLobby(code: string, name: string): void {
    this.send({ t: 'join', code, name })
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready })
  }

  startMatch(): void {
    this.send({ t: 'start' })
  }

  leaveLobby(): void {
    this.send({ t: 'leave' })
  }

  /** True when this client owns the simulation for the current match. */
  isHost(): boolean {
    if (!this.lobby || !this.youId) return false
    return this.lobby.players.some(p => p.id === this.youId && p.isHost)
  }

  me() {
    if (!this.lobby || !this.youId) return null
    return this.lobby.players.find(p => p.id === this.youId) ?? null
  }

  disconnect(): void {
    this.stopPing()
    this.socket?.close()
    this.socket = null
    this.setState('closed')
  }
}
