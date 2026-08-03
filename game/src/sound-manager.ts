/**
 * SoundManager — uses the Web Audio API directly (no Babylon.js audio dependency).
 * This avoids tree-shaking issues with Babylon's audio engine in v8.x.
 */
export class SoundManager {
  private sounds: Map<string, AudioBuffer> = new Map()
  private musicSounds: Set<string> = new Set()
  private ctx: AudioContext
  private musicVolume: number = 0.2
  private sfxVolume: number = 0.7
  private currentMusicSource: AudioBufferSourceNode | null = null
  private musicGain: GainNode
  private sfxGain: GainNode
  private musicReadyInterval: ReturnType<typeof setInterval> | null = null
  private musicReadyTimeout: ReturnType<typeof setTimeout> | null = null

  constructor() {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    this.ctx = new AudioCtx()
    this.musicGain = this.ctx.createGain()
    this.musicGain.gain.value = this.musicVolume
    this.musicGain.connect(this.ctx.destination)
    this.sfxGain = this.ctx.createGain()
    this.sfxGain.gain.value = this.sfxVolume
    this.sfxGain.connect(this.ctx.destination)
  }

  /** Unlock AudioContext (must be called from a user-gesture call stack). */
  resumeAudio() {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
  }

  /** Load a sound from a URL. Replaces any existing entry on success. */
  loadSound(name: string, url: string, options: { isMusic?: boolean; loop?: boolean; volume?: number } = {}) {
    if (options.isMusic) {
      this.musicSounds.add(name)
    }
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.arrayBuffer() })
      .then(buf => this.ctx.decodeAudioData(buf))
      .then(decoded => { this.sounds.set(name, decoded) })
      .catch(() => { /* keep placeholder if file missing */ })
  }

  /** Play a one-shot SFX (allows overlapping). */
  playSFX(name: string) {
    const buffer = this.sounds.get(name)
    if (!buffer) return
    try {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.connect(this.sfxGain)
      src.start(0)
    } catch { /* ignore */ }
  }

  /** Play looping background music. */
  playMusic(name: string) {
    this.stopMusic()
    const buffer = this.sounds.get(name)
    if (buffer) {
      this._startMusic(buffer)
      return
    }
    // Buffer might still be loading — poll briefly
    this.musicReadyInterval = setInterval(() => {
      const b = this.sounds.get(name)
      if (b) {
        this._clearMusicTimers()
        this._startMusic(b)
      }
    }, 100)
    this.musicReadyTimeout = setTimeout(() => this._clearMusicTimers(), 5000)
  }

  private _startMusic(buffer: AudioBuffer) {
    try {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.connect(this.musicGain)
      src.start(0)
      this.currentMusicSource = src
    } catch { /* ignore */ }
  }

  private _clearMusicTimers() {
    if (this.musicReadyInterval) { clearInterval(this.musicReadyInterval); this.musicReadyInterval = null }
    if (this.musicReadyTimeout) { clearTimeout(this.musicReadyTimeout); this.musicReadyTimeout = null }
  }

  /** Stop background music. */
  stopMusic() {
    this._clearMusicTimers()
    if (this.currentMusicSource) {
      try { this.currentMusicSource.stop() } catch { /* already stopped */ }
      this.currentMusicSource = null
    }
  }

  setMusicVolume(volume: number) {
    this.musicVolume = Math.max(0, Math.min(1, volume))
    this.musicGain.gain.value = this.musicVolume
  }

  setSFXVolume(volume: number) {
    this.sfxVolume = Math.max(0, Math.min(1, volume))
    this.sfxGain.gain.value = this.sfxVolume
  }

  /** Generate procedural placeholder sounds as WAV → AudioBuffer. */
  createPlaceholderSounds() {
    const sampleRate = 44100

    const createWav = (duration: number, fn: (t: number, i: number) => number): ArrayBuffer => {
      const numSamples = Math.floor(duration * sampleRate)
      const dataLength = numSamples * 2
      const buffer = new ArrayBuffer(44 + dataLength)
      const view = new DataView(buffer)
      const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
      w(0, 'RIFF')
      view.setUint32(4, 36 + dataLength, true)
      w(8, 'WAVE')
      w(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      w(36, 'data')
      view.setUint32(40, dataLength, true)
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate
        const sample = Math.max(-1, Math.min(1, fn(t, i)))
        view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
      }
      return buffer
    }

    const decode = (name: string, wav: ArrayBuffer) => {
      this.ctx.decodeAudioData(wav.slice(0))
        .then(buf => { if (!this.sounds.has(name)) this.sounds.set(name, buf) })
        .catch(() => { /* ignore decode errors */ })
    }

    decode('bomb-place', createWav(0.1, (t) =>
      Math.sin(2 * Math.PI * 800 * t) * Math.exp(-10 * t)))

    decode('explosion', createWav(0.5, (t) =>
      (Math.random() * 2 - 1) * Math.exp(-5 * t)))

    decode('powerup', createWav(0.3, (t) =>
      Math.sin(2 * Math.PI * (400 + 1000 * t) * t) * 0.5))

    decode('death', createWav(0.4, (t) =>
      Math.sin(2 * Math.PI * (500 - 400 * t) * t) * 0.6 * Math.exp(-3 * t)))

    decode('victory', createWav(1.5, (t) => {
      const n = (freq: number) => Math.sin(2 * Math.PI * freq * t)
      return (n(440) + n(554) + n(659)) * 0.3 * Math.exp(-2 * t)
    }))

    decode('defeat', createWav(1.0, (t) =>
      Math.sin(2 * Math.PI * (400 - 300 * t) * t) * 0.5 * Math.exp(-t)))

    decode('game-start', createWav(1.0, (t) => {
      if (t < 0.2) return Math.sin(2 * Math.PI * 440 * t) * 0.5
      if (t < 0.4) return 0
      if (t < 0.6) return Math.sin(2 * Math.PI * 440 * t) * 0.5
      if (t < 0.8) return 0
      return Math.sin(2 * Math.PI * 880 * t) * 0.5 * Math.exp(-(t - 0.8) * 5)
    }))

    decode('countdown-tick', createWav(0.08, (t) =>
      Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-30 * t)))

    decode('kick', createWav(0.2, (t) =>
      Math.sin(2 * Math.PI * (200 * Math.exp(-15 * t)) * t) * Math.exp(-8 * t)))

    decode('throw', createWav(0.25, (t) =>
      (Math.random() * 2 - 1) * 0.3 * Math.exp(-6 * t) +
      Math.sin(2 * Math.PI * (300 + 800 * t) * t) * 0.3 * Math.exp(-4 * t)))

    decode('menu-select', createWav(0.08, (t) =>
      Math.sin(2 * Math.PI * 600 * t) * Math.exp(-20 * t)))

    decode('menu-click', createWav(0.06, (t) =>
      Math.sin(2 * Math.PI * 900 * t) * Math.exp(-25 * t)))

    decode('bgm', createWav(16.0, (t) => {
      // Soothing ambient pad — layered sine waves with slow modulation
      const loopT = t % 16
      let output = 0

      // Warm pad chord: Cmaj7 (C3, E3, G3, B3) with slow volume swell
      const padFreqs = [130.81, 164.81, 196.0, 246.94]
      const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * loopT / 16) // gentle fade in/out
      for (const f of padFreqs) {
        output += Math.sin(2 * Math.PI * f * t) * 0.12 * swell
      }

      // Slow detuned shimmer (chorus effect)
      output += Math.sin(2 * Math.PI * 131.4 * t) * 0.04 * swell
      output += Math.sin(2 * Math.PI * 197.1 * t) * 0.03 * swell

      // Sub-bass pulse — very gentle
      output += Math.sin(2 * Math.PI * 65.41 * t) * 0.08 * (0.6 + 0.4 * Math.sin(2 * Math.PI * loopT / 8))

      // Evolving high overtone — soft bell-like shimmer
      const bellEnv = Math.exp(-((loopT % 4) - 0) * 2) * 0.06
      output += Math.sin(2 * Math.PI * 523.25 * t) * bellEnv
      output += Math.sin(2 * Math.PI * 659.25 * t) * bellEnv * 0.5

      // Second chord phrase (Fmaj7) in second half for movement
      if (loopT > 8) {
        const pad2Freqs = [174.61, 220.0, 261.63, 329.63]
        const swell2 = Math.sin(2 * Math.PI * (loopT - 8) / 8) * 0.8
        for (const f of pad2Freqs) {
          output += Math.sin(2 * Math.PI * f * t) * 0.08 * Math.max(0, swell2)
        }
      }

      return output * 0.45
    }))
    this.musicSounds.add('bgm')
  }
}
