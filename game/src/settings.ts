/** 'auto' shows the touch pad on mobile only; 'on'/'off' force it either way. */
export type OnScreenControlsMode = 'auto' | 'on' | 'off'

/** Player names are capped so they always fit the HUD panel and scoreboards. */
export const MAX_PLAYER_NAME_LENGTH = 8
export const DEFAULT_PLAYER_NAME = 'Player 1'

/** Trim, clamp to the length limit, and fall back to the default when empty. */
export function sanitizePlayerName(name: string): string {
  const trimmed = (name ?? '').trim().slice(0, MAX_PLAYER_NAME_LENGTH)
  return trimmed.length > 0 ? trimmed : DEFAULT_PLAYER_NAME
}

export interface GameSettings {
  playerName: string
  musicVolume: number
  sfxVolume: number
  screenShake: boolean
  particles: boolean
  haptics: boolean
  difficulty: 'easy' | 'medium' | 'hard'
  player1Color: string
  player2Color: string
  characterShape: 'sphere' | 'cat' | 'dog'
  extendedPowerUps: boolean
  onScreenControls: OnScreenControlsMode
  rounds: 1 | 3 | 5
}

export const PLAYER_COLORS = [
  { name: 'Green', value: '#4ade80' },
  { name: 'Blue', value: '#60a5fa' },
  { name: 'Red', value: '#f87171' },
  { name: 'Yellow', value: '#fbbf24' },
  { name: 'Purple', value: '#a78bfa' },
  { name: 'Pink', value: '#f472b6' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Orange', value: '#fb923c' },
]

export const CHARACTER_SHAPES = [
  { name: 'Classic (Sphere)', value: 'sphere' },
  { name: 'Cat', value: 'cat' },
  { name: 'Dog', value: 'dog' },
]

export class SettingsManager {
  private settings: GameSettings
  private storageKey = 'whatabomb-settings'

  constructor() {
    this.settings = this.loadSettings()
  }

  private loadSettings(): GameSettings {
    const saved = localStorage.getItem(this.storageKey)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        // Ensure new properties have defaults
        return {
          playerName: sanitizePlayerName(parsed.playerName ?? DEFAULT_PLAYER_NAME),
          musicVolume: parsed.musicVolume ?? 0.2,
          sfxVolume: parsed.sfxVolume ?? 0.7,
          screenShake: parsed.screenShake ?? true,
          particles: parsed.particles ?? true,
          haptics: parsed.haptics ?? true,
          difficulty: parsed.difficulty ?? 'medium',
          player1Color: parsed.player1Color ?? '#4ade80',
          player2Color: parsed.player2Color ?? '#60a5fa',
          characterShape: parsed.characterShape ?? 'sphere',
          extendedPowerUps: parsed.extendedPowerUps ?? false,
          onScreenControls: parsed.onScreenControls ?? 'auto',
          rounds: parsed.rounds ?? 3,
        }
      } catch (e) {
        console.error('Failed to load settings:', e)
      }
    }

    return {
      playerName: DEFAULT_PLAYER_NAME,
      musicVolume: 0.2,
      sfxVolume: 0.7,
      screenShake: true,
      particles: true,
      haptics: true,
      difficulty: 'medium',
      player1Color: '#4ade80',
      player2Color: '#60a5fa',
      characterShape: 'sphere',
      extendedPowerUps: false,
      onScreenControls: 'auto',
      rounds: 3,
    }
  }

  private saveSettings() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.settings))
  }

  getSettings(): GameSettings {
    return { ...this.settings }
  }

  setMusicVolume(volume: number) {
    this.settings.musicVolume = Math.max(0, Math.min(1, volume))
    this.saveSettings()
  }

  setSFXVolume(volume: number) {
    this.settings.sfxVolume = Math.max(0, Math.min(1, volume))
    this.saveSettings()
  }

  setScreenShake(enabled: boolean) {
    this.settings.screenShake = enabled
    this.saveSettings()
  }

  setParticles(enabled: boolean) {
    this.settings.particles = enabled
    this.saveSettings()
  }

  setDifficulty(difficulty: 'easy' | 'medium' | 'hard') {
    this.settings.difficulty = difficulty
    this.saveSettings()
  }

  setPlayer1Color(color: string) {
    this.settings.player1Color = color
    this.saveSettings()
  }

  setPlayer2Color(color: string) {
    this.settings.player2Color = color
    this.saveSettings()
  }

  setCharacterShape(shape: 'sphere' | 'cat' | 'dog') {
    this.settings.characterShape = shape
    this.saveSettings()
  }

  setExtendedPowerUps(enabled: boolean) {
    this.settings.extendedPowerUps = enabled
    this.saveSettings()
  }

  setHaptics(enabled: boolean) {
    this.settings.haptics = enabled
    this.saveSettings()
  }

  setOnScreenControls(mode: OnScreenControlsMode) {
    this.settings.onScreenControls = mode
    this.saveSettings()
  }

  setRounds(rounds: 1 | 3 | 5) {
    this.settings.rounds = rounds
    this.saveSettings()
  }

  setPlayerName(name: string) {
    this.settings.playerName = sanitizePlayerName(name)
    this.saveSettings()
  }
}
