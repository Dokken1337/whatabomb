/**
 * generate-sounds.js
 * 
 * Generates all game audio (SFX + BGM) as WAV files for What'a Bomb!
 * Pure Node.js – no dependencies required.
 *
 * Usage:  node scripts/generate-sounds.js
 * Output: public/sounds/*.wav
 */

const fs = require('fs')
const path = require('path')

const OUT_DIR = path.join(__dirname, '..', 'public', 'sounds')
const SAMPLE_RATE = 44100
const TWO_PI = 2 * Math.PI

// ─── WAV encoder ────────────────────────────────────────────────────────────
function encodeWAV(samples, sampleRate = SAMPLE_RATE) {
  // 16-bit PCM mono
  const numSamples = samples.length
  const byteRate = sampleRate * 2
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)       // chunk size
  buffer.writeUInt16LE(1, 20)        // PCM
  buffer.writeUInt16LE(1, 22)        // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(2, 32)        // block align
  buffer.writeUInt16LE(16, 34)       // bits per sample

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buffer
}

// ─── DSP helpers ────────────────────────────────────────────────────────────
const sin = (freq, t) => Math.sin(TWO_PI * freq * t)
const saw = (freq, t) => { const p = (t * freq) % 1; return 2 * p - 1 }
const square = (freq, t, duty = 0.5) => ((t * freq) % 1) < duty ? 1 : -1
const noise = () => Math.random() * 2 - 1
const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v))

// Envelopes
const decay = (t, rate) => Math.exp(-rate * t)
const adsr = (t, a, d, s, r, dur) => {
  if (t < a) return t / a
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d)
  if (t < dur - r) return s
  if (t < dur) return s * (1 - (t - (dur - r)) / r)
  return 0
}

// Simple low-pass (one-pole)
function lpFilter(samples, cutoff) {
  const rc = 1 / (TWO_PI * cutoff)
  const dt = 1 / SAMPLE_RATE
  const alpha = dt / (rc + dt)
  const out = new Float64Array(samples.length)
  out[0] = samples[0]
  for (let i = 1; i < samples.length; i++) {
    out[i] = out[i - 1] + alpha * (samples[i] - out[i - 1])
  }
  return out
}

// Distortion / saturation
function softClip(samples, gain = 2) {
  return samples.map(s => Math.tanh(s * gain))
}

// Generate sample buffer
function generate(duration, fn) {
  const len = Math.floor(duration * SAMPLE_RATE)
  const buf = new Float64Array(len)
  for (let i = 0; i < len; i++) {
    buf[i] = fn(i / SAMPLE_RATE, i)
  }
  return buf
}

// Mix multiple buffers (same length expected, or pads shorter)
function mix(...buffers) {
  const len = Math.max(...buffers.map(b => b.length))
  const out = new Float64Array(len)
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) out[i] += b[i]
  }
  return out
}

// Normalize to peak amplitude
function normalize(buf, peak = 0.95) {
  let max = 0
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]))
  if (max === 0) return buf
  const scale = peak / max
  return buf.map(s => s * scale)
}

// Apply gain
function gain(buf, g) { return buf.map(s => s * g) }

// Reverb (simple comb-filter based)
function reverb(samples, delayMs = 80, feedback = 0.3, mix = 0.25) {
  const delaySamples = Math.floor(delayMs / 1000 * SAMPLE_RATE)
  const out = new Float64Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i]
    if (i >= delaySamples) {
      out[i] += out[i - delaySamples] * feedback
    }
  }
  // Mix dry/wet
  return samples.map((s, i) => s * (1 - mix) + out[i] * mix)
}

// ─── Sound Generators ───────────────────────────────────────────────────────

function bombPlace() {
  // Chunky placement sound: thud + click
  const dur = 0.25
  const thud = generate(dur, t => {
    const freq = 120 * decay(t, 15)
    return sin(freq, t) * decay(t, 8) * 0.7
  })
  const click = generate(dur, t => {
    return noise() * decay(t, 60) * 0.4
  })
  const tone = generate(dur, t => {
    return sin(300, t) * decay(t, 20) * 0.3
  })
  return normalize(mix(thud, click, tone))
}

function explosion() {
  // Intense explosion: noise burst + low rumble + crackle
  const dur = 0.8
  const burst = generate(dur, t => noise() * decay(t, 4) * 0.8)
  const rumble = generate(dur, t => {
    const f = 60 + 40 * decay(t, 3)
    return sin(f, t) * decay(t, 2.5) * 0.6
  })
  const crackle = generate(dur, t => {
    const env = t < 0.05 ? t / 0.05 : decay(t - 0.05, 5)
    return noise() * env * 0.5 * (Math.random() > 0.3 ? 1 : 0)
  })
  let result = mix(burst, rumble, crackle)
  result = lpFilter(result, 3000 + 2000 * Math.random())
  result = softClip(result, 1.5)
  return normalize(reverb(result, 60, 0.25, 0.2))
}

function powerup() {
  // Sparkly ascending arpeggio
  const dur = 0.45
  const notes = [523, 659, 784, 1047] // C5 E5 G5 C6
  const noteLen = dur / notes.length
  return normalize(generate(dur, t => {
    const noteIdx = Math.min(Math.floor(t / noteLen), notes.length - 1)
    const localT = t - noteIdx * noteLen
    const freq = notes[noteIdx]
    const env = adsr(localT, 0.005, 0.05, 0.6, 0.05, noteLen)
    return (sin(freq, t) * 0.5 + sin(freq * 2, t) * 0.2 + sin(freq * 3, t) * 0.1) * env * 0.7
  }))
}

function victory() {
  // Triumphant fanfare: rising major chord arpeggio
  const dur = 2.0
  // C major fanfare: C E G C E G C (ascending)
  const notes = [
    { freq: 523, start: 0.0, len: 0.25 },
    { freq: 659, start: 0.15, len: 0.25 },
    { freq: 784, start: 0.3, len: 0.3 },
    { freq: 1047, start: 0.5, len: 0.5 },
    // Sustained chord
    { freq: 523, start: 0.8, len: 1.2 },
    { freq: 659, start: 0.8, len: 1.2 },
    { freq: 784, start: 0.8, len: 1.2 },
    { freq: 1047, start: 0.8, len: 1.2 },
  ]
  return normalize(reverb(generate(dur, t => {
    let out = 0
    for (const n of notes) {
      if (t >= n.start && t < n.start + n.len) {
        const lt = t - n.start
        const env = adsr(lt, 0.01, 0.1, 0.7, 0.15, n.len)
        out += (sin(n.freq, t) * 0.4 + sin(n.freq * 2, t) * 0.15 + sin(n.freq * 0.5, t) * 0.1) * env
      }
    }
    return out * 0.5
  }), 100, 0.2, 0.3))
}

function defeat() {
  // Sad descending sound + low thud
  const dur = 1.2
  return normalize(generate(dur, t => {
    // Descending chromatic tones
    const freq = 400 * Math.pow(0.5, t * 2)
    const env = decay(t, 1.5)
    const main = sin(freq, t) * env * 0.4
    // Low rumble
    const bass = sin(80, t) * decay(t, 2) * 0.3
    // Dissonant overtone
    const dis = sin(freq * 1.06, t) * env * 0.15
    return main + bass + dis
  }))
}

function gameStart() {
  // "Ready... Set... GO!" three ascending beeps
  const dur = 1.3
  const beeps = [
    { freq: 440, start: 0.0, len: 0.15 },   // Ready
    { freq: 440, start: 0.4, len: 0.15 },   // Set
    { freq: 880, start: 0.8, len: 0.4 },    // GO! (higher, longer)
  ]
  return normalize(generate(dur, t => {
    let out = 0
    for (const b of beeps) {
      if (t >= b.start && t < b.start + b.len) {
        const lt = t - b.start
        const env = adsr(lt, 0.005, 0.02, 0.8, 0.05, b.len)
        out += sin(b.freq, t) * env * 0.6
        out += sin(b.freq * 2, t) * env * 0.15 // harmonic
      }
    }
    return out
  }))
}

function death() {
  // Hit/damage: impact thud + high pitched ring
  const dur = 0.5
  const impact = generate(dur, t => {
    return noise() * decay(t, 12) * 0.6
  })
  const ring = generate(dur, t => {
    const freq = 800 - 400 * t
    return sin(freq, t) * decay(t, 6) * 0.4
  })
  const thud = generate(dur, t => {
    return sin(100 * decay(t, 10), t) * decay(t, 8) * 0.5
  })
  let result = mix(impact, ring, thud)
  result = lpFilter(result, 4000)
  return normalize(result)
}

function menuSelect() {
  // Quick bright blip - selection highlight
  const dur = 0.1
  return normalize(generate(dur, t => {
    const env = adsr(t, 0.003, 0.03, 0.4, 0.04, dur)
    return sin(660, t) * env * 0.5 + sin(1320, t) * env * 0.2
  }))
}

function menuClick() {
  // Snappy confirm click
  const dur = 0.15
  return normalize(generate(dur, t => {
    const env = decay(t, 25)
    const pop = sin(1200, t) * env * 0.4
    const click = noise() * decay(t, 50) * 0.3
    return pop + click
  }))
}

function kick() {
  // Kick sound: foot-hitting-ball swoosh + impact
  const dur = 0.3
  const swoosh = generate(dur, t => {
    return noise() * adsr(t, 0.01, 0.1, 0.3, 0.1, dur) * 0.4
  })
  const impact = generate(dur, t => {
    const freq = 200 * decay(t, 12)
    return sin(freq, t) * decay(t, 10) * 0.7
  })
  const snap = generate(dur, t => {
    return noise() * decay(t, 40) * 0.5
  })
  let result = mix(swoosh, impact, snap)
  result = lpFilter(result, 5000)
  return normalize(result)
}

function throwSound() {
  // Whoosh throw sound
  const dur = 0.35
  return normalize(generate(dur, t => {
    // Rising then falling noise for whoosh
    const center = 0.15
    const env = Math.exp(-((t - center) ** 2) / (2 * 0.06 ** 2)) // Gaussian
    const noiseSig = noise() * env * 0.6
    // Tonal swoosh
    const freq = 300 + 500 * (t / dur)
    const tonal = sin(freq, t) * env * 0.2
    return noiseSig + tonal
  }))
}

function countdownTick() {
  // Short percussive tick
  const dur = 0.08
  return normalize(generate(dur, t => {
    const env = decay(t, 30)
    return (sin(1000, t) * 0.4 + noise() * 0.2) * env
  }))
}

function walk() {
  // Soft footstep
  const dur = 0.12
  return normalize(generate(dur, t => {
    const env = decay(t, 20)
    return (noise() * 0.5 + sin(200, t) * 0.2) * env
  }))
}

// ─── Background Music Generator ─────────────────────────────────────────────

function generateBGM() {
  const bpm = 80 // Calmer tempo
  const beatLen = 60 / bpm
  const bars = 16
  const beatsPerBar = 4
  const totalBeats = bars * beatsPerBar
  const dur = totalBeats * beatLen

  // Musical key: A minor
  // A=220, C=262, D=294, E=330, F=349, G=392, A=440
  const bassNotes = [
    // Bars 1-4:  Am - Am - F - G
    220, 220, 220, 220,   220, 220, 220, 220,
    175, 175, 175, 175,   196, 196, 196, 196,
    // Bars 5-8:  Am - Am - F - E
    220, 220, 220, 220,   220, 220, 220, 220,
    175, 175, 175, 175,   165, 165, 165, 165,
    // Bars 9-12: C - G - Am - Am
    131, 131, 131, 131,   196, 196, 196, 196,
    220, 220, 220, 220,   220, 220, 220, 220,
    // Bars 13-16: F - G - Am - E
    175, 175, 175, 175,   196, 196, 196, 196,
    220, 220, 220, 220,   165, 165, 165, 165,
  ]

  // Melody pattern (quarter notes)
  const melodyNotes = [
    // Bars 1-4: Simple motif
    440, 0, 523, 0,   494, 440, 0, 392,
    349, 0, 330, 0,   392, 0, 0, 0,
    // Bars 5-8: Variation
    440, 0, 523, 587,  523, 494, 440, 0,
    349, 392, 349, 330, 330, 0, 0, 0,
    // Bars 9-12: Development
    523, 0, 494, 0,   392, 0, 440, 0,
    440, 523, 587, 523, 440, 0, 392, 0,
    // Bars 13-16: Resolution
    349, 0, 349, 392,  392, 440, 494, 0,
    440, 0, 0, 523,   440, 0, 0, 0,
  ]

  // Simplified calming drum pattern
  const drumPattern = [
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
    1, 0, 4, 0,  0, 0, 4, 0,
  ]

  const totalSamples = Math.floor(dur * SAMPLE_RATE)

  // Bass track: warm sine
  const bass = generate(dur, t => {
    const beatIdx = Math.floor(t / beatLen) % totalBeats
    const freq = bassNotes[beatIdx] || 220
    const localT = t % beatLen
    const env = adsr(localT, 0.1, 0.3, 0.6, 0.2, beatLen)
    return sin(freq, t) * env * 0.4
  })

  // Melody track: glockenspiel/bell like sine
  const melody = generate(dur, t => {
    const beatIdx = Math.floor(t / beatLen) % totalBeats
    const freq = melodyNotes[beatIdx]
    if (!freq) return 0
    const localT = t % beatLen
    const env = adsr(localT, 0.01, 0.1, 0.1, 0.8, beatLen * 0.9)
    return sin(freq, t) * env * 0.4
  })

  // Arpeggio track: slow rolling sine
  const arp = generate(dur, t => {
    const beatIdx = Math.floor(t / beatLen) % totalBeats
    const barIdx = Math.floor(beatIdx / beatsPerBar)
    const bassFreq = bassNotes[barIdx * beatsPerBar] || 220
    const arpNotes = [bassFreq * 2, bassFreq * 3]
    const arpSpeed = beatLen / 2
    const arpIdx = Math.floor((t % beatLen) / arpSpeed) % arpNotes.length
    const localT = t % arpSpeed
    const env = adsr(localT, 0.1, 0.4, 0.2, 0.2, arpSpeed)
    return sin(arpNotes[arpIdx], t) * env * 0.2
  })

  // Drum track - just soft ticks/shakers
  const drums = generate(dur, t => {
    const beatIdx = Math.floor(t / beatLen) % totalBeats
    const pattern = drumPattern[beatIdx] || 0
    const localT = t % beatLen
    let out = 0

    // Soft Kick
    if (pattern & 1) {
      const kickFreq = 80 * Math.exp(-localT * 10)
      out += sin(kickFreq, localT) * decay(localT, 10) * 0.3
    }

    // Soft Hi-hat
    if (pattern & 4) {
      out += noise() * decay(localT, 30) * 0.05
    }

    return out
  })

  // Pad - atmospheric
  const pad = generate(dur, t => {
      const beatIdx = Math.floor(t / beatLen) % totalBeats
      const barIdx = Math.floor(beatIdx / beatsPerBar)
      const freq = (bassNotes[barIdx * beatsPerBar] || 220)
      return (sin(freq, t) + sin(freq * 1.5, t) * 0.5) * 0.1
  })

  let result = mix(
    bass,
    melody,
    arp,
    drums,
    pad
  )

  // Master processing
  result = reverb(result, 150, 0.4, 0.3)
  return normalize(result, 0.75)
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  }

  const sounds = {
    'bomb-place': bombPlace,
    'explosion': explosion,
    'powerup': powerup,
    'victory': victory,
    'defeat': defeat,
    'game-start': gameStart,
    'death': death,
    'menu-select': menuSelect,
    'menu-click': menuClick,
    'kick': kick,
    'throw': throwSound,
    'countdown-tick': countdownTick,
    'walk': walk,
    'bgm': generateBGM,
  }

  console.log('🎵 Generating sounds for What\'a Bomb!\n')

  for (const [name, genFn] of Object.entries(sounds)) {
    const start = Date.now()
    const samples = genFn()
    const wav = encodeWAV(Array.from(samples))
    const filePath = path.join(OUT_DIR, `${name}.wav`)
    fs.writeFileSync(filePath, wav)
    const elapsed = Date.now() - start
    const sizeKB = (wav.length / 1024).toFixed(1)
    console.log(`  ✅ ${name}.wav  (${sizeKB} KB, ${elapsed}ms)`)
  }

  console.log(`\n🔊 Done! ${Object.keys(sounds).length} sounds generated in public/sounds/`)
}

main()
