import { isMobile, isIOS } from './device'
import { MAX_PLAYER_NAME_LENGTH } from './settings'

export type GameMode = '1v1' | '1v2' | '1v3' | 'pvp' | 'time-attack' | 'survival'

export interface MenuOptions {
  onStartGame: (mode: GameMode) => void
  /** Opens the online lobby. */
  onPlayOnline: () => void
  /** Current state of the Extended Power-Ups setting. */
  getExtendedPowerUps: () => boolean
  /** Persist a new Extended Power-Ups state. */
  onToggleExtendedPowerUps: (enabled: boolean) => void
  /** Current player name, shown on the HUD and to other players online. */
  getPlayerName: () => string
  /** Persist a new player name. Returns the value that was actually stored. */
  onApplyPlayerName: (name: string) => string
}

// Countdown before game starts
export function showCountdown(onComplete: () => void, onTick?: () => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'countdown-overlay'
  overlay.id = 'countdown-overlay'
  document.body.appendChild(overlay)
  
  const countdownText = document.createElement('div')
  countdownText.className = 'countdown-number'
  overlay.appendChild(countdownText)
  
  let count = 3
  
  const updateCountdown = () => {
    if (count > 0) {
      countdownText.textContent = count.toString()
      countdownText.className = 'countdown-number'
      // Reset animation
      countdownText.style.animation = 'none'
      countdownText.offsetHeight // Trigger reflow
      countdownText.style.animation = ''
      // Play tick sound
      if (onTick) onTick()
      count--
      setTimeout(updateCountdown, 1000)
    } else {
      countdownText.textContent = 'GO!'
      countdownText.className = 'countdown-go'
      setTimeout(() => {
        overlay.remove()
        onComplete()
      }, 500)
    }
  }
  
  updateCountdown()
}

/**
 * Overlay asking whether a versus match is on one keyboard or over the network.
 * Dismissable, so picking PvP by accident is not a dead end.
 */
function showVersusChoice(menuDiv: HTMLDivElement, options: MenuOptions): void {
  const existing = document.getElementById('versus-choice')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'versus-choice'
  overlay.className = 'versus-choice-overlay'

  const panel = document.createElement('div')
  panel.className = 'versus-choice-panel'

  const heading = document.createElement('h2')
  heading.textContent = '👥 PLAYER VS PLAYER'
  heading.className = 'versus-choice-title'
  panel.appendChild(heading)

  const choices: Array<{ label: string; hint: string; onPick: () => void }> = [
    {
      label: '🎮 Local',
      hint: 'Two players, one keyboard — WASD and Arrow keys',
      onPick: () => {
        overlay.remove()
        menuDiv.style.display = 'none'
        options.onStartGame('pvp')
      },
    },
    {
      label: '🌐 Online',
      hint: 'Up to 4 players, join with a 6-digit code',
      onPick: () => {
        overlay.remove()
        menuDiv.style.display = 'none'
        options.onPlayOnline()
      },
    },
  ]

  for (const choice of choices) {
    const button = document.createElement('button')
    button.className = 'menu-button versus-choice-button'

    const label = document.createElement('span')
    label.className = 'vc-label'
    label.textContent = choice.label

    const hint = document.createElement('span')
    hint.className = 'vc-hint'
    hint.textContent = choice.hint

    button.append(label, hint)
    button.addEventListener('click', choice.onPick)
    panel.appendChild(button)
  }

  const cancel = document.createElement('button')
  cancel.className = 'menu-button menu-button-danger versus-choice-cancel'
  cancel.textContent = '← BACK'
  cancel.addEventListener('click', () => overlay.remove())
  panel.appendChild(cancel)

  // Clicking the backdrop or pressing Escape also dismisses.
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove()
  })
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      overlay.remove()
    }
  }
  window.addEventListener('keydown', onKey, true)
  const observer = new MutationObserver(() => {
    if (!overlay.isConnected) {
      window.removeEventListener('keydown', onKey, true)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true })

  overlay.appendChild(panel)
  document.body.appendChild(overlay)
}

export function createMainMenu(options: MenuOptions): HTMLDivElement {
  const menuDiv = document.createElement('div')
  menuDiv.id = 'main-menu'
  menuDiv.className = 'menu-container'
  menuDiv.style.position = 'absolute'
  menuDiv.style.top = '0'
  menuDiv.style.left = '0'
  menuDiv.style.width = '100vw'
  menuDiv.style.height = '100vh'
  menuDiv.style.display = 'flex'
  menuDiv.style.flexDirection = 'column'
  // flex-start rather than centre: a centred flex column clips its own top once
  // the content outgrows the viewport, which would put the title out of reach on
  // the small screens that actually need to scroll. `margin: auto 0` on the
  // content instead centres it whenever there *is* room to spare.
  menuDiv.style.justifyContent = 'flex-start'
  menuDiv.style.alignItems = 'center'
  // Spacing is deliberately tight. Everything below has to clear a laptop
  // viewport — roughly 700px once browser chrome is subtracted — without a
  // scrollbar; the media queries in style.css take over below that.
  menuDiv.style.paddingTop = '20px'
  menuDiv.style.paddingBottom = '20px'
  menuDiv.style.overflowY = 'auto' // Only actually scrolls on short screens
  menuDiv.style.boxSizing = 'border-box'

  menuDiv.style.zIndex = '2000'
  menuDiv.style.fontFamily = "'Russo One', sans-serif"
  menuDiv.style.color = 'white'

  const title = document.createElement('h1')
  title.innerHTML = "💣 WHAT'A BOMB! 💣"
  title.className = 'menu-title'
  // Scales with the window for the same reason the buttons do.
  title.style.fontSize = 'clamp(26px, 4.4vh, 44px)'
  title.style.marginTop = 'auto'
  title.style.marginBottom = 'clamp(8px, 1.4vh, 16px)'
  menuDiv.appendChild(title)

  // Subtitle
  const subtitle = document.createElement('p')
  subtitle.textContent = 'By Fredrik, V10.1.0'
  subtitle.style.fontSize = 'clamp(12px, 1.6vh, 16px)'
  subtitle.style.color = '#aaa'
  subtitle.style.marginTop = '0'
  subtitle.style.marginBottom = 'clamp(8px, 1.5vh, 16px)'
  subtitle.style.letterSpacing = '2px'
  menuDiv.appendChild(subtitle)

  // Subtitle scaling response logic handled in style.css media queries now
  
  const allModes: Array<{ mode: GameMode; label: string; icon: string }> = [
    { mode: '1v1', label: 'Player vs 1 AI', icon: '🤖' },
    { mode: '1v2', label: 'Player vs 2 AI', icon: '🤖🤖' },
    { mode: '1v3', label: 'Player vs 3 AI', icon: '🤖🤖🤖' },
    { mode: 'pvp', label: 'Player vs Player', icon: '👥' },
    { mode: 'survival', label: 'Survival Mode', icon: '🌊' },
    { mode: 'time-attack', label: 'Time Attack', icon: '⏱️' },
  ]

  // Re-check mobile on menu creation to be safe.
  // Only local PvP is hidden on touch devices — it needs two keyboards.
  const currentIsMobile = isMobile()

  const modes = currentIsMobile
    ? allModes.filter(m => m.mode !== 'pvp')
    : allModes

  // Button container for game modes
  const modeContainer = document.createElement('div')
  modeContainer.className = 'mode-buttons'
  modeContainer.style.display = 'flex'
  modeContainer.style.flexDirection = 'column'
  modeContainer.style.alignItems = 'center'
  modeContainer.style.gap = '4px'

  modes.forEach(({ mode, label, icon }) => {
    const button = document.createElement('button')
    button.innerHTML = `${icon} ${label}`
    button.className = 'menu-button'
    // Size, padding and width are set by #main-menu .menu-button in style.css —
    // the base .menu-button rule declares those with !important, so setting them
    // inline here has no effect.
    button.style.cursor = 'pointer'
    button.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
    button.style.color = 'white'
    button.style.border = '3px solid #2E7D32'
    button.style.borderRadius = '8px'
    button.style.fontFamily = "'Russo One', sans-serif"
    button.style.textTransform = 'uppercase'
    button.style.letterSpacing = '1px'
    button.style.transition = 'all 0.2s ease'
    button.style.boxShadow = '0 4px 0 #1B5E20, 0 6px 10px rgba(0,0,0,0.3)'
    button.style.position = 'relative'

    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-2px)'
      button.style.boxShadow = '0 6px 0 #1B5E20, 0 8px 15px rgba(0,0,0,0.4)'
      button.style.background = 'linear-gradient(180deg, #66BB6A 0%, #4CAF50 100%)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
      button.style.boxShadow = '0 4px 0 #1B5E20, 0 6px 10px rgba(0,0,0,0.3)'
      button.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
    })
    button.addEventListener('mousedown', () => {
      button.style.transform = 'translateY(2px)'
      button.style.boxShadow = '0 2px 0 #1B5E20, 0 3px 5px rgba(0,0,0,0.3)'
    })
    button.addEventListener('mouseup', () => {
      button.style.transform = 'translateY(-2px)'
      button.style.boxShadow = '0 6px 0 #1B5E20, 0 8px 15px rgba(0,0,0,0.4)'
    })
    button.addEventListener('click', () => {
      // Player vs Player is ambiguous: same keyboard, or over the network?
      // Ask rather than guessing.
      if (mode === 'pvp') {
        showVersusChoice(menuDiv, options)
        return
      }
      menuDiv.style.display = 'none'
      options.onStartGame(mode)
    })

    modeContainer.appendChild(button)
  })
  
  menuDiv.appendChild(modeContainer)

  // Add Settings, Statistics, Achievements, Tutorial, and Map Selection buttons
  const buttonContainer = document.createElement('div')
  buttonContainer.style.display = 'flex'
  buttonContainer.style.gap = '12px'
  // Tighter than the gap above the power-up toggle, so the toggle reads as
  // part of the match setup rather than as one of the utility buttons.
  buttonContainer.style.marginTop = '14px'
  buttonContainer.style.marginBottom = 'auto'
  buttonContainer.style.flexWrap = 'wrap'
  buttonContainer.style.justifyContent = 'center'
  // Wide enough to hold the seven utility buttons in two rows rather than three.
  buttonContainer.style.maxWidth = 'min(880px, 94vw)'

  // Fullscreen is offered everywhere except iOS, where Safari only exposes the
  // Fullscreen API for video/audio elements.
  const buttons = [
    { id: 'settings-button', text: '⚙️ Settings' },
    { id: 'stats-button', text: '📊 Stats' },
    { id: 'achievements-button', text: '🏆 Achievements' },
    { id: 'tutorial-button', text: '📖 How to Play' },
    { id: 'map-selection-button', text: '🗺️ Maps' },
    { id: 'online-button', text: '🌐 Play Online' },
    ...(isIOS() ? [] : [{ id: 'fullscreen-button', text: '⛶ Fullscreen' }]),
  ]

  buttons.forEach(btn => {
    const button = document.createElement('button')
    button.textContent = btn.text
    button.className = 'menu-button menu-button-secondary'
    button.style.fontSize = '14px'
    button.style.padding = '10px 18px'
    button.style.cursor = 'pointer'
    button.style.background = 'linear-gradient(180deg, #546E7A 0%, #37474F 100%)'
    button.style.color = 'white'
    button.style.border = '2px solid #263238'
    button.style.borderRadius = '6px'
    button.style.fontFamily = "'Russo One', sans-serif"
    button.style.transition = 'all 0.2s ease'
    button.style.boxShadow = '0 3px 0 #1a252a, 0 4px 8px rgba(0,0,0,0.3)'
    button.id = btn.id
    
    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-2px)'
      button.style.background = 'linear-gradient(180deg, #607D8B 0%, #546E7A 100%)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
      button.style.background = 'linear-gradient(180deg, #546E7A 0%, #37474F 100%)'
    })
    
    buttonContainer.appendChild(button)
  })

  // Player name. It used to live in Settings, but it is a pre-match choice like
  // the power-up toggle below it — and online it is how everyone else sees you,
  // so it belongs where you pick a mode. Applied explicitly rather than on every
  // keystroke, so a half-typed name never reaches the lobby.
  const nameRow = document.createElement('div')
  nameRow.style.display = 'flex'
  nameRow.style.justifyContent = 'center'
  nameRow.style.marginTop = '16px'

  const nameBox = document.createElement('div')
  nameBox.className = 'name-box'
  nameBox.id = 'player-name-box'

  const nameLabel = document.createElement('span')
  nameLabel.className = 'nb-label'
  nameLabel.textContent = '🙋 Name'

  const nameInput = document.createElement('input')
  nameInput.className = 'nb-input'
  nameInput.id = 'player-name-input'
  nameInput.type = 'text'
  nameInput.maxLength = MAX_PLAYER_NAME_LENGTH
  nameInput.autocomplete = 'off'
  nameInput.spellcheck = false
  nameInput.value = options.getPlayerName()
  nameInput.setAttribute('aria-label', 'Player name')
  // The game listens for keys on window; keep typing out of the player controls.
  nameInput.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') applyName()
  })
  nameInput.addEventListener('keyup', e => e.stopPropagation())

  const applyButton = document.createElement('button')
  applyButton.className = 'nb-apply'
  applyButton.id = 'player-name-apply'
  applyButton.textContent = 'APPLY'

  let applyResetTimer: ReturnType<typeof setTimeout> | null = null
  function applyName(): void {
    const stored = options.onApplyPlayerName(nameInput.value)
    // Snap the field to what was actually saved, so a trimmed or empty entry
    // does not leave the box disagreeing with the game.
    nameInput.value = stored
    nameInput.blur()
    applyButton.textContent = 'SAVED'
    nameBox.classList.add('is-saved')
    if (applyResetTimer) clearTimeout(applyResetTimer)
    applyResetTimer = setTimeout(() => {
      applyButton.textContent = 'APPLY'
      nameBox.classList.remove('is-saved')
    }, 1400)
  }
  applyButton.addEventListener('click', applyName)

  nameBox.append(nameLabel, nameInput, applyButton)
  nameRow.appendChild(nameBox)
  menuDiv.appendChild(nameRow)

  // Keep in sync if the name is changed elsewhere (or reloaded from storage).
  ;(menuDiv as any).refreshPlayerName = () => {
    if (document.activeElement === nameInput) return // don't fight a live edit
    nameInput.value = options.getPlayerName()
  }

  // Extended Power-Ups quick toggle — the same setting as in the Settings
  // screen, surfaced here because it changes how a whole match plays.
  // Appended before the secondary buttons so it sits directly under the game
  // modes it affects.
  const powerUpToggleRow = document.createElement('div')
  powerUpToggleRow.style.display = 'flex'
  powerUpToggleRow.style.justifyContent = 'center'
  // Tight against the name box above — the two read as one pre-match strip.
  powerUpToggleRow.style.marginTop = '10px'

  const powerUpToggle = document.createElement('button')
  powerUpToggle.id = 'extended-powerups-toggle'
  powerUpToggle.className = 'powerup-toggle'
  powerUpToggle.title = 'Adds Shield, Pierce, Ghost, Power Bomb and Line Bomb to the drop pool'
  // The five extra power-ups are shown inline: full colour when enabled,
  // greyed out when not, so the state is readable without parsing the label.
  powerUpToggle.innerHTML = `
    <span class="pt-label">🎲 Extended Power-Ups</span>
    <span class="pt-icons">🛡️🔥👻☢️🧨</span>
    <span class="pt-state"></span>
  `
  const powerUpState = powerUpToggle.querySelector('.pt-state') as HTMLElement

  const paintPowerUpToggle = (enabled: boolean) => {
    powerUpToggle.classList.toggle('is-on', enabled)
    powerUpToggle.classList.toggle('is-off', !enabled)
    powerUpState.textContent = enabled ? 'ON' : 'OFF'
    powerUpToggle.setAttribute('aria-pressed', String(enabled))
  }
  paintPowerUpToggle(options.getExtendedPowerUps())

  powerUpToggle.addEventListener('click', () => {
    const next = !options.getExtendedPowerUps()
    options.onToggleExtendedPowerUps(next)
    paintPowerUpToggle(next)
  })
  // Keep in sync when the setting is changed from the Settings screen instead.
  ;(menuDiv as any).refreshExtendedPowerUps = () => paintPowerUpToggle(options.getExtendedPowerUps())

  powerUpToggleRow.appendChild(powerUpToggle)
  menuDiv.appendChild(powerUpToggleRow)
  menuDiv.appendChild(buttonContainer)
  
  // Controls hint removed per user request

  return menuDiv
}

export interface PauseMenuOptions {
  onResume: () => void
  onQuit: () => void
  /**
   * Volume controls to show behind the Audio button. Built by the caller so
   * this module stays free of settings plumbing; the panel is refreshed each
   * time it is opened because the same controls exist on the Settings screen.
   */
  audioPanel?: HTMLElement & { refresh?: () => void }
}

export function createPauseMenu(options: PauseMenuOptions): HTMLDivElement {
  const { onResume, onQuit, audioPanel } = options
  const pauseDiv = document.createElement('div')
  pauseDiv.id = 'pause-menu'
  pauseDiv.className = 'menu-container'
  pauseDiv.style.position = 'absolute'
  pauseDiv.style.top = '0'
  pauseDiv.style.left = '0'
  pauseDiv.style.width = '100vw'
  pauseDiv.style.height = '100vh'
  pauseDiv.style.background = 'rgba(0, 0, 0, 0.85)'
  pauseDiv.style.display = 'none'
  pauseDiv.style.flexDirection = 'column'
  pauseDiv.style.justifyContent = 'center'
  pauseDiv.style.alignItems = 'center'
  pauseDiv.style.zIndex = '1500'
  pauseDiv.style.fontFamily = "'Russo One', sans-serif"
  pauseDiv.style.color = 'white'
  pauseDiv.style.backdropFilter = 'blur(5px)'
  // The audio panel can push past the viewport on a short screen; scroll rather
  // than clipping the Quit button.
  pauseDiv.style.overflowY = 'auto'
  pauseDiv.style.padding = '20px'
  pauseDiv.style.boxSizing = 'border-box'

  const title = document.createElement('h2')
  title.textContent = '⏸️ PAUSED'
  title.className = 'menu-title'
  title.style.fontSize = '48px'
  title.style.marginBottom = '40px'
  title.style.color = '#ff6600'
  title.style.textShadow = '0 0 10px #ff6600, 0 0 20px #ff6600, 4px 4px 0px #000'
  pauseDiv.appendChild(title)

  const resumeButton = document.createElement('button')
  resumeButton.innerHTML = '▶️ Resume'
  resumeButton.className = 'menu-button'
  resumeButton.style.fontSize = '20px'
  resumeButton.style.padding = '15px 50px'
  resumeButton.style.margin = '10px'
  resumeButton.style.cursor = 'pointer'
  resumeButton.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
  resumeButton.style.color = 'white'
  resumeButton.style.border = '3px solid #2E7D32'
  resumeButton.style.borderRadius = '8px'
  resumeButton.style.fontFamily = "'Russo One', sans-serif"
  resumeButton.style.boxShadow = '0 4px 0 #1B5E20, 0 6px 10px rgba(0,0,0,0.3)'
  resumeButton.style.transition = 'all 0.2s ease'
  
  resumeButton.addEventListener('mouseenter', () => {
    resumeButton.style.transform = 'translateY(-2px)'
    resumeButton.style.background = 'linear-gradient(180deg, #66BB6A 0%, #4CAF50 100%)'
  })
  resumeButton.addEventListener('mouseleave', () => {
    resumeButton.style.transform = 'translateY(0)'
    resumeButton.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
  })
  resumeButton.addEventListener('click', onResume)
  pauseDiv.appendChild(resumeButton)

  // Audio, in reach without abandoning the match. Only the volumes are exposed:
  // the rest of Settings changes how a game plays and would be unfair to alter
  // halfway through one.
  if (audioPanel) {
    const audioButton = document.createElement('button')
    audioButton.id = 'pause-audio-button'
    audioButton.innerHTML = '🔊 Audio'
    audioButton.className = 'menu-button'
    audioButton.style.fontSize = '20px'
    audioButton.style.padding = '15px 50px'
    audioButton.style.margin = '10px'
    audioButton.style.cursor = 'pointer'
    audioButton.style.background = 'linear-gradient(180deg, #546E7A 0%, #37474F 100%)'
    audioButton.style.color = 'white'
    audioButton.style.border = '3px solid #263238'
    audioButton.style.borderRadius = '8px'
    audioButton.style.fontFamily = "'Russo One', sans-serif"
    audioButton.style.boxShadow = '0 4px 0 #1a252a, 0 6px 10px rgba(0,0,0,0.3)'
    audioButton.style.transition = 'all 0.2s ease'
    audioButton.addEventListener('mouseenter', () => {
      audioButton.style.transform = 'translateY(-2px)'
      audioButton.style.background = 'linear-gradient(180deg, #607D8B 0%, #546E7A 100%)'
    })
    audioButton.addEventListener('mouseleave', () => {
      audioButton.style.transform = 'translateY(0)'
      audioButton.style.background = 'linear-gradient(180deg, #546E7A 0%, #37474F 100%)'
    })
    pauseDiv.appendChild(audioButton)

    const audioWrap = document.createElement('div')
    audioWrap.className = 'pause-audio-panel'
    audioWrap.style.display = 'none'
    audioWrap.appendChild(audioPanel)
    pauseDiv.appendChild(audioWrap)

    audioButton.addEventListener('click', () => {
      const opening = audioWrap.style.display === 'none'
      audioWrap.style.display = opening ? 'block' : 'none'
      audioButton.innerHTML = opening ? '🔊 Audio ▲' : '🔊 Audio'
      if (opening) audioPanel.refresh?.()
    })

    // Always start collapsed, so pausing goes straight back to Resume.
    ;(pauseDiv as any).collapseAudio = () => {
      audioWrap.style.display = 'none'
      audioButton.innerHTML = '🔊 Audio'
    }
  }

  const quitButton = document.createElement('button')
  quitButton.innerHTML = '🚪 Quit to Menu'
  quitButton.className = 'menu-button menu-button-danger'
  quitButton.style.fontSize = '20px'
  quitButton.style.padding = '15px 50px'
  quitButton.style.margin = '10px'
  quitButton.style.cursor = 'pointer'
  quitButton.style.background = 'linear-gradient(180deg, #f44336 0%, #c62828 100%)'
  quitButton.style.color = 'white'
  quitButton.style.border = '3px solid #b71c1c'
  quitButton.style.borderRadius = '8px'
  quitButton.style.fontFamily = "'Russo One', sans-serif"
  quitButton.style.boxShadow = '0 4px 0 #7f0000, 0 6px 10px rgba(0,0,0,0.3)'
  quitButton.style.transition = 'all 0.2s ease'
  
  quitButton.addEventListener('mouseenter', () => {
    quitButton.style.transform = 'translateY(-2px)'
    quitButton.style.background = 'linear-gradient(180deg, #ef5350 0%, #f44336 100%)'
  })
  quitButton.addEventListener('mouseleave', () => {
    quitButton.style.transform = 'translateY(0)'
    quitButton.style.background = 'linear-gradient(180deg, #f44336 0%, #c62828 100%)'
  })
  quitButton.addEventListener('click', onQuit)
  pauseDiv.appendChild(quitButton)

  return pauseDiv
}
