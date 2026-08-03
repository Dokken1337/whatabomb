import {
  SettingsManager,
  PLAYER_COLORS,
  CHARACTER_SHAPES,
} from './settings'
import { SoundManager } from './sound-manager'
import { setHapticsEnabled } from './device'

/** A settings section that can re-read the stored value on demand. */
type RefreshableSection = HTMLDivElement & { refresh?: () => void }

/**
 * The three volume sliders plus the master mute, as one self-contained block.
 *
 * Lives here rather than inline in the settings screen because the in-game
 * pause menu shows the very same controls — audio is the one thing worth
 * changing without abandoning a match.
 */
export function createAudioSettings(
  settingsManager: SettingsManager,
  getSoundManager: () => SoundManager | null,
): RefreshableSection {
  const section = document.createElement('div') as RefreshableSection
  const settings = settingsManager.getSettings()

  const musicSection = createSliderSetting('🎵 Music Volume', settings.musicVolume, value => {
    settingsManager.setMusicVolume(value)
    getSoundManager()?.setMusicVolume(value)
  })
  section.appendChild(musicSection)

  const sfxSection = createSliderSetting('🔊 Sound Effects', settings.sfxVolume, value => {
    settingsManager.setSFXVolume(value)
    getSoundManager()?.setSFXVolume(value)
  })
  section.appendChild(sfxSection)

  const uiSection = createSliderSetting('🖱️ Interface Sounds', settings.uiVolume, value => {
    settingsManager.setUIVolume(value)
    getSoundManager()?.setUIVolume(value)
  })
  section.appendChild(uiSection)

  const uiDesc = document.createElement('div')
  uiDesc.style.fontSize = '11px'
  uiDesc.style.color = '#888'
  uiDesc.style.marginTop = '-18px'
  uiDesc.style.marginBottom = '20px'
  uiDesc.style.lineHeight = '1.5'
  uiDesc.textContent = 'Menu clicks and button hovers, separate from in-game effects.'
  section.appendChild(uiDesc)

  // Master mute. Deliberately a separate switch rather than dragging every
  // slider to zero, so the previous mix comes back untouched when it is lifted.
  const muteRow = document.createElement('div')
  muteRow.style.marginBottom = '25px'

  const muteButton = document.createElement('button')
  muteButton.style.width = '100%'
  muteButton.style.padding = '14px'
  muteButton.style.fontFamily = "'Press Start 2P', monospace"
  muteButton.style.fontSize = '11px'
  muteButton.style.cursor = 'pointer'
  muteButton.style.borderRadius = '8px'
  muteButton.style.transition = 'all 0.2s ease'

  let muted = settings.muteAll

  const paintMute = () => {
    muteButton.textContent = muted ? '🔇 ALL SOUND MUTED' : '🔈 MUTE ALL SOUND'
    muteButton.setAttribute('aria-pressed', String(muted))
    if (muted) {
      muteButton.style.background = 'linear-gradient(180deg, #ef4444 0%, #b91c1c 100%)'
      muteButton.style.border = '3px solid #7f1d1d'
      muteButton.style.color = '#fff'
      muteButton.style.boxShadow = '0 0 15px rgba(239,68,68,0.5), 0 4px 0 #7f1d1d'
    } else {
      muteButton.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
      muteButton.style.border = '3px solid #4b5563'
      muteButton.style.color = '#9ca3af'
      muteButton.style.boxShadow = '0 4px 0 #1f2937'
    }
  }
  paintMute()

  muteButton.addEventListener('click', () => {
    muted = !muted
    settingsManager.setMuteAll(muted)
    getSoundManager()?.setMuted(muted)
    paintMute()
  })

  muteRow.appendChild(muteButton)
  section.appendChild(muteRow)

  // The same controls exist on two screens, so re-read on open.
  section.refresh = () => {
    const current = settingsManager.getSettings()
    ;(musicSection as any).setValue?.(current.musicVolume)
    ;(sfxSection as any).setValue?.(current.sfxVolume)
    ;(uiSection as any).setValue?.(current.uiVolume)
    muted = current.muteAll
    paintMute()
  }

  return section
}

export function createSettingsMenu(
  settingsManager: SettingsManager,
  getSoundManager: () => SoundManager | null,
  onClose: () => void
): HTMLDivElement {
  const settingsDiv = document.createElement('div')
  settingsDiv.id = 'settings-menu'
  settingsDiv.className = 'menu-container'
  settingsDiv.style.position = 'absolute'
  settingsDiv.style.top = '0'
  settingsDiv.style.left = '0'
  settingsDiv.style.width = '100vw'
  settingsDiv.style.height = '100vh'
  settingsDiv.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)'
  settingsDiv.style.display = 'none'
  settingsDiv.style.flexDirection = 'column'
  settingsDiv.style.justifyContent = 'flex-start'
  settingsDiv.style.alignItems = 'center'
  settingsDiv.style.zIndex = '2500'
  settingsDiv.style.fontFamily = "'Russo One', sans-serif"
  settingsDiv.style.color = 'white'
  settingsDiv.style.overflowY = 'auto'
  settingsDiv.style.padding = '20px'

  const title = document.createElement('h1')
  title.textContent = '⚙️ Settings'
  title.className = 'menu-title'
  title.style.fontSize = '36px'
  title.style.marginBottom = '30px'
  title.style.color = '#ff6600'
  title.style.textShadow = '0 0 10px #ff6600, 0 0 20px #ff6600, 3px 3px 0px #000'
  settingsDiv.appendChild(title)

  // One column, scrolled. There is more here than fits on any screen, and
  // splitting it into columns made it harder to read rather than easier.
  const settingsContainer = document.createElement('div')
  settingsContainer.style.maxWidth = '500px'
  settingsContainer.style.width = '90%'
  settingsContainer.style.background = 'rgba(0,0,0,0.5)'
  settingsContainer.style.padding = '25px'
  settingsContainer.style.borderRadius = '15px'
  settingsContainer.style.border = '2px solid rgba(255,255,255,0.1)'

  const settings = settingsManager.getSettings()

  // Volumes and the master mute. The player name used to live here too; it is
  // on the main menu now, next to the other pre-match choices.
  const audioSection = createAudioSettings(settingsManager, getSoundManager)
  settingsContainer.appendChild(audioSection)

  // Screen Shake Toggle
  const shakeSection = createToggleSetting(
    'Screen Shake',
    settings.screenShake,
    (value) => {
      settingsManager.setScreenShake(value)
    }
  )
  settingsContainer.appendChild(shakeSection)

  // Particles Toggle
  const particlesSection = createToggleSetting(
    'Particle Effects',
    settings.particles,
    (value) => {
      settingsManager.setParticles(value)
    }
  )
  settingsContainer.appendChild(particlesSection)

  // Haptic Feedback Toggle
  const hapticsSection = createToggleSetting(
    '📳 Haptic Feedback',
    settings.haptics,
    (value) => {
      settingsManager.setHaptics(value)
      setHapticsEnabled(value)
    }
  )
  settingsContainer.appendChild(hapticsSection)

  // Extended Power-Ups Toggle
  const extendedPowerUpsSection = createToggleSetting(
    '🎲 Extended Power-Ups',
    settings.extendedPowerUps,
    (value) => {
      settingsManager.setExtendedPowerUps(value)
    }
  )
  settingsContainer.appendChild(extendedPowerUpsSection)

  // Add description below the toggle
  const extendedPowerUpsDesc = document.createElement('div')
  extendedPowerUpsDesc.style.fontSize = '11px'
  extendedPowerUpsDesc.style.color = '#888'
  extendedPowerUpsDesc.style.marginTop = '-18px'
  extendedPowerUpsDesc.style.marginBottom = '20px'
  extendedPowerUpsDesc.style.lineHeight = '1.5'
  extendedPowerUpsDesc.innerHTML = 'Adds 5 new power-ups: 🛡️ Shield, 🔥 Pierce, 👻 Ghost, ☢️ Power Bomb, 🧨 Line Bomb'
  settingsContainer.appendChild(extendedPowerUpsDesc)

  // On-Screen Controls (touch pad works on desktop too, driven by the mouse)
  const onScreenControlsSection = createSegmentedSetting(
    '🕹️ On-Screen Controls',
    [
      { label: 'AUTO', value: 'auto' },
      { label: 'ON', value: 'on' },
      { label: 'OFF', value: 'off' },
    ],
    settings.onScreenControls,
    (value) => {
      settingsManager.setOnScreenControls(value as any)
    }
  )
  settingsContainer.appendChild(onScreenControlsSection)

  const onScreenControlsDesc = document.createElement('div')
  onScreenControlsDesc.style.fontSize = '11px'
  onScreenControlsDesc.style.color = '#888'
  onScreenControlsDesc.style.marginTop = '-18px'
  onScreenControlsDesc.style.marginBottom = '20px'
  onScreenControlsDesc.style.lineHeight = '1.5'
  onScreenControlsDesc.textContent = 'AUTO shows the D-pad on touch devices only. ON keeps it on desktop too (click or drag with the mouse). Applies to the next game.'
  settingsContainer.appendChild(onScreenControlsDesc)

  // Difficulty Selection
  const difficultySection = createDifficultySetting(
    settings.difficulty,
    (value) => {
      settingsManager.setDifficulty(value)
    }
  )
  settingsContainer.appendChild(difficultySection)

  // Match length (rounds) for the versus modes
  const roundsSection = createSegmentedSetting(
    '🏁 Match Length',
    [
      { label: '1 ROUND', value: '1' },
      { label: 'BEST OF 3', value: '3' },
      { label: 'BEST OF 5', value: '5' },
    ],
    String(settings.rounds),
    (value) => {
      settingsManager.setRounds(Number(value) as 1 | 3 | 5)
    }
  )
  settingsContainer.appendChild(roundsSection)

  // Character Shape Selection
  const characterShapeSection = createDropdownSetting(
    'Character Shape',
    CHARACTER_SHAPES,
    settings.characterShape || 'sphere',
    (value) => {
      settingsManager.setCharacterShape(value as any)
    }
  )
  settingsContainer.appendChild(characterShapeSection)

  // Player 1 Color
  const player1ColorSection = createColorSetting(
    'Player 1 Color',
    settings.player1Color,
    (value) => {
      settingsManager.setPlayer1Color(value)
    }
  )
  settingsContainer.appendChild(player1ColorSection)

  // Player 2 Color
  const player2ColorSection = createColorSetting(
    'Player 2 Color',
    settings.player2Color,
    (value) => {
      settingsManager.setPlayer2Color(value)
    }
  )
  settingsContainer.appendChild(player2ColorSection)

  settingsDiv.appendChild(settingsContainer)

  // Close Button - styled to match new theme
  const closeButton = document.createElement('button')
  closeButton.textContent = '✓ SAVE & CLOSE'
  closeButton.style.fontFamily = "'Press Start 2P', monospace"
  closeButton.style.fontSize = '14px'
  closeButton.style.padding = '15px 40px'
  closeButton.style.marginTop = '30px'
  closeButton.style.flexShrink = '0'
  closeButton.style.cursor = 'pointer'
  closeButton.style.background = 'linear-gradient(180deg, #4ade80 0%, #22c55e 50%, #16a34a 100%)'
  closeButton.style.color = '#000'
  closeButton.style.border = '3px solid #166534'
  closeButton.style.borderRadius = '8px'
  closeButton.style.fontWeight = 'bold'
  closeButton.style.textShadow = '1px 1px 0 rgba(255,255,255,0.3)'
  closeButton.style.boxShadow = '0 4px 0 #166534, 0 6px 10px rgba(0,0,0,0.4)'
  closeButton.style.transition = 'all 0.1s ease'
  closeButton.style.transform = 'translateY(0)'
  closeButton.addEventListener('click', onClose)
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = 'linear-gradient(180deg, #86efac 0%, #4ade80 50%, #22c55e 100%)'
    closeButton.style.transform = 'translateY(-2px)'
    closeButton.style.boxShadow = '0 6px 0 #166534, 0 8px 15px rgba(0,0,0,0.5)'
  })
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = 'linear-gradient(180deg, #4ade80 0%, #22c55e 50%, #16a34a 100%)'
    closeButton.style.transform = 'translateY(0)'
    closeButton.style.boxShadow = '0 4px 0 #166534, 0 6px 10px rgba(0,0,0,0.4)'
  })
  closeButton.addEventListener('mousedown', () => {
    closeButton.style.transform = 'translateY(4px)'
    closeButton.style.boxShadow = '0 0 0 #166534, 0 2px 5px rgba(0,0,0,0.3)'
  })
  closeButton.addEventListener('mouseup', () => {
    closeButton.style.transform = 'translateY(-2px)'
    closeButton.style.boxShadow = '0 6px 0 #166534, 0 8px 15px rgba(0,0,0,0.5)'
  })
  settingsDiv.appendChild(closeButton)

  // Re-read the settings that can also be changed outside this screen, so the
  // controls never disagree with what is actually stored.
  ;(settingsDiv as any).refresh = () => {
    const current = settingsManager.getSettings()
    ;(extendedPowerUpsSection as any).setValue?.(current.extendedPowerUps)
    audioSection.refresh?.()
  }

  return settingsDiv
}

/** A row of mutually exclusive pill buttons, styled like the difficulty picker. */
function createSegmentedSetting(
  label: string,
  options: Array<{ label: string; value: string }>,
  currentValue: string,
  onChange: (value: string) => void
): HTMLDivElement {
  const section = document.createElement('div')
  section.style.marginBottom = '25px'

  const labelDiv = document.createElement('div')
  labelDiv.textContent = label
  labelDiv.style.fontFamily = "'Russo One', sans-serif"
  labelDiv.style.fontSize = '16px'
  labelDiv.style.marginBottom = '12px'
  labelDiv.style.color = '#e5e5e5'

  const buttonsDiv = document.createElement('div')
  buttonsDiv.style.display = 'flex'
  buttonsDiv.style.gap = '10px'

  const buttons: HTMLButtonElement[] = []

  const applySelected = (button: HTMLButtonElement) => {
    button.style.background = 'linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)'
    button.style.border = '3px solid #1d4ed8'
    button.style.color = '#fff'
    button.style.boxShadow = '0 0 15px rgba(59,130,246,0.5), 0 4px 0 #1d4ed8'
    button.style.transform = 'translateY(-2px)'
  }
  const applyIdle = (button: HTMLButtonElement) => {
    button.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
    button.style.border = '3px solid #4b5563'
    button.style.color = '#9ca3af'
    button.style.boxShadow = '0 4px 0 #1f2937'
    button.style.transform = 'translateY(0)'
  }

  options.forEach(opt => {
    const button = document.createElement('button')
    button.textContent = opt.label
    button.style.flex = '1'
    button.style.padding = '12px 6px'
    button.style.fontFamily = "'Press Start 2P', monospace"
    button.style.fontSize = '9px'
    button.style.cursor = 'pointer'
    button.style.borderRadius = '8px'
    button.style.fontWeight = 'bold'
    button.style.transition = 'all 0.2s ease'

    if (opt.value === currentValue) applySelected(button)
    else applyIdle(button)

    button.addEventListener('click', () => {
      buttons.forEach(applyIdle)
      applySelected(button)
      onChange(opt.value)
    })

    buttons.push(button)
    buttonsDiv.appendChild(button)
  })

  section.appendChild(labelDiv)
  section.appendChild(buttonsDiv)
  return section
}

function createDropdownSetting(
  label: string,
  options: { name: string, value: string }[],
  currentValue: string,
  onChange: (value: string) => void
): HTMLDivElement {
  const container = document.createElement('div')
  container.style.marginBottom = '20px'
  container.style.display = 'flex'
  container.style.flexDirection = 'column'

  const labelEl = document.createElement('label')
  labelEl.textContent = label
  labelEl.style.marginBottom = '8px'
  labelEl.style.fontSize = '14px'
  labelEl.style.color = '#ccc'
  container.appendChild(labelEl)

  const select = document.createElement('select')
  select.style.padding = '10px'
  select.style.borderRadius = '5px'
  select.style.border = 'none'
  select.style.background = '#32324e'
  select.style.color = 'white'
  select.style.fontFamily = "'Russo One', sans-serif"
  select.style.fontSize = '14px'
  select.style.cursor = 'pointer'

  options.forEach(opt => {
    const option = document.createElement('option')
    option.value = opt.value
    option.textContent = opt.name
    if (opt.value === currentValue) {
      option.selected = true
    }
    select.appendChild(option)
  })

  select.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement
    onChange(target.value)
  })

  container.appendChild(select)
  return container
}

function createSliderSetting(
  label: string,
  initialValue: number,
  onChange: (value: number) => void
): HTMLDivElement {
  const section = document.createElement('div')
  section.style.marginBottom = '25px'

  const labelDiv = document.createElement('div')
  labelDiv.style.fontFamily = "'Russo One', sans-serif"
  labelDiv.style.fontSize = '16px'
  labelDiv.style.marginBottom = '12px'
  labelDiv.style.display = 'flex'
  labelDiv.style.justifyContent = 'space-between'
  labelDiv.style.color = '#e5e5e5'

  const labelText = document.createElement('span')
  labelText.textContent = label
  labelText.style.cursor = 'pointer'

  const valueText = document.createElement('span')
  valueText.textContent = `${Math.round(initialValue * 100)}%`
  valueText.style.color = '#fbbf24'
  valueText.style.fontWeight = 'bold'
  valueText.style.textShadow = '0 0 10px rgba(251, 191, 36, 0.5)'

  labelDiv.appendChild(labelText)
  labelDiv.appendChild(valueText)

  // +/- buttons row
  const controlsRow = document.createElement('div')
  controlsRow.style.display = 'flex'
  controlsRow.style.alignItems = 'center'
  controlsRow.style.gap = '8px'
  controlsRow.style.marginBottom = '6px'

  const minusBtn = document.createElement('button')
  minusBtn.textContent = '➖'
  minusBtn.style.fontSize = '18px'
  minusBtn.style.background = 'rgba(255,255,255,0.1)'
  minusBtn.style.border = '2px solid rgba(255,255,255,0.2)'
  minusBtn.style.borderRadius = '8px'
  minusBtn.style.padding = '6px 12px'
  minusBtn.style.cursor = 'pointer'
  minusBtn.style.color = 'white'
  minusBtn.style.transition = 'background 0.1s'

  const muteBtn = document.createElement('button')
  let savedVolume = initialValue
  let isMuted = initialValue === 0
  muteBtn.textContent = isMuted ? '🔇' : (label.includes('Music') ? '🎵' : '🔊')
  muteBtn.style.fontSize = '18px'
  muteBtn.style.background = isMuted ? 'rgba(255,60,60,0.2)' : 'rgba(255,255,255,0.1)'
  muteBtn.style.border = '2px solid ' + (isMuted ? 'rgba(255,60,60,0.4)' : 'rgba(255,255,255,0.2)')
  muteBtn.style.borderRadius = '8px'
  muteBtn.style.padding = '6px 12px'
  muteBtn.style.cursor = 'pointer'
  muteBtn.style.color = 'white'
  muteBtn.style.transition = 'background 0.1s'

  const plusBtn = document.createElement('button')
  plusBtn.textContent = '➕'
  plusBtn.style.fontSize = '18px'
  plusBtn.style.background = 'rgba(255,255,255,0.1)'
  plusBtn.style.border = '2px solid rgba(255,255,255,0.2)'
  plusBtn.style.borderRadius = '8px'
  plusBtn.style.padding = '6px 12px'
  plusBtn.style.cursor = 'pointer'
  plusBtn.style.color = 'white'
  plusBtn.style.transition = 'background 0.1s'

  controlsRow.appendChild(minusBtn)
  controlsRow.appendChild(muteBtn)
  controlsRow.appendChild(plusBtn)

  const updateUI = (val: number) => {
    slider.value = String(Math.round(val * 100))
    valueText.textContent = `${Math.round(val * 100)}%`
    sliderFill.style.width = `${Math.round(val * 100)}%`
    isMuted = val === 0
    muteBtn.textContent = isMuted ? '🔇' : (label.includes('Music') ? '🎵' : '🔊')
    muteBtn.style.background = isMuted ? 'rgba(255,60,60,0.2)' : 'rgba(255,255,255,0.1)'
    muteBtn.style.border = '2px solid ' + (isMuted ? 'rgba(255,60,60,0.4)' : 'rgba(255,255,255,0.2)')
  }

  minusBtn.addEventListener('click', () => {
    const current = parseInt(slider.value) / 100
    const newVal = Math.max(0, current - 0.05)
    if (newVal > 0) savedVolume = newVal
    updateUI(newVal)
    onChange(newVal)
  })

  plusBtn.addEventListener('click', () => {
    const current = parseInt(slider.value) / 100
    const newVal = Math.min(1, current + 0.05)
    savedVolume = newVal
    updateUI(newVal)
    onChange(newVal)
  })

  muteBtn.addEventListener('click', () => {
    if (isMuted) {
      const restore = savedVolume > 0 ? savedVolume : 0.2
      updateUI(restore)
      onChange(restore)
    } else {
      savedVolume = parseInt(slider.value) / 100 || 0.2
      updateUI(0)
      onChange(0)
    }
  })

  // Also allow clicking the label text to mute
  labelText.addEventListener('click', () => {
    muteBtn.click()
  })

  const sliderContainer = document.createElement('div')
  sliderContainer.style.position = 'relative'
  sliderContainer.style.height = '20px'
  sliderContainer.style.background = 'linear-gradient(180deg, #1a1a2e 0%, #0f0f1a 100%)'
  sliderContainer.style.borderRadius = '10px'
  sliderContainer.style.border = '2px solid #333'
  sliderContainer.style.overflow = 'hidden'

  const sliderFill = document.createElement('div')
  sliderFill.style.position = 'absolute'
  sliderFill.style.top = '0'
  sliderFill.style.left = '0'
  sliderFill.style.height = '100%'
  sliderFill.style.width = `${Math.round(initialValue * 100)}%`
  sliderFill.style.background = 'linear-gradient(90deg, #f97316, #fbbf24)'
  sliderFill.style.borderRadius = '8px'
  sliderFill.style.transition = 'width 0.1s ease'

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '100'
  slider.value = String(Math.round(initialValue * 100))
  slider.style.position = 'absolute'
  slider.style.top = '0'
  slider.style.left = '0'
  slider.style.width = '100%'
  slider.style.height = '100%'
  slider.style.opacity = '0'
  slider.style.cursor = 'pointer'

  slider.addEventListener('input', () => {
    const value = parseInt(slider.value) / 100
    valueText.textContent = `${slider.value}%`
    sliderFill.style.width = `${slider.value}%`
    if (value > 0) savedVolume = value
    isMuted = value === 0
    muteBtn.textContent = isMuted ? '🔇' : (label.includes('Music') ? '🎵' : '🔊')
    muteBtn.style.background = isMuted ? 'rgba(255,60,60,0.2)' : 'rgba(255,255,255,0.1)'
    muteBtn.style.border = '2px solid ' + (isMuted ? 'rgba(255,60,60,0.4)' : 'rgba(255,255,255,0.2)')
    onChange(value)
  })

  sliderContainer.appendChild(sliderFill)
  sliderContainer.appendChild(slider)

  section.appendChild(labelDiv)
  section.appendChild(controlsRow)
  section.appendChild(sliderContainer)

  // The pause menu and the settings screen show the same sliders, so either one
  // has to be able to adopt a value the other stored — without firing onChange.
  ;(section as any).setValue = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    if (clamped > 0) savedVolume = clamped
    updateUI(clamped)
  }

  return section
}

function createToggleSetting(
  label: string,
  initialValue: boolean,
  onChange: (value: boolean) => void
): HTMLDivElement {
  const section = document.createElement('div')
  section.style.marginBottom = '25px'
  section.style.display = 'flex'
  section.style.justifyContent = 'space-between'
  section.style.alignItems = 'center'

  const labelText = document.createElement('span')
  labelText.textContent = label
  labelText.style.fontFamily = "'Russo One', sans-serif"
  labelText.style.fontSize = '16px'
  labelText.style.color = '#e5e5e5'

  // Create toggle switch container
  const toggleContainer = document.createElement('div')
  toggleContainer.style.position = 'relative'
  toggleContainer.style.width = '70px'
  toggleContainer.style.height = '32px'
  toggleContainer.style.cursor = 'pointer'

  const toggleTrack = document.createElement('div')
  toggleTrack.style.position = 'absolute'
  toggleTrack.style.top = '0'
  toggleTrack.style.left = '0'
  toggleTrack.style.width = '100%'
  toggleTrack.style.height = '100%'
  toggleTrack.style.borderRadius = '16px'
  toggleTrack.style.background = initialValue 
    ? 'linear-gradient(90deg, #22c55e, #4ade80)' 
    : 'linear-gradient(90deg, #374151, #4b5563)'
  toggleTrack.style.border = '2px solid ' + (initialValue ? '#166534' : '#1f2937')
  toggleTrack.style.transition = 'all 0.2s ease'
  toggleTrack.style.boxShadow = initialValue 
    ? '0 0 10px rgba(34, 197, 94, 0.5), inset 0 2px 4px rgba(0,0,0,0.2)' 
    : 'inset 0 2px 4px rgba(0,0,0,0.3)'

  const toggleKnob = document.createElement('div')
  toggleKnob.style.position = 'absolute'
  toggleKnob.style.top = '4px'
  toggleKnob.style.left = initialValue ? '40px' : '4px'
  toggleKnob.style.width = '24px'
  toggleKnob.style.height = '24px'
  toggleKnob.style.borderRadius = '50%'
  toggleKnob.style.background = 'linear-gradient(180deg, #fff 0%, #e5e5e5 100%)'
  toggleKnob.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)'
  toggleKnob.style.transition = 'left 0.2s ease'

  const toggleLabel = document.createElement('span')
  toggleLabel.style.position = 'absolute'
  toggleLabel.style.top = '50%'
  toggleLabel.style.transform = 'translateY(-50%)'
  toggleLabel.style.fontFamily = "'Press Start 2P', monospace"
  toggleLabel.style.fontSize = '8px'
  toggleLabel.style.fontWeight = 'bold'
  toggleLabel.style.color = initialValue ? '#166534' : '#9ca3af'
  toggleLabel.style.left = initialValue ? '8px' : '32px'
  toggleLabel.textContent = initialValue ? 'ON' : 'OFF'
  toggleLabel.style.transition = 'all 0.2s ease'

  toggleContainer.appendChild(toggleTrack)
  toggleContainer.appendChild(toggleLabel)
  toggleContainer.appendChild(toggleKnob)

  let isOn = initialValue
  const paint = () => {
    toggleKnob.style.left = isOn ? '40px' : '4px'
    toggleTrack.style.background = isOn
      ? 'linear-gradient(90deg, #22c55e, #4ade80)'
      : 'linear-gradient(90deg, #374151, #4b5563)'
    toggleTrack.style.border = '2px solid ' + (isOn ? '#166534' : '#1f2937')
    toggleTrack.style.boxShadow = isOn
      ? '0 0 10px rgba(34, 197, 94, 0.5), inset 0 2px 4px rgba(0,0,0,0.2)'
      : 'inset 0 2px 4px rgba(0,0,0,0.3)'
    toggleLabel.textContent = isOn ? 'ON' : 'OFF'
    toggleLabel.style.color = isOn ? '#166534' : '#9ca3af'
    toggleLabel.style.left = isOn ? '8px' : '32px'
  }

  toggleContainer.addEventListener('click', () => {
    isOn = !isOn
    paint()
    onChange(isOn)
  })

  // Lets the caller re-sync a toggle that can also be changed from elsewhere
  // (Extended Power-Ups is on the main menu too) without firing onChange.
  ;(section as any).setValue = (value: boolean) => {
    if (value === isOn) return
    isOn = value
    paint()
  }

  section.appendChild(labelText)
  section.appendChild(toggleContainer)

  return section
}

function createDifficultySetting(
  initialValue: 'easy' | 'medium' | 'hard',
  onChange: (value: 'easy' | 'medium' | 'hard') => void
): HTMLDivElement {
  const section = document.createElement('div')
  section.style.marginBottom = '25px'

  const labelDiv = document.createElement('div')
  labelDiv.textContent = 'Difficulty'
  labelDiv.style.fontFamily = "'Russo One', sans-serif"
  labelDiv.style.fontSize = '16px'
  labelDiv.style.marginBottom = '12px'
  labelDiv.style.color = '#e5e5e5'

  const buttonsDiv = document.createElement('div')
  buttonsDiv.style.display = 'flex'
  buttonsDiv.style.gap = '10px'

  const difficulties: Array<'easy' | 'medium' | 'hard'> = ['easy', 'medium', 'hard']
  const difficultyColors = {
    easy: { bg: '#22c55e', glow: 'rgba(34,197,94,0.5)', border: '#166534' },
    medium: { bg: '#f59e0b', glow: 'rgba(245,158,11,0.5)', border: '#b45309' },
    hard: { bg: '#ef4444', glow: 'rgba(239,68,68,0.5)', border: '#b91c1c' }
  }
  const buttons: HTMLButtonElement[] = []

  difficulties.forEach(diff => {
    const button = document.createElement('button')
    button.textContent = diff.toUpperCase()
    button.style.flex = '1'
    button.style.padding = '12px 8px'
    button.style.fontFamily = "'Press Start 2P', monospace"
    button.style.fontSize = '10px'
    button.style.cursor = 'pointer'
    button.style.borderRadius = '8px'
    button.style.fontWeight = 'bold'
    button.style.transition = 'all 0.2s ease'
    
    const isSelected = diff === initialValue
    const colors = difficultyColors[diff]
    
    if (isSelected) {
      button.style.background = `linear-gradient(180deg, ${colors.bg} 0%, ${colors.border} 100%)`
      button.style.border = `3px solid ${colors.border}`
      button.style.color = '#fff'
      button.style.boxShadow = `0 0 15px ${colors.glow}, 0 4px 0 ${colors.border}`
      button.style.transform = 'translateY(-2px)'
    } else {
      button.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
      button.style.border = '3px solid #4b5563'
      button.style.color = '#9ca3af'
      button.style.boxShadow = '0 4px 0 #1f2937'
      button.style.transform = 'translateY(0)'
    }

    button.addEventListener('mouseenter', () => {
      if (button.style.color === 'rgb(156, 163, 175)') { // not selected
        button.style.background = 'linear-gradient(180deg, #4b5563 0%, #374151 100%)'
        button.style.color = '#e5e5e5'
      }
    })

    button.addEventListener('mouseleave', () => {
      if (button.style.color !== 'rgb(255, 255, 255)') { // not selected
        button.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
        button.style.color = '#9ca3af'
      }
    })

    button.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
        b.style.border = '3px solid #4b5563'
        b.style.color = '#9ca3af'
        b.style.boxShadow = '0 4px 0 #1f2937'
        b.style.transform = 'translateY(0)'
      })
      const c = difficultyColors[diff]
      button.style.background = `linear-gradient(180deg, ${c.bg} 0%, ${c.border} 100%)`
      button.style.border = `3px solid ${c.border}`
      button.style.color = '#fff'
      button.style.boxShadow = `0 0 15px ${c.glow}, 0 4px 0 ${c.border}`
      button.style.transform = 'translateY(-2px)'
      onChange(diff)
    })

    buttons.push(button)
    buttonsDiv.appendChild(button)
  })

  section.appendChild(labelDiv)
  section.appendChild(buttonsDiv)

  return section
}

function createColorSetting(
  label: string,
  initialValue: string,
  onChange: (value: string) => void
): HTMLDivElement {
  const section = document.createElement('div')
  section.style.marginBottom = '25px'

  const labelDiv = document.createElement('div')
  labelDiv.textContent = label
  labelDiv.style.fontFamily = "'Russo One', sans-serif"
  labelDiv.style.fontSize = '16px'
  labelDiv.style.marginBottom = '12px'
  labelDiv.style.color = '#e5e5e5'

  const colorsDiv = document.createElement('div')
  colorsDiv.style.display = 'flex'
  colorsDiv.style.flexWrap = 'wrap'
  colorsDiv.style.gap = '8px'

  const colorButtons: HTMLButtonElement[] = []

  PLAYER_COLORS.forEach(colorOption => {
    const button = document.createElement('button')
    button.style.width = '40px'
    button.style.height = '40px'
    button.style.borderRadius = '50%'
    button.style.cursor = 'pointer'
    button.style.transition = 'all 0.2s ease'
    button.style.position = 'relative'
    button.title = colorOption.name
    
    const isSelected = colorOption.value === initialValue
    
    button.style.background = colorOption.value
    button.style.border = isSelected 
      ? '3px solid #fff' 
      : '3px solid rgba(255,255,255,0.2)'
    button.style.boxShadow = isSelected 
      ? `0 0 15px ${colorOption.value}, 0 0 25px ${colorOption.value}` 
      : 'none'
    button.style.transform = isSelected ? 'scale(1.15)' : 'scale(1)'

    // Add checkmark for selected
    if (isSelected) {
      button.textContent = '✓'
      button.style.color = '#000'
      button.style.fontWeight = 'bold'
      button.style.fontSize = '18px'
      button.style.textShadow = '0 0 3px rgba(255,255,255,0.5)'
    }

    button.addEventListener('mouseenter', () => {
      if (button.style.transform !== 'scale(1.15)') {
        button.style.transform = 'scale(1.1)'
        button.style.boxShadow = `0 0 10px ${colorOption.value}`
      }
    })

    button.addEventListener('mouseleave', () => {
      if (!button.textContent) {
        button.style.transform = 'scale(1)'
        button.style.boxShadow = 'none'
      }
    })

    button.addEventListener('click', () => {
      // Deselect all
      colorButtons.forEach(b => {
        b.textContent = ''
        b.style.border = '3px solid rgba(255,255,255,0.2)'
        b.style.boxShadow = 'none'
        b.style.transform = 'scale(1)'
      })
      
      // Select this one
      button.textContent = '✓'
      button.style.color = '#000'
      button.style.fontWeight = 'bold'
      button.style.fontSize = '18px'
      button.style.textShadow = '0 0 3px rgba(255,255,255,0.5)'
      button.style.border = '3px solid #fff'
      button.style.boxShadow = `0 0 15px ${colorOption.value}, 0 0 25px ${colorOption.value}`
      button.style.transform = 'scale(1.15)'
      
      onChange(colorOption.value)
    })

    colorButtons.push(button)
    colorsDiv.appendChild(button)
  })

  section.appendChild(labelDiv)
  section.appendChild(colorsDiv)

  return section
}
