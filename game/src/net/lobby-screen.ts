import { LOBBY_CODE_LENGTH, MAX_PLAYERS, type LobbyView } from '../../shared/protocol'
import { PLAYER_COLORS } from '../settings'
import type { NetClient } from './client'

export interface LobbyScreenOptions {
  net: NetClient
  /** Current player name from settings. */
  getPlayerName: () => string
  onBack: () => void
  /**
   * Fired when the server starts a round. `seed` must be fed to generateMap so
   * every client builds an identical arena. This is the hook the Babylon scene
   * hangs off; until it launches a networked match the lobby just reports it.
   */
  onMatchStart?: (info: { seed: number; round: number; hostId: string; youAreHost: boolean }) => void
}

/** Colour for a lobby slot, matching the in-game player colours. */
export function slotColor(slot: number): string {
  return PLAYER_COLORS[slot % PLAYER_COLORS.length].value
}

export function createLobbyScreen(options: LobbyScreenOptions): HTMLDivElement {
  const { net, getPlayerName, onBack, onMatchStart } = options

  const root = document.createElement('div')
  root.id = 'lobby-screen'
  root.className = 'menu-container'
  root.style.position = 'absolute'
  root.style.inset = '0'
  root.style.display = 'none'
  root.style.flexDirection = 'column'
  root.style.alignItems = 'center'
  root.style.justifyContent = 'flex-start'
  root.style.zIndex = '2500'
  root.style.color = 'white'
  root.style.overflowY = 'auto'
  root.style.padding = '40px 20px'

  const title = document.createElement('h1')
  title.textContent = '🌐 ONLINE'
  title.className = 'menu-title'
  title.style.fontSize = '32px'
  title.style.marginBottom = '20px'
  root.appendChild(title)

  const status = document.createElement('div')
  status.className = 'lobby-status'
  status.textContent = 'Not connected'
  root.appendChild(status)

  // ── Panel: choose create or join ─────────────────────────────────────────
  const choicePanel = document.createElement('div')
  choicePanel.className = 'lobby-panel'

  const createBtn = document.createElement('button')
  createBtn.className = 'menu-button'
  createBtn.textContent = '➕ Create Lobby'
  createBtn.style.width = '100%'
  choicePanel.appendChild(createBtn)

  const divider = document.createElement('div')
  divider.className = 'lobby-divider'
  divider.textContent = 'or join with a code'
  choicePanel.appendChild(divider)

  const codeRow = document.createElement('div')
  codeRow.className = 'lobby-code-row'

  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.inputMode = 'numeric'
  codeInput.autocomplete = 'off'
  codeInput.maxLength = LOBBY_CODE_LENGTH
  codeInput.placeholder = '000000'
  codeInput.className = 'lobby-code-input'
  // Digits only, so a stray letter cannot produce a confusing server error.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, LOBBY_CODE_LENGTH)
    joinBtn.disabled = codeInput.value.length !== LOBBY_CODE_LENGTH
  })
  // The game listens for keys on window; stop them driving the player.
  codeInput.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click()
  })
  codeInput.addEventListener('keyup', e => e.stopPropagation())
  codeRow.appendChild(codeInput)

  const joinBtn = document.createElement('button')
  joinBtn.className = 'menu-button'
  joinBtn.textContent = 'JOIN'
  joinBtn.disabled = true
  codeRow.appendChild(joinBtn)

  choicePanel.appendChild(codeRow)
  root.appendChild(choicePanel)

  // ── Panel: the lobby itself ──────────────────────────────────────────────
  const lobbyPanel = document.createElement('div')
  lobbyPanel.className = 'lobby-panel'
  lobbyPanel.style.display = 'none'

  const codeDisplay = document.createElement('div')
  codeDisplay.className = 'lobby-code-display'
  lobbyPanel.appendChild(codeDisplay)

  const codeHint = document.createElement('div')
  codeHint.className = 'lobby-hint'
  codeHint.textContent = 'Share this code — tap to copy'
  lobbyPanel.appendChild(codeHint)

  codeDisplay.addEventListener('click', async () => {
    const code = net.lobby?.code
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      codeHint.textContent = 'Copied!'
      setTimeout(() => (codeHint.textContent = 'Share this code — tap to copy'), 1500)
    } catch {
      // Clipboard needs a secure context and permission; the code is on screen
      // either way, so a failure here is not worth surfacing as an error.
      codeHint.textContent = 'Select and copy the code above'
    }
  })

  const playerList = document.createElement('div')
  playerList.className = 'lobby-players'
  lobbyPanel.appendChild(playerList)

  const blockedNote = document.createElement('div')
  blockedNote.className = 'lobby-blocked'
  lobbyPanel.appendChild(blockedNote)

  const actionRow = document.createElement('div')
  actionRow.className = 'lobby-actions'

  const readyBtn = document.createElement('button')
  readyBtn.className = 'menu-button'
  readyBtn.textContent = 'READY'
  actionRow.appendChild(readyBtn)

  const startBtn = document.createElement('button')
  startBtn.className = 'menu-button'
  startBtn.textContent = '▶ START'
  actionRow.appendChild(startBtn)

  lobbyPanel.appendChild(actionRow)
  root.appendChild(lobbyPanel)

  const errorBox = document.createElement('div')
  errorBox.className = 'lobby-error'
  root.appendChild(errorBox)

  const backBtn = document.createElement('button')
  backBtn.className = 'menu-button menu-button-danger'
  backBtn.textContent = '← BACK'
  backBtn.style.marginTop = '20px'
  root.appendChild(backBtn)

  // ── Behaviour ────────────────────────────────────────────────────────────

  let errorTimer: ReturnType<typeof setTimeout> | null = null
  function showError(message: string): void {
    errorBox.textContent = message
    errorBox.style.opacity = '1'
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = setTimeout(() => (errorBox.style.opacity = '0'), 4000)
  }

  function setBusy(busy: boolean): void {
    createBtn.disabled = busy
    joinBtn.disabled = busy || codeInput.value.length !== LOBBY_CODE_LENGTH
  }

  async function ensureConnected(): Promise<boolean> {
    if (net.isConnected()) return true
    status.textContent = 'Connecting…'
    try {
      await net.connect()
      status.textContent = 'Connected'
      return true
    } catch {
      status.textContent = 'Offline'
      showError('Could not reach the game server')
      return false
    }
  }

  createBtn.addEventListener('click', async () => {
    setBusy(true)
    if (await ensureConnected()) net.createLobby(getPlayerName())
    setBusy(false)
  })

  joinBtn.addEventListener('click', async () => {
    const code = codeInput.value
    if (code.length !== LOBBY_CODE_LENGTH) return
    setBusy(true)
    if (await ensureConnected()) net.joinLobby(code, getPlayerName())
    setBusy(false)
  })

  readyBtn.addEventListener('click', () => {
    const me = net.me()
    if (!me) return
    net.setReady(!me.ready)
  })

  startBtn.addEventListener('click', () => net.startMatch())

  backBtn.addEventListener('click', () => {
    if (net.lobby) net.leaveLobby()
    net.disconnect()
    showChoice()
    onBack()
  })

  function showChoice(): void {
    choicePanel.style.display = ''
    lobbyPanel.style.display = 'none'
    codeInput.value = ''
    joinBtn.disabled = true
  }

  /** Render a lobby snapshot. The server is the only source of truth here. */
  function render(lobby: LobbyView): void {
    choicePanel.style.display = 'none'
    lobbyPanel.style.display = ''

    codeDisplay.textContent = lobby.code

    const me = net.me()
    playerList.replaceChildren()

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const player = lobby.players.find(p => p.slot === slot)
      const row = document.createElement('div')
      row.className = 'lobby-player'

      if (!player) {
        row.classList.add('is-empty')
        row.innerHTML = `<span class="lp-dot"></span><span class="lp-name">Waiting…</span>`
        playerList.appendChild(row)
        continue
      }

      if (player.ready) row.classList.add('is-ready')
      if (!player.connected) row.classList.add('is-gone')

      const dot = document.createElement('span')
      dot.className = 'lp-dot'
      dot.style.background = slotColor(player.slot)

      const name = document.createElement('span')
      name.className = 'lp-name'
      // textContent, never innerHTML — names come from other players.
      name.textContent = player.name
      if (player.id === me?.id) name.textContent += ' (you)'

      const tags = document.createElement('span')
      tags.className = 'lp-tags'
      if (player.isHost) {
        const host = document.createElement('span')
        host.className = 'lp-tag lp-host'
        host.textContent = 'HOST'
        tags.appendChild(host)
      }
      if (lobby.round > 1 || player.wins > 0) {
        const wins = document.createElement('span')
        wins.className = 'lp-tag lp-wins'
        wins.textContent = `${player.wins} W`
        tags.appendChild(wins)
      }

      const state = document.createElement('span')
      state.className = 'lp-state'
      state.textContent = !player.connected ? '⚠︎' : player.ready ? '✓' : '…'

      row.append(dot, name, tags, state)
      playerList.appendChild(row)
    }

    blockedNote.textContent = lobby.startBlockedReason ?? 'Everyone is ready'
    blockedNote.classList.toggle('is-good', lobby.canStart)

    readyBtn.textContent = me?.ready ? 'NOT READY' : 'READY'
    readyBtn.classList.toggle('is-active', Boolean(me?.ready))

    // Only the host can start, and only once every rule passes.
    const amHost = Boolean(me?.isHost)
    startBtn.style.display = amHost ? '' : 'none'
    startBtn.disabled = !lobby.canStart
    startBtn.classList.toggle('is-armed', lobby.canStart)

    const roundLabel = lobby.round > 1 ? ` · Round ${lobby.round}` : ''
    status.textContent = `Best of ${lobby.config.rounds} · ${lobby.config.lives} lives${roundLabel}`
  }

  net.setHandlers({
    onJoined: (_id, lobby) => render(lobby),
    onLobby: lobby => render(lobby),
    onError: msg => showError(msg.message),
    onMatchStart: msg => {
      render(msg.lobby)
      blockedNote.textContent = `Round ${msg.round} starting…`
      blockedNote.classList.add('is-good')
      onMatchStart?.({
        seed: msg.seed,
        round: msg.round,
        hostId: msg.hostId,
        youAreHost: msg.hostId === net.youId,
      })
    },
    onRoundOver: msg => {
      render(msg.lobby)
      if (msg.matchWinnerId) {
        const winner = msg.lobby.players.find(p => p.id === msg.matchWinnerId)
        blockedNote.textContent = winner ? `${winner.name} wins the match!` : 'Match over'
        blockedNote.classList.add('is-good')
      }
    },
    onState: state => {
      if (state === 'closed') {
        status.textContent = 'Disconnected'
        showChoice()
      }
    },
  })

  ;(root as any).showChoice = showChoice
  return root
}
