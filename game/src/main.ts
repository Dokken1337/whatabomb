import { FLARE_TEXTURE_DATA_URI } from './assets'
import './style.css'
import { isMobile, haptic, setHapticsEnabled, isIOS, showOnScreenControls } from './device'
import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  Matrix,
  Quaternion,
  Scene,
  ParticleSystem,
  RenderTargetTexture,
  Texture,
  Animation,
  DynamicTexture,
  DirectionalLight,
  GlowLayer,
  ShadowGenerator,
  TransformNode,
} from '@babylonjs/core'
import { createMainMenu, createPauseMenu, showCountdown, type GameMode } from './menu'

import { SoundManager } from './sound-manager'
import { StatisticsManager } from './statistics'
import { SettingsManager, sanitizePlayerName, PLAYER_COLORS } from './settings'
import { createSettingsMenu, createAudioSettings } from './settings-menu'
import { createStatsScreen } from './stats-screen'
import { GameStateManager } from './game-state'
import { getDifficultyConfig, getWaveScaling, type DifficultyConfig } from './difficulty'
import { AchievementsManager } from './achievements'
import { createAchievementsScreen, showAchievementNotification } from './achievements-screen'
import { createTutorialScreen } from './tutorial'
import { createMapSelectionScreen } from './map-selection'
import { getMapConfig, type MapConfig } from './maps'
import { showHitIndicator, setParticlesEnabled } from './visual-effects'
import {
  shouldAIPlaceBomb,
  getEscapeDirection,
  getEscapeDepth,
  isPositionSafe,
  findPathToTarget,
} from './ai-bomb-logic'
import { generateMap, type SpawnPoint } from './map-gen'
import { NetClient } from './net/client'
import { createLobbyScreen } from './net/lobby-screen'
import type { WorldSnapshot } from '../shared/protocol'

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found')
}

// Create a full-screen canvas for Babylon to render into
const canvas = document.createElement('canvas')
canvas.id = 'game-canvas'
app.innerHTML = ''
app.appendChild(canvas)

// Global game state
let currentEngine: Engine | null = null
let currentScene: Scene | null = null
let isPaused = false

// Global managers
const statsManager = new StatisticsManager()
const settingsManager = new SettingsManager()
setHapticsEnabled(settingsManager.getSettings().haptics)
const gameStateManager = new GameStateManager()
const achievementsManager = new AchievementsManager()
let soundManager: SoundManager | null = null

// Map configuration - default to small map on mobile, medium on PC
let currentMapConfig: MapConfig = getMapConfig(isMobile() ? 'small-classic' : 'medium-classic')

// Basic grid settings (can be tuned later to match Playing With Fire 2)
// Total number of tiles horizontally/vertically (including outer walls)
// 17x17 gives a larger, classic odd-sized arena.
let GRID_WIDTH = 17
let GRID_HEIGHT = 17
const TILE_SIZE = 1

type PowerUpType = 'extraBomb' | 'largerBlast' | 'kick' | 'throw' | 'speed' | 'shield' | 'pierce' | 'ghost' | 'powerBomb' | 'lineBomb'

interface PowerUp {
  x: number
  y: number
  type: PowerUpType
  mesh: any
}

interface Bomb {
  x: number
  y: number
  timer: number
  mesh: any
  blastRadius: number
  ownerId?: number // -1 for player 1, -2 for player 2, 0+ for enemies
}

interface Enemy {
  /** Stable identifier, also used as the bomb ownerId. Never reused. */
  id: number
  x: number
  y: number
  mesh: any
  moveTimer: number
  lives: number
  maxLives: number
  invulnerable: boolean
  invulnerableTimer: number
  // Per-enemy loadout — previously a parallel array, which made removing a
  // dead enemy corrupt every other enemy's stats and bomb ownership.
  maxBombs: number
  currentBombs: number
  blastRadius: number
  /** Current decision interval in ms; shrinks when the AI picks up speed. */
  moveInterval: number
  /** Tile the AI is currently trying to tunnel through, if any. */
  tunnelTarget: { x: number; y: number } | null
  // Smooth movement visual position
  visualX?: number
  visualZ?: number
}


function gridToWorld(x: number, y: number): Vector3 {
  return new Vector3(
    (x - GRID_WIDTH / 2 + 0.5) * TILE_SIZE,
    TILE_SIZE / 2,
    (y - GRID_HEIGHT / 2 + 0.5) * TILE_SIZE,
  )
}

// Reusable Vector3 for hot-path gridToWorld calls (avoids per-frame allocation)
const _tmpGridVec = new Vector3()
function gridToWorldInPlace(x: number, y: number, out: Vector3): Vector3 {
  out.copyFromFloats(
    (x - GRID_WIDTH / 2 + 0.5) * TILE_SIZE,
    TILE_SIZE / 2,
    (y - GRID_HEIGHT / 2 + 0.5) * TILE_SIZE,
  )
  return out
}

/** Escape user-supplied text before it goes into an innerHTML template. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' :
    ch === '<' ? '&lt;' :
    ch === '>' ? '&gt;' :
    ch === '"' ? '&quot;' : '&#39;'
  ))
}

// Helper: set visibility on all child meshes of a TransformNode
function setCharacterVisibility(root: TransformNode, value: number) {
  const meshes = (root as any)._cachedChildMeshes || root.getChildMeshes()
  for (let i = 0; i < meshes.length; i++) {
    meshes[i].visibility = value
  }
}

/** Everything the scene needs to run a networked match. */
interface OnlineContext {
  net: NetClient
  seed: number
  round: number
  youId: string
  isHost: boolean
  roster: Array<{ id: string; name: string; slot: number }>
  lives: number
}

/**
 * One networked player. Online matches replace the hardcoded player-1 /
 * player-2 pair with this list, so 2-4 humans share one code path.
 */
interface NetPlayer {
  id: string
  slot: number
  name: string
  isLocal: boolean
  x: number
  y: number
  visualX: number
  visualZ: number
  mesh: any
  lives: number
  alive: boolean
  maxBombs: number
  currentBombs: number
  blastRadius: number
  hasKick: boolean
  hasThrow: boolean
  speed: number
  moveDelay: number
  lastMoveTime: number
  lastDx: number
  lastDy: number
  invulnerable: boolean
  invulnerableTimer: number
  // Extended power-ups. These used to exist only for the offline player, so
  // online they could be picked up — the pickup even vanished — and then do
  // nothing at all.
  /** Hits absorbed before losing a life. */
  shieldCharges: number
  /** Blasts pass through crates. */
  hasPierce: boolean
  /** Remaining ms of walking through crates and bombs. */
  ghostTimer: number
  /** Bombs left that get +3 blast. */
  powerBombCharges: number
  /** Bomb key lays a row instead of one bomb. */
  hasLineBomb: boolean
  /** Latest input from this player, consumed by the host each frame. */
  input: { dx: number; dy: number; bomb: boolean }
  /** Highest input sequence seen, so out-of-order frames are dropped. */
  inputSeq: number
}

/**
 * One SoundManager for the whole session.
 *
 * It used to be rebuilt on every scene, which leaked an AudioContext per match
 * (browsers cap those) and left the menus silent until a game had been played
 * at least once — so the interface volume had nothing to act on where the
 * interface sounds actually live.
 */
function ensureSoundManager(): SoundManager {
  if (soundManager) return soundManager

  const manager = new SoundManager()
  soundManager = manager
  manager.createPlaceholderSounds()

  // Load all sound effect files (WAV format)
  try {
    manager.loadSound('bomb-place', '/sounds/bomb-place.wav', { volume: 0.5 })
    manager.loadSound('explosion', '/sounds/explosion.wav', { volume: 0.6 })
    manager.loadSound('powerup', '/sounds/powerup.wav', { volume: 0.5 })
    manager.loadSound('victory', '/sounds/victory.wav', { volume: 0.7 })
    manager.loadSound('defeat', '/sounds/defeat.wav', { volume: 0.7 })
    manager.loadSound('game-start', '/sounds/game-start.wav', { volume: 0.6 })
    manager.loadSound('death', '/sounds/death.wav', { volume: 0.6 })
    manager.loadSound('menu-select', '/sounds/menu-select.wav', { volume: 0.4 })
    manager.loadSound('menu-click', '/sounds/menu-click.wav', { volume: 0.5 })
    manager.loadSound('kick', '/sounds/kick.wav', { volume: 0.5 })
    manager.loadSound('throw', '/sounds/throw.wav', { volume: 0.5 })
    manager.loadSound('countdown-tick', '/sounds/countdown-tick.wav', { volume: 0.5 })
    manager.loadSound('bgm', '/sounds/bgm.wav', { loop: true, isMusic: true })
  } catch (e) {
    console.log('Sound files not found - run: node scripts/generate-sounds.js')
  }

  applyAudioSettings()
  return manager
}

/** Push the stored volumes and the master mute onto the live audio graph. */
function applyAudioSettings(): void {
  if (!soundManager) return
  const settings = settingsManager.getSettings()
  soundManager.setMusicVolume(settings.musicVolume)
  soundManager.setSFXVolume(settings.sfxVolume)
  soundManager.setUIVolume(settings.uiVolume)
  soundManager.setMuted(settings.muteAll)
}

/**
 * Input sequence number for this browser, deliberately outside the scene.
 *
 * The host drops any input whose seq is not greater than the last it saw, and
 * both sides rebuild their state for every round. When this counter lived on
 * the scene it restarted at zero each round while the host could still be
 * holding a high watermark from the previous one — inputs that arrived late,
 * during the round-over grace period, set it. Every input for the rest of the
 * match then failed the `seq <= inputSeq` check and was silently discarded, so
 * a guest could neither move nor bomb from round two onwards.
 *
 * Never resetting it keeps every input strictly newer than anything the host
 * can already have recorded.
 */
let localInputSeq = 0

/**
 * The arena every online match is played on.
 *
 * Map choice is a local setting, and its default even varies by device — phones
 * start on the 13x13 small map, desktops on the 17x17 classic one. The shared
 * seed only guarantees an identical arena when the grid dimensions and theme
 * match too, so a desktop host and a phone guest were building different boards
 * and every coordinate on the wire meant something different on each screen:
 * blasts, crates and power-ups all landed on the wrong tiles, and anything past
 * the smaller grid's edge was drawn off the board entirely.
 *
 * Pinning one map for online play makes the seed sufficient again.
 */
const ONLINE_MAP_KEY = 'medium-classic'

function createScene(engine: Engine, gameMode: GameMode, online?: OnlineContext): Scene {
  const scene = new Scene(engine)

  // Update grid size from map config
  const mapConfig = online ? getMapConfig(ONLINE_MAP_KEY) : currentMapConfig
  GRID_WIDTH = mapConfig.gridWidth
  GRID_HEIGHT = mapConfig.gridHeight

  ensureSoundManager()
  applyAudioSettings()

  const settings = settingsManager.getSettings()
  // The "Particle Effects" toggle previously had no effect at all.
  setParticlesEnabled(settings.particles)
  const particlesOn = settings.particles
  const playerName = sanitizePlayerName(settings.playerName)

  // Track game session for achievements
  let sessionEnemiesDefeated = 0
  let sessionBlocksDestroyed = 0
  let sessionPowerUpsCollected = 0
  let sessionDamageTaken = 0
  const sessionPowerUpTypes = new Set<string>()
  
  // Get difficulty configuration
  const difficultyConfig: DifficultyConfig = getDifficultyConfig(settings.difficulty)

  // Initialize game mode specific state.
  // Round state survives between rounds of the same match, so only the
  // round-scoped pieces get cleared here.
  gameStateManager.resetRoundScopedState()
  if (gameMode === 'time-attack') {
    gameStateManager.initTimeAttack(180000, 5000) // 3 minutes, 5 sec bonus per kill
  }

  // Best-of-N matches apply to the versus modes only. Survival and Time Attack
  // are single continuous runs.
  // Online matches are scored by the server, so the local round system stays
  // out of the way — otherwise both would count the same round.
  const usesRounds =
    !online && gameMode !== 'survival' && gameMode !== 'time-attack' && settings.rounds > 1
  if (usesRounds && !gameStateManager.getRoundState()) {
    gameStateManager.initRounds(settings.rounds)
  } else if (!usesRounds) {
    gameStateManager.reset()
    if (gameMode === 'time-attack') {
      gameStateManager.initTimeAttack(180000, 5000)
    }
  }
  const roundState = gameStateManager.getRoundState()

  // Camera: straight down for flat top-down view
  const maxDimension = Math.max(GRID_WIDTH, GRID_HEIGHT)
  const cameraRadius = maxDimension * 1.2
  
  // On mobile for larger maps, offset the camera up so bottom row isn't covered by controls
  const isLargeMap = GRID_HEIGHT >= 17
  // Negative Z moves camera target up, shifting the visible world down (showing more of top, less of bottom)
  // We want to shift the world UP on screen (so bottom row moves away from controls)
  // That means we need the camera to look at a point with NEGATIVE Z offset
  // (Disabled since we use padding now)
  const mobileVerticalOffset = 0
  
  const camera = new ArcRotateCamera(
    'camera',
    0, // Horizontal angle
    0, // Vertical angle (straight down)
    cameraRadius,
    new Vector3(0, 0, mobileVerticalOffset),
    scene,
  )
  
  // Use orthographic camera for flat 2D look
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA
  
  const halfWorldWidth = (GRID_WIDTH * TILE_SIZE) / 2
  const halfWorldHeight = (GRID_HEIGHT * TILE_SIZE) / 2
  
  // How much of the arena the camera shows. Below 1.0 the board is cropped and
  // the camera pans to follow the player.
  //
  // Desktop shows the whole arena. Phones do their zooming in
  // applyCameraFraming instead, which derives it from the actual screen shape
  // rather than from a fixed guess — see the note there.
  const zoomFactor = 1.0
  
  // Breathing room around the arena. Kept tight on desktop so the board claims
  // as much of the window height as it can — the square arena is height-bound
  // on a landscape screen, so every unit of margin costs board size.
  const margin = isMobile() ? TILE_SIZE * 0.4 : TILE_SIZE * 0.12
  // Extra vertical margin for mobile controls - larger margin for larger maps
  const bottomMarginMobile = isLargeMap ? TILE_SIZE * 3.5 : TILE_SIZE * 2.0

  // Apply zoom by modifying the boundaries
  // Note: changing halfWorldWidth effectively changes the viewing frustum size
  
  // Calculate viewport dimensions in world units (based on playable area)
  const viewportHalfWidth = (halfWorldWidth + margin) * zoomFactor
  const viewportHalfHeight = (halfWorldHeight + margin) * zoomFactor
  
  // Add padding to the camera bottom view
  const bottomPaddingWorld = isMobile() ? (4 * TILE_SIZE) * zoomFactor : 0

  // Vertical extent needed to show the arena plus the mobile control strip
  const frameTop = viewportHalfHeight
  const frameBottom = -viewportHalfHeight - (isMobile() ? bottomMarginMobile * zoomFactor : 0) - bottomPaddingWorld

  /**
   * Fit the arena into the canvas.
   *
   * An orthographic box maps straight onto the viewport, so unless its aspect
   * matches the canvas the world is scaled unevenly and square tiles come out
   * as rectangles. The box is grown — never shrunk — along whichever axis has
   * room to spare, which keeps tiles square without ever cropping more of the
   * arena than the zoom factor already intends.
   *
   * This used to run on desktop only. Phones were left with a fixed box whose
   * aspect had nothing to do with the screen, which on a tall portrait display
   * stretched every tile roughly 1.5x vertically.
   */
  function applyCameraFraming() {
    let left = -viewportHalfWidth
    let right = viewportHalfWidth
    let top = frameTop
    let bottom = frameBottom

    const renderWidth = engine.getRenderWidth() || 1
    const renderHeight = engine.getRenderHeight() || 1
    const canvasAspect = renderWidth / renderHeight
    const contentAspect = (right - left) / (top - bottom)

    if (isMobile()) {
      // Phones pin the *vertical* extent to the content — the arena plus the
      // strip reserved for the controls — and let the width follow from the
      // screen. That fills the display top to bottom with no empty bands, and
      // on a portrait screen it zooms in exactly as far as removing that dead
      // space requires, rather than by a fixed factor that was either too much
      // or too little depending on the handset. The arena's sides fall outside
      // the view and followCamera pans to keep the player on screen.
      const centerX = (left + right) / 2
      const halfWidth = ((top - bottom) * canvasAspect) / 2
      left = centerX - halfWidth
      right = centerX + halfWidth
    } else if (canvasAspect > contentAspect) {
      // Extra horizontal room — grow sideways.
      const centerX = (left + right) / 2
      const halfWidth = ((top - bottom) * canvasAspect) / 2
      left = centerX - halfWidth
      right = centerX + halfWidth
    } else {
      // Extra vertical room — grow up and down.
      const centerY = (top + bottom) / 2
      const halfHeight = ((right - left) / canvasAspect) / 2
      top = centerY + halfHeight
      bottom = centerY - halfHeight
    }

    camera.orthoLeft = left
    camera.orthoRight = right
    camera.orthoTop = top
    camera.orthoBottom = bottom
  }

  applyCameraFraming()
  // Hook the engine's own resize signal rather than window 'resize'. Babylon
  // resizes the backbuffer from a ResizeObserver, which fires after the window
  // event — listening to the window would read a stale canvas size and leave
  // the arena stretched until the next resize.
  const framingObserver = engine.onResizeObservable.add(() => {
    applyCameraFraming()
    layoutDesktopPanels()
  })
  scene.onDisposeObservable.add(() => {
    engine.onResizeObservable.remove(framingObserver)
  })

  // Fix the camera so the player can't rotate/zoom
  camera.inputs.clear()
  
  // Screen shake function
  const activeShakeIntervals: ReturnType<typeof setInterval>[] = []
  function screenShake(intensity: number = 0.3, duration: number = 200) {
    if (!settingsManager.getSettings().screenShake) return
    
    const originalPosition = camera.position.clone()
    const shakeStart = Date.now()
    
    const shakeInterval = setInterval(() => {
      const elapsed = Date.now() - shakeStart
      if (elapsed >= duration) {
        camera.position.copyFrom(originalPosition)
        clearInterval(shakeInterval)
        const idx = activeShakeIntervals.indexOf(shakeInterval)
        if (idx !== -1) activeShakeIntervals.splice(idx, 1)
        return
      }
      
      const progress = elapsed / duration
      const currentIntensity = intensity * (1 - progress)
      
      camera.position.x = originalPosition.x + (Math.random() - 0.5) * currentIntensity
      camera.position.y = originalPosition.y + (Math.random() - 0.5) * currentIntensity
      camera.position.z = originalPosition.z + (Math.random() - 0.5) * currentIntensity
    }, 16)
    activeShakeIntervals.push(shakeInterval)
  }

  // Clean up timers on scene dispose
  scene.onDisposeObservable.add(() => {
    activeShakeIntervals.forEach(clearInterval)
    activeShakeIntervals.length = 0
  })

  // Better lighting for 3D effect
  const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  light.intensity = 0.5
  
  // Add directional light for shadows
  const dirLight = new DirectionalLight('dirLight', new Vector3(-1, -2, -1), scene)
  dirLight.position = new Vector3(20, 40, 20)
  dirLight.intensity = 0.8
  
  // Only the static arena casts shadows (characters use their own shadow disc),
  // so the shadow map is rendered once instead of every frame. It is refreshed
  // on demand whenever a destructible block is blown up.
  const lowSpec = isMobile()
  const shadowGenerator = new ShadowGenerator(lowSpec ? 512 : 1024, dirLight)
  shadowGenerator.useBlurExponentialShadowMap = true
  shadowGenerator.blurKernel = lowSpec ? 16 : 32
  const shadowMap = shadowGenerator.getShadowMap()
  if (shadowMap) shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE

  /** Re-render the static shadow map after the arena geometry changes. */
  function refreshShadows() {
    const map = shadowGenerator.getShadowMap()
    if (map) map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
  }

  // Add Glow Layer for neon effect
  const glowLayer = new GlowLayer('glow', scene)
  glowLayer.intensity = 0.3

  /**
   * The glow layer re-renders every mesh in the scene into its own buffer,
   * roughly doubling the frame's draw calls. A mesh whose material has no
   * emissive contribution writes pure black into that buffer, so skipping it is
   * invisible in the result — this excludes exactly those meshes.
   */
  function excludeFromGlowIfUnlit(mesh: Mesh) {
    const mat = mesh.material as StandardMaterial | null
    if (!mat) return
    const e = mat.emissiveColor
    const emits = !!mat.emissiveTexture || (e && (e.r > 0 || e.g > 0 || e.b > 0))
    if (!emits) glowLayer.addExcludedMesh(mesh)
  }

  // Materials (using map theme colors)
  // Materials (using map theme colors) — only create materials actually used
  const wallMaterial = new StandardMaterial('wallMat', scene)
  wallMaterial.diffuseColor = mapConfig.colors.wall
  wallMaterial.specularColor = new Color3(0.1, 0.1, 0.1)
  wallMaterial.specularPower = 32

  // Create map geometry
  const paddingBottom = isMobile() ? 4 : 0
  // Online matches pass the server's seed so every client builds the identical
  // arena; offline play stays random.
  const generated = generateMap(
    GRID_WIDTH, GRID_HEIGHT, mapConfig.theme, paddingBottom, online?.seed,
  )
  const grid = generated.grid

  // Note: We do NOT update global GRID_HEIGHT here so game logic (spawns/borders)
  // stays within playable area. Visuals will handle the extra rows.

  // Helper to create a procedural texture
  const createTexture = (color: string, draw: (ctx: CanvasRenderingContext2D) => void) => {
    const tex = new DynamicTexture('tex-' + color + Math.random(), 128, scene, true)
    const ctx = tex.getContext() as CanvasRenderingContext2D
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 128, 128)
    draw(ctx)
    tex.update()
    return tex
  }

  // Create crate/barrel texture (theme-specific)
  const theme = mapConfig.theme
  const createDestructibleTexture = (theme: string) => {
    return createTexture('#8B4513', (ctx) => {
      const w = 128, h = 128
      if (theme === 'ice') {
        // ICE: a deep, solid block of ice.
        //
        // This used to be near-white (#b8dff0) on a near-white floor, with the
        // material at 85% alpha so the floor showed through as well — crates
        // and open ground were all but the same colour. A breakable block has
        // to read as an object first and as ice second, so this is much darker
        // than the floor and framed by a hard rim.
        ctx.fillStyle = '#2f6d99'
        ctx.fillRect(0, 0, w, h)
        // Bevelled face, lighter towards the top left.
        const iceFace = ctx.createLinearGradient(0, 0, w, h)
        iceFace.addColorStop(0, '#6fb4dd')
        iceFace.addColorStop(0.55, '#4a91c4')
        iceFace.addColorStop(1, '#31719d')
        ctx.fillStyle = iceFace
        ctx.fillRect(9, 9, w - 18, h - 18)
        // Bright fracture lines — high contrast against the darker body.
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(24, 34); ctx.lineTo(62, 54); ctx.lineTo(104, 38)
        ctx.moveTo(32, 92); ctx.lineTo(72, 72); ctx.lineTo(100, 98)
        ctx.stroke()
        // Hard outer rim so the silhouette stays crisp against pale ground.
        ctx.strokeStyle = '#14364f'
        ctx.lineWidth = 6
        ctx.strokeRect(3, 3, w - 6, h - 6)
      } else if (theme === 'lava') {
        // LAVA: Volcanic rock with glowing cracks
        ctx.fillStyle = '#2a1a1a'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#1a0a0a'
        ctx.fillRect(6, 6, w - 12, h - 12)
        // Glowing magma cracks
        ctx.strokeStyle = '#ff4400'
        ctx.lineWidth = 3
        ctx.shadowColor = '#ff6600'
        ctx.shadowBlur = 6
        ctx.beginPath()
        ctx.moveTo(10, 40); ctx.lineTo(45, 55); ctx.lineTo(50, 90)
        ctx.moveTo(70, 10); ctx.lineTo(80, 50); ctx.lineTo(120, 70)
        ctx.stroke()
        ctx.shadowBlur = 0
        // Pumice holes
        ctx.fillStyle = '#0a0505'
        for (let i = 0; i < 5; i++) {
          ctx.beginPath()
          ctx.arc(20 + Math.random() * 88, 20 + Math.random() * 88, 3 + Math.random() * 3, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (theme === 'forest') {
        // FOREST: a wooden crate, deliberately not foliage.
        //
        // This was previously a bush in greens (#3a5a20 / #4a7a28) sitting on a
        // green forest floor, so there was nothing to tell you which tiles you
        // could walk through. Warm timber against green ground separates by hue
        // as well as by value, and it reads as breakable at a glance.
        ctx.fillStyle = '#6b3f18'
        ctx.fillRect(0, 0, w, h)
        // Planks with darker seams between them.
        for (let i = 0; i < 4; i++) {
          const y = 8 + i * 29
          const plank = ctx.createLinearGradient(0, y, 0, y + 25)
          plank.addColorStop(0, '#a9702f')
          plank.addColorStop(0.5, '#8d5a24')
          plank.addColorStop(1, '#7a4c1d')
          ctx.fillStyle = plank
          ctx.fillRect(8, y, w - 16, 25)
        }
        // Diagonal brace, the classic "this is a crate" cue.
        ctx.strokeStyle = 'rgba(60,34,12,0.55)'
        ctx.lineWidth = 7
        ctx.beginPath()
        ctx.moveTo(12, h - 12); ctx.lineTo(w - 12, 12)
        ctx.stroke()
        // Grain flecks for a bit of life.
        ctx.strokeStyle = 'rgba(45,26,10,0.35)'
        ctx.lineWidth = 1
        for (let i = 0; i < 14; i++) {
          const gy = 10 + Math.random() * (h - 20)
          ctx.beginPath()
          ctx.moveTo(12 + Math.random() * 30, gy)
          ctx.lineTo(60 + Math.random() * 50, gy)
          ctx.stroke()
        }
        // Hard rim, same reasoning as the ice block.
        ctx.strokeStyle = '#3d2109'
        ctx.lineWidth = 6
        ctx.strokeRect(3, 3, w - 6, h - 6)
      } else if (theme === 'space') {
        // SPACE: Supply crate with markings
        ctx.fillStyle = '#3a3a4a'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#2a2a3a'
        ctx.fillRect(8, 8, w - 16, h - 16)
        // Caution stripes
        ctx.fillStyle = '#ccaa20'
        for (let i = 0; i < 6; i++) {
          ctx.save()
          ctx.translate(w / 2, h / 2)
          ctx.rotate(-Math.PI / 4)
          ctx.fillRect(-80, -64 + i * 24, 160, 8)
          ctx.restore()
        }
        // Corner bolts
        ctx.fillStyle = '#666'
        const r = 4
        ctx.beginPath(); ctx.arc(14, 14, r, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(w - 14, 14, r, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(14, h - 14, r, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(w - 14, h - 14, r, 0, Math.PI * 2); ctx.fill()
      } else if (theme === 'moon') {
        // MOON: Regolith / dust pile
        ctx.fillStyle = '#6a6a70'
        ctx.fillRect(0, 0, w, h)
        // Dusty texture spots
        for (let i = 0; i < 20; i++) {
          const shade = 80 + Math.floor(Math.random() * 40)
          ctx.fillStyle = `rgb(${shade},${shade},${shade + 5})`
          ctx.beginPath()
          ctx.arc(Math.random() * w, Math.random() * h, 5 + Math.random() * 10, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.strokeStyle = 'rgba(90,90,95,0.5)'
        ctx.lineWidth = 1
        ctx.strokeRect(10, 10, w - 20, h - 20)
      } else {
        // CLASSIC: Wooden crate
        ctx.fillStyle = '#654321'
        ctx.fillRect(10, 0, 10, 128)
        ctx.fillRect(40, 0, 10, 128)
        ctx.fillRect(70, 0, 10, 128)
        ctx.fillRect(100, 0, 10, 128)
        ctx.fillRect(0, 10, 128, 10)
        ctx.fillRect(0, 108, 128, 10)
        ctx.fillStyle = '#d97706'
        ctx.beginPath()
        ctx.arc(64, 64, 30, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#fcd34d'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.arc(64, 64, 25, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = '#ef4444'
        ctx.fillRect(0, 0, 20, 20)
        ctx.fillRect(108, 0, 20, 20)
        ctx.fillRect(0, 108, 20, 20)
        ctx.fillRect(108, 108, 20, 20)
      }
    })
  }

  const crateMaterial = new StandardMaterial('crateMat', scene)
  crateMaterial.diffuseTexture = createDestructibleTexture(theme)
  crateMaterial.specularColor = new Color3(0.1, 0.1, 0.1)
  if (theme === 'ice') {
    // Opaque. It used to be 85% alpha, which let the pale floor show through a
    // block that was already almost the floor's colour. The specular highlight
    // is what sells it as ice; transparency just cost readability.
    crateMaterial.specularColor = new Color3(0.6, 0.6, 0.6)
    crateMaterial.specularPower = 64
  }

  // Theme-specific wall texture
  const createWallTexture = (theme: string) => {
    return createTexture('#555', (ctx) => {
      const w = 128, h = 128
      if (theme === 'ice') {
        // Crystal ice pillar
        ctx.fillStyle = '#8ab8d0'
        ctx.fillRect(0, 0, w, h)
        const grad = ctx.createLinearGradient(0, 0, w, h)
        grad.addColorStop(0, 'rgba(200,230,255,0.5)')
        grad.addColorStop(0.5, 'rgba(255,255,255,0.2)')
        grad.addColorStop(1, 'rgba(180,210,240,0.5)')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)
        // Crystal facets
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(0, 30); ctx.lineTo(64, 50); ctx.lineTo(128, 20)
        ctx.moveTo(0, 80); ctx.lineTo(64, 65); ctx.lineTo(128, 90)
        ctx.stroke()
      } else if (theme === 'lava') {
        // Dark obsidian with orange veins
        ctx.fillStyle = '#1a1010'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#252015'
        ctx.fillRect(4, 4, w - 8, h - 8)
        // Glowing veins
        ctx.strokeStyle = '#cc3300'
        ctx.lineWidth = 2
        ctx.shadowColor = '#ff4400'
        ctx.shadowBlur = 4
        ctx.beginPath()
        ctx.moveTo(0, 64); ctx.lineTo(30, 50); ctx.lineTo(60, 70); ctx.lineTo(128, 55)
        ctx.stroke()
        ctx.shadowBlur = 0
      } else if (theme === 'forest') {
        // Tree bark
        ctx.fillStyle = '#4a3020'
        ctx.fillRect(0, 0, w, h)
        // Bark grain lines
        ctx.strokeStyle = '#3a2515'
        ctx.lineWidth = 3
        for (let i = 0; i < 8; i++) {
          const y = 8 + i * 15
          ctx.beginPath()
          ctx.moveTo(0, y); ctx.lineTo(40, y + 4); ctx.lineTo(90, y - 2); ctx.lineTo(128, y + 3)
          ctx.stroke()
        }
        // Knot
        ctx.fillStyle = '#2a1a0a'
        ctx.beginPath()
        ctx.ellipse(64, 64, 12, 18, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#3a2515'
        ctx.lineWidth = 2
        ctx.stroke()
      } else if (theme === 'space') {
        // Metal panel
        ctx.fillStyle = '#4a4a5a'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#3a3a4a'
        ctx.fillRect(6, 6, w - 12, h - 12)
        // Panel seams
        ctx.strokeStyle = '#2a2a3a'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h)
        ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2)
        ctx.stroke()
        // Rivets
        ctx.fillStyle = '#666'
        const rv = 3
        ctx.beginPath(); ctx.arc(12, 12, rv, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(w - 12, 12, rv, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(12, h - 12, rv, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(w - 12, h - 12, rv, 0, Math.PI * 2); ctx.fill()
        // Vent glow
        ctx.fillStyle = 'rgba(0,200,255,0.15)'
        ctx.fillRect(20, h / 2 - 3, w - 40, 6)
      } else if (theme === 'moon') {
        // Moon rock / regolith block
        ctx.fillStyle = '#5a5a60'
        ctx.fillRect(0, 0, w, h)
        // Rocky texture
        for (let i = 0; i < 15; i++) {
          const shade = 70 + Math.floor(Math.random() * 30)
          ctx.fillStyle = `rgb(${shade},${shade},${shade + 3})`
          ctx.beginPath()
          ctx.arc(Math.random() * w, Math.random() * h, 8 + Math.random() * 12, 0, Math.PI * 2)
          ctx.fill()
        }
        // Impact pock marks
        ctx.fillStyle = '#454550'
        for (let i = 0; i < 4; i++) {
          ctx.beginPath()
          ctx.arc(20 + Math.random() * 88, 20 + Math.random() * 88, 4 + Math.random() * 5, 0, Math.PI * 2)
          ctx.fill()
        }
      } else {
        // CLASSIC: Stone brick
        ctx.fillStyle = '#707078'
        ctx.fillRect(0, 0, w, h)
        // Brick mortar lines
        ctx.strokeStyle = '#55555a'
        ctx.lineWidth = 4
        // Horizontal mortar
        ctx.beginPath()
        ctx.moveTo(0, h * 0.33); ctx.lineTo(w, h * 0.33)
        ctx.moveTo(0, h * 0.66); ctx.lineTo(w, h * 0.66)
        ctx.stroke()
        // Vertical mortar (offset per row)
        ctx.beginPath()
        ctx.moveTo(w * 0.5, 0); ctx.lineTo(w * 0.5, h * 0.33)
        ctx.moveTo(w * 0.25, h * 0.33); ctx.lineTo(w * 0.25, h * 0.66)
        ctx.moveTo(w * 0.75, h * 0.33); ctx.lineTo(w * 0.75, h * 0.66)
        ctx.moveTo(w * 0.5, h * 0.66); ctx.lineTo(w * 0.5, h)
        ctx.stroke()
        // Subtle stone grain
        ctx.fillStyle = 'rgba(0,0,0,0.06)'
        for (let i = 0; i < 6; i++) {
          ctx.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 30, 4)
        }
      }
    })
  }

  wallMaterial.diffuseTexture = createWallTexture(theme)
  if (theme === 'ice') {
    wallMaterial.specularColor = new Color3(0.5, 0.5, 0.6)
    wallMaterial.specularPower = 48
  } else if (theme === 'lava') {
    wallMaterial.emissiveColor = new Color3(0.08, 0.02, 0)
  } else if (theme === 'space') {
    wallMaterial.specularColor = new Color3(0.3, 0.3, 0.35)
    wallMaterial.specularPower = 48
  }

  // Create procedural floor texture based on theme
  const createFloorTexture = (theme: string) => {
    return createTexture('#222', (ctx) => {
      // Clean, modern aesthetic - no random noise
      const w = 128
      const h = 128
      
      // Base background
      ctx.fillStyle = theme === 'ice' ? '#e8f4f8' : 
                      theme === 'lava' ? '#2a0a0a' : 
                      theme === 'forest' ? '#0a2a0a' :
                      theme === 'moon' ? '#2a2a2e' : '#1a1a1a'
      ctx.fillRect(0, 0, w, h)
      
      // GRID LINES - Thicker, cleaner borders
      // This is crucial for gameplay to see the squares clearly
      ctx.strokeStyle = 'rgba(0,0,0,0.2)'
      ctx.lineWidth = 14 // Thick outer shadow
      ctx.strokeRect(0, 0, w, h)
      
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 2 // Subtle inner highlight
      ctx.strokeRect(6, 6, w-12, h-12)

      if (theme === 'ice') {
        // ICE: Slick, reflective diagonal sheen
        // Instead of random cracks, use controlled geometric shapes
        const grad = ctx.createLinearGradient(0, 0, w, h)
        grad.addColorStop(0, 'rgba(255,255,255,0)')
        grad.addColorStop(0.45, 'rgba(255,255,255,0)')
        grad.addColorStop(0.5, 'rgba(255,255,255,0.4)') // Sharp reflection line
        grad.addColorStop(0.55, 'rgba(255,255,255,0)')
        grad.addColorStop(1, 'rgba(255,255,255,0)')
        
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)
        
      } else if (theme === 'lava') {
        // LAVA: Industrial grate or plating look
        // Dark metallic plates with heat glow from underneath
        ctx.fillStyle = '#111'
        ctx.fillRect(10, 10, w-20, h-20) // Inner plate
        
        // Corner bolts
        ctx.fillStyle = '#333'
        const r = 4
        ctx.beginPath(); ctx.arc(16, 16, r, 0, Math.PI*2); ctx.fill()
        ctx.beginPath(); ctx.arc(w-16, 16, r, 0, Math.PI*2); ctx.fill()
        ctx.beginPath(); ctx.arc(16, h-16, r, 0, Math.PI*2); ctx.fill()
        ctx.beginPath(); ctx.arc(w-16, h-16, r, 0, Math.PI*2); ctx.fill()
        
        // Heat vents
        ctx.fillStyle = '#ff3300' // Magma glow
        for(let i=0; i<3; i++) {
           ctx.fillRect(30, 30 + (i*25), w-60, 10)
        }
        
      } else if (theme === 'forest') {
        // FOREST: Tech-organic pattern
        // Hexagonal or circuit-like green pattern
        ctx.strokeStyle = '#2d4'
        ctx.lineWidth = 3
        
        // Draw a diamond shape
        ctx.beginPath()
        ctx.moveTo(w/2, 20)
        ctx.lineTo(w-20, h/2)
        ctx.lineTo(w/2, h-20)
        ctx.lineTo(20, h/2)
        ctx.closePath()
        ctx.stroke()
        
        // Center node
        ctx.fillStyle = '#060'
        ctx.beginPath()
        ctx.arc(w/2, h/2, 10, 0, Math.PI*2)
        ctx.fill()

      } else if (theme === 'space') {
        // SPACE: Cosmic void with stars
        const grad = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, 80)
        grad.addColorStop(0, '#2a0a4a') // Lighter purple center
        grad.addColorStop(1, '#050010') // Black void edges
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)

        // Random stars
        ctx.fillStyle = '#fff'
        for(let i=0; i<15; i++) {
            const x = Math.random() * w
            const y = Math.random() * h
            const s = Math.random() * 1.5
            ctx.globalAlpha = Math.random() * 0.8 + 0.2
            ctx.beginPath()
            ctx.arc(x, y, s, 0, Math.PI*2)
            ctx.fill()
        }
        ctx.globalAlpha = 1.0

        // Holographic grid marker
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.3)'
        ctx.lineWidth = 1
        ctx.strokeRect(10, 10, w-20, h-20)
        
        // Center crosshair
        ctx.beginPath()
        ctx.moveTo(w/2 - 5, h/2); ctx.lineTo(w/2 + 5, h/2)
        ctx.moveTo(w/2, h/2 - 5); ctx.lineTo(w/2, h/2 + 5)
        ctx.stroke()

      } else if (theme === 'moon') {
        // MOON: Grey dusty regolith surface
        const grad = ctx.createRadialGradient(w/2, h/2, 5, w/2, h/2, 70)
        grad.addColorStop(0, '#3a3a40')
        grad.addColorStop(1, '#252528')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)

        // Tiny craters / pock marks
        for (let i = 0; i < 6; i++) {
          const cx = 15 + Math.random() * (w - 30)
          const cy = 15 + Math.random() * (h - 30)
          const cr = 2 + Math.random() * 4
          ctx.fillStyle = 'rgba(0,0,0,0.15)'
          ctx.beginPath()
          ctx.arc(cx, cy, cr, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ctx.beginPath()
          ctx.arc(cx - 1, cy - 1, cr * 0.6, 0, Math.PI * 2)
          ctx.fill()
        }
        
        // Boot print impression (subtle)
        ctx.strokeStyle = 'rgba(50,50,55,0.3)'
        ctx.lineWidth = 1
        ctx.strokeRect(30, 40, 25, 48)
        
      } else {
        // CLASSIC: The "Neon Grid" look
        // Simple darker center to emphasize the tile definition
        ctx.fillStyle = 'rgba(0,0,0,0.1)'
        ctx.fillRect(16, 16, w-32, h-32)
        
        // Plus sign in middle for alignment
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(w/2, 40); ctx.lineTo(w/2, h-40)
        ctx.moveTo(40, h/2); ctx.lineTo(w-40, h/2)
        ctx.stroke()
      }
    })
  }

  const floorTexture = createFloorTexture(mapConfig.theme)

  // Create shared tile materials (2 for checkered pattern) instead of one per tile
  const baseColor = mapConfig.colors.ground
  const tileMatLight = new StandardMaterial('tileMat-light', scene)
  tileMatLight.diffuseTexture = floorTexture
  tileMatLight.diffuseColor = baseColor
  tileMatLight.specularColor = new Color3(0.05, 0.05, 0.05)

  const tileMatDark = new StandardMaterial('tileMat-dark', scene)
  tileMatDark.diffuseTexture = floorTexture
  tileMatDark.diffuseColor = baseColor.scale(0.85)
  tileMatDark.specularColor = new Color3(0.05, 0.05, 0.05)

  // Shared wall-decoration materials (avoid per-tile material creation)
  const sharedCanopyMat = new StandardMaterial('canopyMat-shared', scene)
  sharedCanopyMat.diffuseColor = new Color3(0.15, 0.5, 0.1)
  sharedCanopyMat.specularColor = new Color3(0.05, 0.05, 0.05)
  const sharedLavaGlowMat = new StandardMaterial('lavaGlow-shared', scene)
  sharedLavaGlowMat.emissiveColor = new Color3(0.8, 0.2, 0)
  sharedLavaGlowMat.diffuseColor = new Color3(0, 0, 0)
  sharedLavaGlowMat.alpha = 0.5
  const sharedAntennaMat = new StandardMaterial('antenna-shared', scene)
  sharedAntennaMat.diffuseColor = new Color3(0.5, 0.5, 0.55)
  sharedAntennaMat.emissiveColor = new Color3(0, 0.1, 0.15)

  // The arena is completely static once built, so every tile/wall/decoration is
  // collected here and merged into a handful of meshes at the end. A 17x17 map
  // used to issue ~550 draw calls per frame; merging cuts that to single digits
  // for the arena without changing how anything looks.
  const floorLight: Mesh[] = []
  const floorDark: Mesh[] = []
  const staticWallMeshes: Mesh[] = []

  // Per-theme crate geometry. The mesh sits at the origin; each crate's
  // position, tilt and squash live in its own instance matrix.
  const destructibleShape = (() => {
    if (theme === 'forest') {
      return {
        mesh: MeshBuilder.CreateSphere('crate-template', { diameter: TILE_SIZE * 0.75, segments: 6 }, scene),
        scaling: new Vector3(1, 0.7, 1),
        height: TILE_SIZE * 0.3,
      }
    }
    if (theme === 'ice') {
      return {
        mesh: MeshBuilder.CreateBox('crate-template', {
          width: TILE_SIZE * 0.75, height: TILE_SIZE * 0.7, depth: TILE_SIZE * 0.75,
        }, scene),
        scaling: new Vector3(1, 1, 1),
        height: TILE_SIZE * 0.35,
      }
    }
    if (theme === 'lava') {
      return {
        mesh: MeshBuilder.CreateBox('crate-template', {
          width: TILE_SIZE * 0.72, height: TILE_SIZE * 0.65, depth: TILE_SIZE * 0.72,
        }, scene),
        scaling: new Vector3(1, 1, 1),
        height: TILE_SIZE * 0.33,
      }
    }
    if (theme === 'moon') {
      return {
        mesh: MeshBuilder.CreateSphere('crate-template', { diameter: TILE_SIZE * 0.7, segments: 5 }, scene),
        scaling: new Vector3(1, 0.55, 1),
        height: TILE_SIZE * 0.2,
      }
    }
    // Classic / Space: crate box
    return {
      mesh: MeshBuilder.CreateBox('crate-template', { size: TILE_SIZE * 0.8 }, scene),
      scaling: new Vector3(1, 1, 1),
      height: TILE_SIZE * 0.4,
    }
  })()

  const crateMatrices: Matrix[] = []
  const crateIndexByTile = new Map<string, number>()
  const _crateScale = new Vector3()
  const _crateRotation = new Quaternion()
  const _cratePosition = new Vector3()
  const _crateMatrix = new Matrix()
  /** Collapsing a crate's matrix to zero scale removes it from the field. */
  const CRATE_REMOVED_MATRIX = Matrix.Scaling(0, 0, 0)

  const decorationsByMaterial = new Map<StandardMaterial, Mesh[]>()
  const collectDecoration = (mesh: Mesh, material: StandardMaterial) => {
    mesh.material = material
    const list = decorationsByMaterial.get(material)
    if (list) list.push(mesh)
    else decorationsByMaterial.set(material, [mesh])
  }

  // Create floor tiles individually for better grid visibility
  // Use grid.length to include padding rows
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const isCheckered = (x + y) % 2 === 0
      const tile = MeshBuilder.CreateGround(`tile-${x}-${y}`, {
        width: TILE_SIZE * 0.98, // Very small gap
        height: TILE_SIZE * 0.98
      }, scene)

      const pos = gridToWorld(x, y)
      tile.position.x = pos.x
      tile.position.z = pos.z
      tile.material = isCheckered ? tileMatLight : tileMatDark
      ;(isCheckered ? floorLight : floorDark).push(tile)

      if (grid[y][x] === 'wall') {
        const isBorder = x === 0 || y === 0 || x === GRID_WIDTH - 1 || y === GRID_HEIGHT - 1
        
        if (theme === 'forest') {
          // Forest: tree trunks for inner pillars, hedge wall for borders
          if (isBorder) {
            const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
              width: TILE_SIZE * 0.95, height: TILE_SIZE * 1.0, depth: TILE_SIZE * 0.95 
            }, scene)
            wall.position.x = pos.x
            wall.position.y = TILE_SIZE * 0.5
            wall.position.z = pos.z
            wall.material = wallMaterial
            staticWallMeshes.push(wall)
            wall.receiveShadows = true
          } else {
            // Tree trunk
            const trunk = MeshBuilder.CreateCylinder(`wall-${x}-${y}`, {
              diameter: TILE_SIZE * 0.45, height: TILE_SIZE * 1.6, tessellation: 8
            }, scene)
            trunk.position.x = pos.x
            trunk.position.y = TILE_SIZE * 0.8
            trunk.position.z = pos.z
            trunk.material = wallMaterial
            staticWallMeshes.push(trunk)
            trunk.receiveShadows = true
            // Tree canopy
            const canopy = MeshBuilder.CreateSphere(`canopy-${x}-${y}`, {
              diameter: TILE_SIZE * 0.9, segments: 6
            }, scene)
            canopy.position.x = pos.x
            canopy.position.y = TILE_SIZE * 1.55
            canopy.position.z = pos.z
            canopy.scaling = new Vector3(1, 0.7, 1)
            collectDecoration(canopy, sharedCanopyMat)
          }
        } else if (theme === 'ice') {
          // Ice: crystal pillars for inner, frozen wall for borders
          if (isBorder) {
            const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
              width: TILE_SIZE * 0.95, height: TILE_SIZE * 1.1, depth: TILE_SIZE * 0.95 
            }, scene)
            wall.position.x = pos.x
            wall.position.y = TILE_SIZE * 0.55
            wall.position.z = pos.z
            wall.material = wallMaterial
            staticWallMeshes.push(wall)
            wall.receiveShadows = true
          } else {
            // Ice crystal - tapered cylinder
            const crystal = MeshBuilder.CreateCylinder(`wall-${x}-${y}`, {
              diameterTop: TILE_SIZE * 0.3, diameterBottom: TILE_SIZE * 0.65,
              height: TILE_SIZE * 1.5, tessellation: 6
            }, scene)
            crystal.position.x = pos.x
            crystal.position.y = TILE_SIZE * 0.75
            crystal.position.z = pos.z
            crystal.rotation.y = Math.random() * Math.PI
            crystal.material = wallMaterial
            staticWallMeshes.push(crystal)
            crystal.receiveShadows = true
          }
        } else if (theme === 'lava') {
          // Lava: rocky pillars, taller with rough feel
          const h = isBorder ? TILE_SIZE * 1.3 : TILE_SIZE * 1.5
          const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
            width: TILE_SIZE * 0.88, height: h, depth: TILE_SIZE * 0.88 
          }, scene)
          wall.position.x = pos.x
          wall.position.y = h * 0.5
          wall.position.z = pos.z
          if (!isBorder) {
            // Slight random rotation for organic rock feel
            wall.rotation.y = Math.random() * 0.3 - 0.15
          }
          wall.material = wallMaterial
          staticWallMeshes.push(wall)
          wall.receiveShadows = true
          // Magma glow at base for inner pillars
          if (!isBorder) {
            const glow = MeshBuilder.CreateDisc(`lavaglow-${x}-${y}`, {
              radius: TILE_SIZE * 0.35, tessellation: 8
            }, scene)
            glow.rotation.x = Math.PI / 2
            glow.position.x = pos.x
            glow.position.y = 0.03
            glow.position.z = pos.z
            collectDecoration(glow, sharedLavaGlowMat)
          }
        } else if (theme === 'space') {
          // Space: metal panels, taller for inner
          const h = isBorder ? TILE_SIZE * 1.1 : TILE_SIZE * 1.3
          const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
            width: TILE_SIZE * 0.9, height: h, depth: TILE_SIZE * 0.9 
          }, scene)
          wall.position.x = pos.x
          wall.position.y = h * 0.5
          wall.position.z = pos.z
          wall.material = wallMaterial
          staticWallMeshes.push(wall)
          wall.receiveShadows = true
          // Antenna on some inner pillars
          if (!isBorder && Math.random() < 0.3) {
            const ant = MeshBuilder.CreateCylinder(`ant-${x}-${y}`, {
              diameter: 0.04, height: TILE_SIZE * 0.5, tessellation: 4
            }, scene)
            ant.position.x = pos.x
            ant.position.y = h + TILE_SIZE * 0.25
            ant.position.z = pos.z
            collectDecoration(ant, sharedAntennaMat)
          }
        } else if (theme === 'moon') {
          // Moon: rounded rocks
          if (isBorder) {
            const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
              width: TILE_SIZE * 0.93, height: TILE_SIZE * 1.0, depth: TILE_SIZE * 0.93 
            }, scene)
            wall.position.x = pos.x
            wall.position.y = TILE_SIZE * 0.5
            wall.position.z = pos.z
            wall.material = wallMaterial
            staticWallMeshes.push(wall)
            wall.receiveShadows = true
          } else {
            // Irregular moon rock (stretched sphere)
            const rock = MeshBuilder.CreateSphere(`wall-${x}-${y}`, {
              diameter: TILE_SIZE * 0.85, segments: 5
            }, scene)
            rock.position.x = pos.x
            rock.position.y = TILE_SIZE * 0.4
            rock.position.z = pos.z
            rock.scaling = new Vector3(
              0.9 + Math.random() * 0.2,
              0.6 + Math.random() * 0.4,
              0.9 + Math.random() * 0.2
            )
            rock.rotation.y = Math.random() * Math.PI
            rock.material = wallMaterial
            staticWallMeshes.push(rock)
            rock.receiveShadows = true
          }
        } else {
          // Classic: standard stone block wall
          const wall = MeshBuilder.CreateBox(`wall-${x}-${y}`, { 
            width: TILE_SIZE * 0.9, 
            height: TILE_SIZE * 1.2, 
            depth: TILE_SIZE * 0.9 
          }, scene)
          wall.position.x = pos.x
          wall.position.y = TILE_SIZE * 0.6
          wall.position.z = pos.z
          wall.material = wallMaterial
          staticWallMeshes.push(wall)
          wall.receiveShadows = true
        }
      } else if (grid[y][x] === 'destructible') {
        // Crates are drawn as thin instances of one template mesh, so the whole
        // field of ~180 blocks costs a single draw call instead of 180.
        const jitter = theme === 'ice' ? 0.3 : theme === 'lava' ? 0.5 : 0
        _crateScale.copyFrom(destructibleShape.scaling)
        Quaternion.RotationYawPitchRollToRef(
          jitter ? Math.random() * jitter - jitter / 2 : 0, 0, 0, _crateRotation,
        )
        _cratePosition.copyFromFloats(pos.x, destructibleShape.height, pos.z)
        Matrix.ComposeToRef(_crateScale, _crateRotation, _cratePosition, _crateMatrix)
        crateIndexByTile.set(`${x},${y}`, crateMatrices.length)
        crateMatrices.push(_crateMatrix.clone())
      }
    }
  }

  // ── Theme-specific decorations (shared materials to minimize draw calls) ──
  if (theme === 'forest') {
    const mushMatRed = new StandardMaterial('mushMat-red', scene)
    mushMatRed.diffuseColor = new Color3(0.8, 0.2, 0.15)
    mushMatRed.specularColor = new Color3(0.05, 0.05, 0.05)
    const mushMatYellow = new StandardMaterial('mushMat-yellow', scene)
    mushMatYellow.diffuseColor = new Color3(0.9, 0.85, 0.3)
    mushMatYellow.specularColor = new Color3(0.05, 0.05, 0.05)
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      for (let x = 1; x < GRID_WIDTH - 1; x++) {
        if (grid[y][x] === 'empty' && Math.random() < 0.08) {
          const pos = gridToWorld(x, y)
          const mush = MeshBuilder.CreateCylinder(`mush-${x}-${y}`, {
            diameterTop: TILE_SIZE * 0.22, diameterBottom: TILE_SIZE * 0.06,
            height: TILE_SIZE * 0.15, tessellation: 6
          }, scene)
          mush.position.x = pos.x + (Math.random() - 0.5) * 0.3
          mush.position.y = TILE_SIZE * 0.08
          mush.position.z = pos.z + (Math.random() - 0.5) * 0.3
          collectDecoration(mush, Math.random() < 0.5 ? mushMatRed : mushMatYellow)
        }
      }
    }
  } else if (theme === 'lava') {
    const poolMat = new StandardMaterial('lpool-shared', scene)
    poolMat.emissiveColor = new Color3(0.9, 0.3, 0)
    poolMat.diffuseColor = new Color3(0.6, 0.15, 0)
    poolMat.alpha = 0.7
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      for (let x = 1; x < GRID_WIDTH - 1; x++) {
        if (grid[y][x] === 'empty' && Math.random() < 0.04) {
          const pos = gridToWorld(x, y)
          const pool = MeshBuilder.CreateDisc(`lpool-${x}-${y}`, {
            radius: TILE_SIZE * 0.25, tessellation: 8
          }, scene)
          pool.rotation.x = Math.PI / 2
          pool.position.x = pos.x
          pool.position.y = 0.015
          pool.position.z = pos.z
          collectDecoration(pool, poolMat)
        }
      }
    }
  } else if (theme === 'ice') {
    const shardMat = new StandardMaterial('shard-shared', scene)
    shardMat.diffuseColor = new Color3(0.7, 0.85, 0.95)
    shardMat.specularColor = new Color3(0.8, 0.8, 0.9)
    shardMat.alpha = 0.7
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      for (let x = 1; x < GRID_WIDTH - 1; x++) {
        if (grid[y][x] === 'empty' && Math.random() < 0.06) {
          const pos = gridToWorld(x, y)
          const shard = MeshBuilder.CreateCylinder(`shard-${x}-${y}`, {
            diameterTop: 0, diameterBottom: TILE_SIZE * 0.1,
            height: TILE_SIZE * 0.25, tessellation: 4
          }, scene)
          shard.position.x = pos.x + (Math.random() - 0.5) * 0.3
          shard.position.y = TILE_SIZE * 0.12
          shard.position.z = pos.z + (Math.random() - 0.5) * 0.3
          shard.rotation.x = (Math.random() - 0.5) * 0.4
          shard.rotation.z = (Math.random() - 0.5) * 0.4
          collectDecoration(shard, shardMat)
        }
      }
    }
  } else if (theme === 'space') {
    const slMatCyan = new StandardMaterial('sl-cyan', scene)
    slMatCyan.emissiveColor = new Color3(0, 0.6, 0.8)
    slMatCyan.diffuseColor = new Color3(0, 0, 0)
    const slMatPurple = new StandardMaterial('sl-purple', scene)
    slMatPurple.emissiveColor = new Color3(0.6, 0, 0.8)
    slMatPurple.diffuseColor = new Color3(0, 0, 0)
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      for (let x = 1; x < GRID_WIDTH - 1; x++) {
        if (grid[y][x] === 'empty' && Math.random() < 0.05) {
          const pos = gridToWorld(x, y)
          const sLight = MeshBuilder.CreateDisc(`slight-${x}-${y}`, {
            radius: TILE_SIZE * 0.08, tessellation: 6
          }, scene)
          sLight.rotation.x = Math.PI / 2
          sLight.position.x = pos.x
          sLight.position.y = 0.015
          sLight.position.z = pos.z
          collectDecoration(sLight, Math.random() < 0.5 ? slMatCyan : slMatPurple)
        }
      }
    }
  } else if (theme === 'moon') {
    const pebMat = new StandardMaterial('peb-shared', scene)
    pebMat.diffuseColor = new Color3(0.45, 0.45, 0.48)
    pebMat.specularColor = new Color3(0.05, 0.05, 0.05)
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      for (let x = 1; x < GRID_WIDTH - 1; x++) {
        if (grid[y][x] === 'empty' && Math.random() < 0.07) {
          const pos = gridToWorld(x, y)
          const pebble = MeshBuilder.CreateSphere(`peb-${x}-${y}`, {
            diameter: TILE_SIZE * 0.08, segments: 3
          }, scene)
          pebble.position.x = pos.x + (Math.random() - 0.5) * 0.4
          pebble.position.y = TILE_SIZE * 0.04
          pebble.position.z = pos.z + (Math.random() - 0.5) * 0.4
          pebble.scaling.y = 0.5
          collectDecoration(pebble, pebMat)
        }
      }
    }
  }

  // ── Bake the static arena into a few merged meshes ──
  // Everything above is fixed for the whole round, so collapsing it by material
  // trades a one-off build cost for a permanently smaller per-frame draw list.
  function bakeStatic(meshes: Mesh[], name: string, material: StandardMaterial, receiveShadows: boolean): Mesh | null {
    if (meshes.length === 0) return null
    const merged = meshes.length === 1
      ? meshes[0]
      : Mesh.MergeMeshes(meshes, true, true, undefined, false, false)
    if (!merged) return null
    merged.name = name
    merged.material = material
    merged.receiveShadows = receiveShadows
    merged.isPickable = false
    merged.doNotSyncBoundingInfo = true
    merged.freezeWorldMatrix()
    excludeFromGlowIfUnlit(merged)
    return merged
  }

  // Upload the crate field as one instanced batch.
  const crateBuffer = new Float32Array(crateMatrices.length * 16)
  crateMatrices.forEach((m, i) => m.copyToArray(crateBuffer, i * 16))
  destructibleShape.mesh.material = crateMaterial
  destructibleShape.mesh.receiveShadows = true
  destructibleShape.mesh.isPickable = false
  // The arena always fills the view, so skip per-frame culling maths that would
  // otherwise need the thin-instance bounds recomputed on every destruction.
  destructibleShape.mesh.alwaysSelectAsActiveMesh = true
  destructibleShape.mesh.thinInstanceSetBuffer('matrix', crateBuffer, 16, false)
  shadowGenerator.addShadowCaster(destructibleShape.mesh)
  excludeFromGlowIfUnlit(destructibleShape.mesh)

  /** Hide the crate on a tile by zeroing its instance matrix. */
  function removeCrateAt(x: number, y: number): boolean {
    const index = crateIndexByTile.get(`${x},${y}`)
    if (index === undefined) return false
    crateIndexByTile.delete(`${x},${y}`)
    destructibleShape.mesh.thinInstanceSetMatrixAt(index, CRATE_REMOVED_MATRIX, true)
    return true
  }

  bakeStatic(floorLight, 'floor-light', tileMatLight, true)
  bakeStatic(floorDark, 'floor-dark', tileMatDark, true)
  const mergedWalls = bakeStatic(staticWallMeshes, 'walls', wallMaterial, true)
  if (mergedWalls) shadowGenerator.addShadowCaster(mergedWalls)

  decorationsByMaterial.forEach((meshes, material) => {
    bakeStatic(meshes, `deco-${material.name}`, material, false)
  })

  // Static materials never change either — freezing skips their dirty checks.
  ;[tileMatLight, tileMatDark, wallMaterial, crateMaterial].forEach(m => m.freeze())
  decorationsByMaterial.forEach((_meshes, material) => material.freeze())

  refreshShadows()

  // Create player as an animated sprite or emoji fallback

  // Create 3D character mesh
  const createPlayerSprite = (name: string, _textureUrl: string | null, _emoji: string, colorHex: string): any => {
    // Parent mesh (pivot)
    const root = new TransformNode(name + '-root', scene)
    
    // ── Materials ──
    const bodyMat = new StandardMaterial(name + '-bodyMat', scene)
    bodyMat.diffuseColor = Color3.FromHexString(colorHex)
    bodyMat.specularColor = new Color3(0.3, 0.3, 0.3)
    bodyMat.specularPower = 16

    const skinMat = new StandardMaterial(name + '-skinMat', scene)
    skinMat.diffuseColor = new Color3(1.0, 0.85, 0.72)
    skinMat.specularColor = new Color3(0.05, 0.05, 0.05)

    const darkMat = new StandardMaterial(name + '-darkMat', scene)
    darkMat.diffuseColor = new Color3(0.08, 0.08, 0.08)
    darkMat.specularColor = new Color3(0.2, 0.2, 0.2)

    const whiteMat = new StandardMaterial(name + '-whiteMat', scene)
    whiteMat.diffuseColor = new Color3(1, 1, 1)
    whiteMat.emissiveColor = new Color3(0.6, 0.6, 0.6)

    const shoeMat = new StandardMaterial(name + '-shoeMat', scene)
    shoeMat.diffuseColor = new Color3(0.25, 0.15, 0.1)
    shoeMat.specularColor = new Color3(0.15, 0.15, 0.15)

    // Brighter version of body color for accents
    const accent = Color3.FromHexString(colorHex)
    const accentMat = new StandardMaterial(name + '-accentMat', scene)
    accentMat.diffuseColor = new Color3(
      Math.min(1, accent.r * 1.3 + 0.15),
      Math.min(1, accent.g * 1.3 + 0.15),
      Math.min(1, accent.b * 1.3 + 0.15)
    )
    accentMat.specularColor = new Color3(0.2, 0.2, 0.2)

    // Shape selection (cat/dog/classic)
    let shape = 'sphere'
    if (name.startsWith('player')) {
      // Covers both 'player' and 'player2' — the old check looked for
      // 'player-2', so Player 2 never picked up the chosen character shape.
      shape = settingsManager.getSettings().characterShape || 'sphere'
    } else if (name.includes('enemy')) {
      shape = ['sphere', 'cat', 'dog'][Math.floor(Math.random() * 3)]
    }

    const T = TILE_SIZE

    // ── TORSO ──
    const torso = MeshBuilder.CreateCylinder(name + '-torso', {
      height: T * 0.3, diameterTop: T * 0.34, diameterBottom: T * 0.38, tessellation: 12
    }, scene)
    torso.position.y = T * 0.28
    torso.material = bodyMat
    torso.parent = root

    // Belt / waist accent stripe
    const belt = MeshBuilder.CreateTorus(name + '-belt', {
      diameter: T * 0.37, thickness: T * 0.04, tessellation: 16
    }, scene)
    belt.position.y = T * 0.17
    belt.material = accentMat
    belt.parent = root

    // ── HEAD ──
    let head: any
    let ears: any[] = []

    if (shape === 'cat') {
      head = MeshBuilder.CreateSphere(name + '-head', { diameter: T * 0.38, segments: 10 }, scene)
      head.material = skinMat

      // Shared inner ear material
      const pinkMat = new StandardMaterial(name + '-pinkMat', scene)
      pinkMat.diffuseColor = new Color3(1, 0.65, 0.7)
      pinkMat.specularColor = new Color3(0, 0, 0)

      // Pointed ears
      for (const side of [-1, 1]) {
        const ear = MeshBuilder.CreateCylinder(name + '-ear' + side, {
          height: 0.18, diameterTop: 0, diameterBottom: 0.14, tessellation: 4
        }, scene)
        ear.material = bodyMat
        ear.position = new Vector3(side * 0.11, 0.18, 0)
        ear.rotation.z = side * 0.35
        ear.parent = head

        // Inner ear pink
        const earInner = MeshBuilder.CreateCylinder(name + '-earIn' + side, {
          height: 0.12, diameterTop: 0, diameterBottom: 0.08, tessellation: 4
        }, scene)
        earInner.material = pinkMat
        earInner.position.y = 0.01
        earInner.parent = ear
        ears.push(ear)
      }

      // Whiskers
      for (const side of [-1, 1]) {
        for (const yOff of [-0.02, 0.02]) {
          const whisker = MeshBuilder.CreateCylinder(name + '-wh' + side + yOff, {
            height: 0.22, diameter: 0.012
          }, scene)
          whisker.rotation.z = Math.PI / 2
          whisker.rotation.y = side * 0.25
          whisker.position = new Vector3(side * 0.13, -0.03 + yOff, 0.14)
          whisker.material = darkMat
          whisker.parent = head
        }
      }

      // Small nose triangle
      const nose = MeshBuilder.CreateSphere(name + '-catNose', { diameter: 0.05 }, scene)
      const noseMat = new StandardMaterial(name + '-noseMat', scene)
      noseMat.diffuseColor = new Color3(1, 0.5, 0.55)
      noseMat.specularColor = new Color3(0, 0, 0)
      nose.material = noseMat
      nose.position = new Vector3(0, -0.04, 0.17)
      nose.scaling.z = 0.6
      nose.parent = head

    } else if (shape === 'dog') {
      head = MeshBuilder.CreateSphere(name + '-head', { diameter: T * 0.38, segments: 10 }, scene)
      head.material = skinMat

      // Floppy ears
      for (const side of [-1, 1]) {
        const ear = MeshBuilder.CreateBox(name + '-ear' + side, {
          width: 0.1, height: 0.28, depth: 0.06
        }, scene)
        ear.material = bodyMat
        ear.position = new Vector3(side * 0.18, 0.06, -0.02)
        ear.rotation.z = side * (Math.PI - 0.35)
        ear.parent = head
        ears.push(ear)
      }

      // Snout
      const snout = MeshBuilder.CreateCylinder(name + '-snout', {
        height: 0.18, diameterTop: 0.1, diameterBottom: 0.14, tessellation: 8
      }, scene)
      snout.rotation.x = Math.PI / 2
      snout.position = new Vector3(0, -0.04, 0.19)
      snout.material = skinMat
      snout.parent = head

      // Nose
      const nose = MeshBuilder.CreateSphere(name + '-dogNose', { diameter: 0.07 }, scene)
      nose.material = darkMat
      nose.position = new Vector3(0, -0.02, 0.28)
      nose.parent = head

      // Tongue
      const tongue = MeshBuilder.CreateBox(name + '-tongue', { width: 0.04, height: 0.08, depth: 0.02 }, scene)
      const tongueMat = new StandardMaterial(name + '-tongueMat', scene)
      tongueMat.diffuseColor = new Color3(1, 0.4, 0.45)
      tongueMat.specularColor = new Color3(0.3, 0.1, 0.1)
      tongue.material = tongueMat
      tongue.position = new Vector3(0, -0.1, 0.2)
      tongue.parent = head

    } else {
      // ── Classic humanoid head ──
      head = MeshBuilder.CreateSphere(name + '-head', { diameter: T * 0.36, segments: 10 }, scene)
      head.material = skinMat

      // Helmet / hair cap
      const helmet = MeshBuilder.CreateSphere(name + '-helmet', { diameter: T * 0.38, slice: 0.5 }, scene)
      helmet.rotation.x = Math.PI
      helmet.position.y = 0.02
      helmet.material = bodyMat
      helmet.parent = head

      // Mouth (tiny smile)
      const mouth = MeshBuilder.CreateTorus(name + '-mouth', {
        diameter: 0.07, thickness: 0.015, tessellation: 12
      }, scene)
      mouth.material = darkMat
      mouth.position = new Vector3(0, -0.06, 0.15)
      mouth.rotation.x = -0.3
      mouth.scaling = new Vector3(1, 0.5, 0.5)
      mouth.parent = head
    }

    head.position.y = T * 0.56
    head.parent = root

    // ── EYES ──  (white sclera + dark pupil + tiny white shine)
    const eyeSpread = shape === 'dog' ? 0.085 : 0.07
    const eyeForward = shape === 'dog' ? 0.17 : 0.14
    const eyeHeight = shape === 'cat' ? 0.03 : 0.04

    // Shared enemy eye material (hoisted outside loop)
    let enemyEyeMat: StandardMaterial | null = null
    if (name.includes('enemy')) {
      enemyEyeMat = new StandardMaterial(name + '-enemyEyeMat', scene)
      enemyEyeMat.diffuseColor = new Color3(0.9, 0.1, 0.1)
      enemyEyeMat.emissiveColor = new Color3(0.6, 0, 0)
    }

    for (const side of [-1, 1]) {
      // Sclera (white)
      const sclera = MeshBuilder.CreateSphere(name + '-sclera' + side, { diameter: T * 0.1, segments: 8 }, scene)
      sclera.position = new Vector3(side * eyeSpread * T, eyeHeight * T, eyeForward * T)
      sclera.scaling.z = 0.55
      sclera.material = whiteMat
      sclera.parent = head

      // Pupil
      const pupil = MeshBuilder.CreateSphere(name + '-pupil' + side, { diameter: T * 0.06, segments: 8 }, scene)
      pupil.position = new Vector3(0, 0, 0.02)
      pupil.scaling.z = 0.5
      pupil.parent = sclera

      if (enemyEyeMat) {
        pupil.material = enemyEyeMat
      } else {
        pupil.material = darkMat
      }

      // Specular shine dot
      const shine = MeshBuilder.CreateSphere(name + '-shine' + side, { diameter: T * 0.025 }, scene)
      shine.position = new Vector3(0.01, 0.015, 0.025)
      shine.material = whiteMat
      shine.parent = sclera
    }

    // ── ARMS (upper + forearm + hand) ──
    const armParts: { upper: any; lower: any; hand: any }[] = []
    for (const side of [-1, 1]) {
      // Upper arm
      const upper = MeshBuilder.CreateCylinder(name + '-upperArm' + side, {
        height: T * 0.16, diameterTop: T * 0.08, diameterBottom: T * 0.07, tessellation: 8
      }, scene)
      upper.material = bodyMat
      upper.position = new Vector3(side * T * 0.22, T * 0.36, 0)
      upper.parent = root

      // Forearm
      const lower = MeshBuilder.CreateCylinder(name + '-forearm' + side, {
        height: T * 0.14, diameterTop: T * 0.065, diameterBottom: T * 0.06, tessellation: 8
      }, scene)
      lower.material = skinMat
      lower.position.y = -T * 0.14
      lower.parent = upper

      // Hand (sphere)
      const hand = MeshBuilder.CreateSphere(name + '-hand' + side, { diameter: T * 0.08, segments: 6 }, scene)
      hand.material = skinMat
      hand.position.y = -T * 0.1
      hand.parent = lower

      armParts.push({ upper, lower, hand })
    }

    // ── LEGS (thigh + shin + foot) ──
    const legParts: { thigh: any; shin: any; foot: any }[] = []
    for (const side of [-1, 1]) {
      // Thigh
      const thigh = MeshBuilder.CreateCylinder(name + '-thigh' + side, {
        height: T * 0.16, diameterTop: T * 0.1, diameterBottom: T * 0.08, tessellation: 8
      }, scene)
      thigh.material = bodyMat
      thigh.position = new Vector3(side * T * 0.1, T * 0.12, 0)
      thigh.parent = root

      // Shin
      const shin = MeshBuilder.CreateCylinder(name + '-shin' + side, {
        height: T * 0.12, diameterTop: T * 0.07, diameterBottom: T * 0.06, tessellation: 8
      }, scene)
      shin.material = skinMat
      shin.position.y = -T * 0.13
      shin.parent = thigh

      // Foot (slightly elongated box)
      const foot = MeshBuilder.CreateBox(name + '-foot' + side, {
        width: T * 0.09, height: T * 0.05, depth: T * 0.14
      }, scene)
      foot.material = shoeMat
      foot.position = new Vector3(0, -T * 0.085, T * 0.02)
      foot.parent = shin

      legParts.push({ thigh, shin, foot })
    }

    // ── Tail (for animals) ──
    if (shape === 'cat') {
      const tail = MeshBuilder.CreateCylinder(name + '-tail', { height: 0.35, diameterTop: 0.02, diameterBottom: 0.05, tessellation: 6 }, scene)
      tail.material = bodyMat
      tail.position = new Vector3(0, T * 0.25, -T * 0.2)
      tail.rotation.x = Math.PI / 3
      tail.parent = root
    } else if (shape === 'dog') {
      const tail = MeshBuilder.CreateCylinder(name + '-tail', { height: 0.3, diameterTop: 0.03, diameterBottom: 0.06, tessellation: 6 }, scene)
      tail.material = bodyMat
      tail.position = new Vector3(0, T * 0.32, -T * 0.18)
      tail.rotation.x = -Math.PI / 5
      tail.parent = root
    }

    // ── Shadow disc under character ──
    const shadow = MeshBuilder.CreateDisc(name + '-shadow', { radius: T * 0.2, tessellation: 12 }, scene)
    shadow.rotation.x = Math.PI / 2
    shadow.position.y = 0.01
    const shadowMat = new StandardMaterial(name + '-shadowMat', scene)
    shadowMat.diffuseColor = new Color3(0, 0, 0)
    shadowMat.alpha = 0.35
    shadowMat.specularColor = new Color3(0, 0, 0)
    shadow.material = shadowMat
    shadow.parent = root

    // ── ANIMATION STATE ──
    let isMoving = false
    let animTime = 0
    let squashTimer = 0 // for landing / bomb-place squash

    const observer = scene.onBeforeRenderObservable.add(() => {
      const dt = scene.getEngine().getDeltaTime()

      // Squash-stretch recovery (used when landing or placing bomb)
      if (squashTimer > 0) {
        squashTimer -= dt
        const t = Math.max(0, squashTimer / 200) // 200ms effect
        const squash = 1 - t * 0.2
        const stretch = 1 + t * 0.15
        root.scaling.copyFromFloats(stretch, squash, stretch)
        if (squashTimer <= 0) {
          root.scaling.copyFromFloats(1, 1, 1)
        }
      }

      if (isMoving) {
        animTime += dt * 0.004 // speed factor

        const walkCycle = animTime * 5 // ~5 rad/s for a brisk walk

        // ── Arms swing opposite ──
        const armSwing = Math.sin(walkCycle) * 0.25
        armParts[0].upper.rotation.x = armSwing
        armParts[1].upper.rotation.x = -armSwing
        // Forearms bend when swinging back
        armParts[0].lower.rotation.x = Math.max(0, -armSwing) * 0.35
        armParts[1].lower.rotation.x = Math.max(0, armSwing) * 0.35

        // ── Legs swing opposite ──
        const legSwing = Math.sin(walkCycle) * 0.28
        legParts[0].thigh.rotation.x = -legSwing
        legParts[1].thigh.rotation.x = legSwing
        // Knees bend on back-swing
        legParts[0].shin.rotation.x = Math.max(0, legSwing) * 0.35
        legParts[1].shin.rotation.x = Math.max(0, -legSwing) * 0.35

        // ── Body bob (double-frequency of steps) ──
        const bob = Math.abs(Math.sin(walkCycle)) * T * 0.03
        torso.position.y = T * 0.28 + bob
        head.position.y = T * 0.56 + bob

        // ── Slight torso lean forward ──
        torso.rotation.x = 0.05

        // ── Subtle body sway ──
        torso.rotation.z = Math.sin(walkCycle) * 0.025
        head.rotation.z = Math.sin(walkCycle) * 0.012

        // ── Shadow pulse ──
        const sBob = 1 - bob * 1.5
        shadow.scaling.copyFromFloats(sBob, sBob, sBob)

      } else {
        // ── IDLE: gentle breathing ──
        animTime += dt * 0.001 // accumulate for idle too
        const breathe = Math.sin(animTime * 2.5) * T * 0.008
        head.position.y = T * 0.56 + breathe
        torso.position.y = T * 0.28 + breathe * 0.5
        torso.rotation.x = 0
        torso.rotation.z = 0
        head.rotation.z = 0

        // Gentle arm sway
        const idleSway = Math.sin(animTime * 2.0) * 0.06
        armParts[0].upper.rotation.x = idleSway
        armParts[1].upper.rotation.x = -idleSway
        armParts[0].lower.rotation.x = 0.1
        armParts[1].lower.rotation.x = 0.1

        // Legs neutral
        legParts[0].thigh.rotation.x = 0
        legParts[1].thigh.rotation.x = 0
        legParts[0].shin.rotation.x = 0
        legParts[1].shin.rotation.x = 0

        shadow.scaling.copyFromFloats(1, 1, 1)
      }
    })

    root.onDisposeObservable.add(() => {
      scene.onBeforeRenderObservable.remove(observer)
      bodyMat.dispose(); skinMat.dispose(); darkMat.dispose()
      whiteMat.dispose(); shoeMat.dispose(); accentMat.dispose()
    })

    // Bodies, limbs and clothing are unlit; only the eyes glow. Skipping the
    // rest in the glow pass is a no-op visually but removes ~30 draw calls per
    // character every frame.
    for (const child of root.getChildMeshes()) {
      excludeFromGlowIfUnlit(child as Mesh)
    }

    ;(root as any).playAnimation = (anim: string) => {
      if (anim.startsWith('walk')) {
        isMoving = true

        const targetRot =
          anim === 'walk-up' ? -Math.PI / 2 :
          anim === 'walk-down' ? Math.PI / 2 :
          anim === 'walk-left' ? Math.PI : 0

        root.rotation.y = targetRot

        if ((root as any).stopTimer) clearTimeout((root as any).stopTimer)
        ;(root as any).stopTimer = setTimeout(() => { isMoving = false }, 180)
      }
    }

    // Trigger squash-stretch (called externally when placing bomb)
    ;(root as any).triggerSquash = () => { squashTimer = 200 }

    return root as any
  }

  const player = createPlayerSprite('player', null, '🧑', settings.player1Color)
  ;(player as any)._cachedChildMeshes = player.getChildMeshes()
  let playerGridX = generated.playerSpawn.x
  let playerGridY = generated.playerSpawn.y
  const playerPos = gridToWorld(playerGridX, playerGridY)
  player.position.x = playerPos.x
  player.position.y = TILE_SIZE * 0.5
  player.position.z = playerPos.z
  
  // Player stats (affected by difficulty)
  let maxBombs = 1
  let currentBombs = 0
  let blastRadius = 1
  let playerLives = difficultyConfig.playerStartingLives
  let playerInvulnerable = false
  let playerInvulnerableTimer = 0
  let hasKick = false
  let hasThrow = false
  let playerSpeed = 1
  let moveDelay = 150 // milliseconds between moves
  let lastMoveTime = 0
  
  // Extended power-up state (Player 1)
  let shieldCharges = 0       // Absorbs hits (max 3)
  let hasPierce = false        // Blasts go through destructible blocks
  let ghostTimer = 0           // Remaining ms of ghost mode (walk through blocks)
  let powerBombCharges = 0     // Next bomb gets +3 blast radius
  let hasLineBomb = false       // Place row of bombs in facing direction
  
  // Smooth movement - visual position interpolates towards grid position
  let playerVisualX = playerPos.x
  let playerVisualZ = playerPos.z
  const MOVE_LERP_SPEED = 15 // Higher = faster interpolation

  // Determine number of enemies based on game mode.
  // Online matches are humans only — no AI is spawned.
  const numEnemies = online ? 0 :
                     gameMode === '1v1' ? 1 :
                     gameMode === '1v2' ? 2 :
                     gameMode === '1v3' ? 3 :
                     gameMode === 'time-attack' ? 3 :
                     gameMode === 'survival' ? 1 : 0
  
  // Survival mode state
  let survivalWave = 1
  let survivalScore = 0

  // Enemy spawn positions (validated by the map generator, so no fractional
  // coordinates and always inside a carved-out safe corner)
  const enemySpawns: SpawnPoint[] = generated.enemySpawns

  // Create enemies
  const enemies: Enemy[] = []
  const enemyEmojis = ['👾', '👹', '👺']
  // White, Brown, Dark Red - distinct from player settings
  const enemyColors = ['#ffffff', '#8d6e63', '#b91c1c']

  let nextEnemyId = 0

  /** Build an enemy with the loadout its difficulty (and wave) calls for. */
  function spawnEnemy(spawn: SpawnPoint, wave: number): Enemy {
    const id = nextEnemyId++
    const scaling = getWaveScaling(difficultyConfig, wave)
    const enemyMesh = createPlayerSprite(`enemy-${id}`, null, enemyEmojis[id % 3], enemyColors[id % 3])
    const enemyPos = gridToWorld(spawn.x, spawn.y)
    const enemy: Enemy = {
      id,
      x: spawn.x,
      y: spawn.y,
      mesh: enemyMesh,
      moveTimer: Math.random() * 400, // Stagger movement
      lives: scaling.lives,
      maxLives: scaling.lives,
      invulnerable: false,
      invulnerableTimer: 0,
      maxBombs: scaling.maxBombs,
      currentBombs: 0,
      blastRadius: scaling.blastRadius,
      moveInterval: scaling.moveSpeed,
      tunnelTarget: null,
      visualX: enemyPos.x,
      visualZ: enemyPos.z,
    }
    enemy.mesh.position.x = enemyPos.x
    enemy.mesh.position.y = TILE_SIZE * 0.5
    enemy.mesh.position.z = enemyPos.z
    ;(enemy.mesh as any)._cachedChildMeshes = enemy.mesh.getChildMeshes()
    return enemy
  }

  for (let i = 0; i < numEnemies; i++) {
    enemies.push(spawnEnemy(enemySpawns[i % enemySpawns.length], 1))
  }

  /** Look up an enemy by its stable id (bombs store this as ownerId). */
  function findEnemyById(id: number): Enemy | undefined {
    return enemies.find(e => e.id === id)
  }

  /**
   * Drop defeated enemies from the list. Safe now that stats live on the enemy
   * object instead of a parallel array indexed by position.
   */
  function pruneDeadEnemies() {
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].lives <= 0) enemies.splice(i, 1)
    }
  }

  // ── Networked players ──────────────────────────────────────────────────────
  // Spawn corners are the same ones the AI uses, indexed by lobby slot, so the
  // four starting positions are the four carved-out corners of the arena.
  const netPlayers: NetPlayer[] = []
  if (online) {
    const spawnForSlot = (slot: number): SpawnPoint =>
      slot === 0 ? generated.playerSpawn : enemySpawns[(slot - 1) % enemySpawns.length]

    for (const entry of online.roster) {
      const spawn = spawnForSlot(entry.slot)
      const isLocal = entry.id === online.youId
      const colour = PLAYER_COLORS[entry.slot % PLAYER_COLORS.length].value
      const mesh = createPlayerSprite(`net-${entry.slot}`, null, '🧑', colour)
      ;(mesh as any)._cachedChildMeshes = mesh.getChildMeshes()
      const world = gridToWorld(spawn.x, spawn.y)
      mesh.position.x = world.x
      mesh.position.y = TILE_SIZE * 0.5
      mesh.position.z = world.z

      netPlayers.push({
        id: entry.id,
        slot: entry.slot,
        name: entry.name,
        isLocal,
        x: spawn.x,
        y: spawn.y,
        visualX: world.x,
        visualZ: world.z,
        mesh,
        lives: online.lives,
        alive: true,
        maxBombs: 1,
        currentBombs: 0,
        blastRadius: 1,
        hasKick: false,
        hasThrow: false,
        speed: 1,
        moveDelay: 150,
        lastMoveTime: 0,
        lastDx: 0,
        lastDy: 1,
        invulnerable: false,
        invulnerableTimer: 0,
        shieldCharges: 0,
        hasPierce: false,
        ghostTimer: 0,
        powerBombCharges: 0,
        hasLineBomb: false,
        input: { dx: 0, dy: 0, bomb: false },
        inputSeq: -1,
      })
    }

    // The offline player mesh is unused online; hide it rather than branching
    // every place that touches it.
    setCharacterVisibility(player, 0)
  }

  const localNetPlayer = (): NetPlayer | undefined => netPlayers.find(p => p.isLocal)
  const netPlayerById = (id: string): NetPlayer | undefined => netPlayers.find(p => p.id === id)
  /** Bomb ownerId encoding for a networked player; offline ids stay negative. */
  const netOwnerId = (slot: number) => 1000 + slot
  const netPlayerByOwnerId = (ownerId: number): NetPlayer | undefined =>
    ownerId >= 1000 ? netPlayers.find(p => p.slot === ownerId - 1000) : undefined

  // Player 2 for PvP mode
  let player2GridX = enemySpawns[0].x
  let player2GridY = enemySpawns[0].y
  let player2Lives = difficultyConfig.playerStartingLives
  let player2Invulnerable = false
  let player2InvulnerableTimer = 0
  let player2MaxBombs = 1
  let player2CurrentBombs = 0
  let player2BlastRadius = 1
  let player2HasKick = false
  let player2HasThrow = false
  let player2Speed = 1
  let player2MoveDelay = 150
  let lastPlayer2MoveTime = 0
  let lastPlayer2Dx = 0
  let lastPlayer2Dy = -1
  
  // Extended power-up state (Player 2)
  let player2ShieldCharges = 0
  let player2HasPierce = false
  let player2GhostTimer = 0
  let player2PowerBombCharges = 0
  let player2HasLineBomb = false
  
  // Player 2 smooth movement
  let player2VisualX = 0
  let player2VisualZ = 0

  let player2: any = null
  // Online matches carry gameMode 'pvp' but drive everything from netPlayers,
  // so the local player-2 mesh must not be created — it would stand motionless
  // on top of slot 1's spawn and be walked straight through.
  if (gameMode === 'pvp' && !online) {
    player2 = createPlayerSprite('player2', null, '👤', settings.player2Color)
    ;(player2 as any)._cachedChildMeshes = player2.getChildMeshes()
    const player2Pos = gridToWorld(player2GridX, player2GridY)
    player2.position.x = player2Pos.x
    player2.position.y = TILE_SIZE * 0.5
    player2.position.z = player2Pos.z
    player2VisualX = player2Pos.x
    player2VisualZ = player2Pos.z
  }

  // Game state
  const bombs: Bomb[] = []
  const powerUps: PowerUp[] = []
  let gameOver = false
  let gameWon = false
  /** Guards against the round result being counted twice by repeated updateUI calls. */
  let roundScored = false
  
  // Chain reaction tracking
  let chainReactionCount = 0
  let chainReactionTimer: ReturnType<typeof setTimeout> | null = null

  // Clean up chain reaction timer on scene dispose
  scene.onDisposeObservable.add(() => {
    if (chainReactionTimer) { clearTimeout(chainReactionTimer); chainReactionTimer = null }
  })

  // UI for player (top-left) - positioned at bottom for mobile
  const isMobileDevice = isMobile()
  const useOnScreenControls = showOnScreenControls(settings.onScreenControls)

  // The pause button is always available — it is the only way to pause on a
  // touch device, and on desktop it stays as a visible alternative to Escape
  // regardless of the on-screen-controls setting.
  {
    const pauseBtn = document.createElement('div')
    pauseBtn.innerHTML = '⏸️'
    pauseBtn.style.position = 'absolute'
    pauseBtn.style.top = 'calc(12px + env(safe-area-inset-top, 0px))'
    pauseBtn.style.right = 'calc(12px + env(safe-area-inset-right, 0px))'
    pauseBtn.style.left = 'auto'
    pauseBtn.style.width = '44px'
    pauseBtn.style.height = '44px'
    pauseBtn.id = "game-pause-btn"
    pauseBtn.className = "game-pause-btn"
    pauseBtn.title = 'Pause (Esc)'
    pauseBtn.style.background = 'rgba(0,0,0,0.5)'
    pauseBtn.style.border = '2px solid rgba(255,255,255,0.3)'
    pauseBtn.style.borderRadius = '8px'
    pauseBtn.style.color = 'white'
    pauseBtn.style.display = 'flex'
    pauseBtn.style.alignItems = 'center'
    pauseBtn.style.justifyContent = 'center'
    pauseBtn.style.cursor = 'pointer'
    pauseBtn.style.zIndex = '2000'
    pauseBtn.style.fontSize = '20px'
    pauseBtn.style.backdropFilter = 'blur(4px)'
    
    pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    
    document.body.appendChild(pauseBtn)
  }

  const playerUIDiv = document.createElement('div')
  playerUIDiv.className = 'game-ui-panel'
  playerUIDiv.style.position = 'absolute'
  if (isMobileDevice) {
    // Bottom-center, between dpad (left) and bomb button (right)
    playerUIDiv.style.top = 'auto'
    playerUIDiv.style.bottom = 'calc(10px + env(safe-area-inset-bottom, 0px))'
    playerUIDiv.style.left = '50%'
    
    // Small scale, centered horizontally
    playerUIDiv.style.transform = 'translateX(-50%) scale(0.55)'
    playerUIDiv.style.transformOrigin = 'center bottom'
  } else {
    // PC: the arena is square, so a landscape window always leaves a gutter on
    // each side. Park the HUD there instead of over the board — it uses the
    // otherwise-dead space and stops the panel covering the bottom rows.
    // Exact placement is done by layoutDesktopPanels() once the board size and
    // the panel's rendered width are known.
    playerUIDiv.style.top = '50%'
    playerUIDiv.style.left = '12px'
    playerUIDiv.style.transformOrigin = 'left center'
    playerUIDiv.style.transform = 'translateY(-50%)'
    // Cap the width so the power-up icons wrap onto extra rows. Without this,
    // the ten Extended Power-Up icons make one very wide panel that the gutter
    // fit then has to shrink to an unreadable size.
    playerUIDiv.style.maxWidth = '210px'
  }
  playerUIDiv.style.color = 'white'
  playerUIDiv.style.fontFamily = "'Russo One', sans-serif"
  playerUIDiv.style.fontSize = isMobileDevice ? '16px' : '14px'
  playerUIDiv.style.zIndex = '1000'
  playerUIDiv.style.minWidth = isMobileDevice ? '180px' : '160px'
  playerUIDiv.style.background = isMobileDevice 
    ? 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(20,20,40,0.55) 100%)'
    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(20,20,40,0.55) 100%)'
  playerUIDiv.style.border = '2px solid rgba(255,68,68,0.3)'
  playerUIDiv.style.borderRadius = '12px'
  playerUIDiv.style.padding = isMobileDevice ? '6px 10px' : '8px 10px'
  playerUIDiv.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)'
  playerUIDiv.style.opacity = isMobileDevice ? '0.65' : '0.85'
  playerUIDiv.style.transition = 'opacity 0.2s ease'
  
  // PC: Make more visible on hover
  if (!isMobileDevice) {
    playerUIDiv.addEventListener('mouseenter', () => {
      playerUIDiv.style.opacity = '1'
      playerUIDiv.style.background = 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(20,20,40,0.9) 100%)'
    })
    playerUIDiv.addEventListener('mouseleave', () => {
      playerUIDiv.style.opacity = '0.85'
      playerUIDiv.style.background = 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(20,20,40,0.55) 100%)'
    })
  }
  document.body.appendChild(playerUIDiv)
  
  // UI for timer/rounds (top-center)
  const centerUIDiv = document.createElement('div')
  centerUIDiv.className = 'center-ui'
  centerUIDiv.style.position = 'absolute'
  if (isMobileDevice) {
    // Top center on mobile, compact — minimal footprint to avoid blocking view
    centerUIDiv.style.top = '6px'
    centerUIDiv.style.bottom = 'auto'
  } else {
    // PC: Keep at top center - doesn't block corners
    centerUIDiv.style.top = '10px'
  }
  centerUIDiv.style.left = '50%'
  centerUIDiv.style.transform = 'translateX(-50%)'
  centerUIDiv.style.color = 'white'
  centerUIDiv.style.fontFamily = "'Press Start 2P', 'Russo One', sans-serif"
  centerUIDiv.style.fontSize = isMobileDevice ? '11px' : '12px'
  centerUIDiv.style.fontWeight = 'bold'
  centerUIDiv.style.zIndex = '1000'
  centerUIDiv.style.textAlign = 'center'
  centerUIDiv.style.background = isMobileDevice
    ? 'linear-gradient(135deg, rgba(0,0,0,0.9) 0%, rgba(30,30,60,0.9) 100%)'
    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(30,30,60,0.55) 100%)'
  centerUIDiv.style.border = '3px solid rgba(255, 102, 0, 0.5)'
  centerUIDiv.style.borderRadius = '12px'
  centerUIDiv.style.padding = isMobileDevice ? '6px 14px' : '8px 16px'
  centerUIDiv.style.boxShadow = '0 0 20px rgba(255, 102, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.1)'
  // Keep the compact scoreboard on one line instead of wrapping into a block
  // that covers the top rows of the board.
  centerUIDiv.style.whiteSpace = 'nowrap'
  document.body.appendChild(centerUIDiv)

  // UI for opponents (top-right on PC, hidden on mobile)
  const opponentUIDiv = document.createElement('div')
  opponentUIDiv.className = 'game-ui-panel'
  opponentUIDiv.style.position = 'absolute'
  if (isMobileDevice) {
      // Hide opponent stats on mobile - controls take up the space
      opponentUIDiv.style.display = 'none'
  } else {
      // PC: mirrored into the right-hand gutter, opposite the player panel
      opponentUIDiv.style.top = '50%'
      opponentUIDiv.style.right = '12px'
      opponentUIDiv.style.transformOrigin = 'right center'
      opponentUIDiv.style.transform = 'translateY(-50%)'
      opponentUIDiv.style.maxWidth = '210px'
  }
  opponentUIDiv.style.color = 'white'
  opponentUIDiv.style.fontFamily = "'Russo One', sans-serif"
  opponentUIDiv.style.fontSize = isMobileDevice ? '16px' : '14px'
  opponentUIDiv.style.zIndex = '1000'
  opponentUIDiv.style.minWidth = isMobileDevice ? '180px' : '160px'
  opponentUIDiv.style.background = isMobileDevice
    ? 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(20,20,40,0.9) 100%)'
    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(20,20,40,0.55) 100%)'
  opponentUIDiv.style.border = '2px solid rgba(204,68,255,0.3)'
  opponentUIDiv.style.borderRadius = '12px'
  opponentUIDiv.style.padding = isMobileDevice ? '12px' : '8px 10px'
  opponentUIDiv.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)'
  opponentUIDiv.style.opacity = isMobileDevice ? '1' : '0.85'
  opponentUIDiv.style.transition = 'opacity 0.2s ease'
  
  // PC: Make more visible on hover
  if (!isMobileDevice) {
    opponentUIDiv.addEventListener('mouseenter', () => {
      opponentUIDiv.style.opacity = '1'
      opponentUIDiv.style.background = 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(20,20,40,0.9) 100%)'
    })
    opponentUIDiv.addEventListener('mouseleave', () => {
      opponentUIDiv.style.opacity = '0.85'
      opponentUIDiv.style.background = 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(20,20,40,0.55) 100%)'
    })
  }
  document.body.appendChild(opponentUIDiv)

  /**
   * Tuck the desktop HUD into the empty columns beside the square arena.
   *
   * The board is height-bound on any landscape window, so the leftover width is
   * split evenly on either side. Each panel is pinned just outside the board
   * edge and, when the gutter is narrower than the panel, scaled down to fit
   * rather than being allowed to cover the playfield.
   */
  let lastPanelLayoutKey = ''
  function layoutDesktopPanels() {
    if (isMobileDevice) return

    const unitsPerPx = (camera.orthoTop! - camera.orthoBottom!) / (engine.getRenderHeight() || 1)
    const boardPx = (GRID_WIDTH * TILE_SIZE) / unitsPerPx
    const gutter = (engine.getRenderWidth() - boardPx) / 2

    const place = (el: HTMLDivElement, side: 'left' | 'right') => {
      if (el.style.display === 'none') return
      // Measure at natural size, then scale only if the gutter is too tight.
      el.style.transform = `translateY(-50%)`
      const width = el.offsetWidth
      if (!width) return
      const available = gutter - 16
      const scale = Math.min(1, Math.max(0.6, available / width))
      const inset = Math.max(8, gutter - width * scale - 12)
      el.style[side] = `${Math.round(inset)}px`
      el.style.transform = `translateY(-50%) scale(${scale.toFixed(3)})`
    }

    const key = `${engine.getRenderWidth()}x${engine.getRenderHeight()}|${playerUIDiv.innerHTML.length}|${opponentUIDiv.innerHTML.length}`
    if (key === lastPanelLayoutKey) return
    lastPanelLayoutKey = key

    place(playerUIDiv, 'left')
    place(opponentUIDiv, 'right')
  }

  // Mobile controls are created later (after keysHeld is defined) to properly
  // interact with the game's input system rather than dispatching synthetic KeyboardEvents.

  // updateUI() rewrites the innerHTML of three panels. A single explosion could
  // call it a dozen times in one frame (per enemy hit, per power-up), so calls
  // are coalesced and flushed once per frame instead.
  let uiDirty = true
  function updateUI() {
    uiDirty = true
  }

  function flushUI() {
    if (!uiDirty) return
    uiDirty = false
    renderUI()
    layoutDesktopPanels()
  }

  function renderUI() {
    // Update center UI (timer)
    const timeAttackState = gameStateManager.getTimeAttackState()
    
    if (gameMode === 'survival') {
      centerUIDiv.style.display = 'block'
      centerUIDiv.innerHTML = `
        <div style="color: #ffaa00; font-size: 16px;">🌊 WAVE ${survivalWave}</div>
        <div style="font-size: 12px; margin-top: 8px; color: #fff;">Score: <span style="color: #4CAF50;">${survivalScore}</span></div>
      `
    } else if (timeAttackState) {
      centerUIDiv.style.display = 'block'
      const timeString = gameStateManager.getTimeString()
      const timeColor = timeAttackState.timeRemaining < 30000 ? '#ff4444' : '#4CAF50'
      const isLowTime = timeAttackState.timeRemaining < 30000
      centerUIDiv.innerHTML = `
        <div style="color: ${timeColor}; font-size: ${isLowTime ? '20px' : '18px'}; ${isLowTime ? 'animation: pulse 0.5s infinite;' : ''}">⏱️ ${timeString}</div>
        <div style="font-size: 11px; margin-top: 8px; color: #aaa;">Defeated: <span style="color: #ff6600;">${timeAttackState.enemiesDefeated}</span></div>
      `
    } else if (roundState) {
      // Best-of-N scoreboard — this panel used to be dead weight outside of
      // Time Attack because the round system was never initialised.
      // Single compact line on every screen size. The board fills nearly the
      // whole window height on desktop, so a multi-line panel here sat right on
      // top of the playfield.
      const opponentLabel = gameMode === 'pvp' ? 'P2' : 'AI'
      centerUIDiv.style.display = 'block'
      centerUIDiv.classList.add('center-ui-slim')
      centerUIDiv.innerHTML = `
        <span style="color: #ffaa00;">R${roundState.currentRound}</span>
        <span style="color: #555;"> · </span>
        <span style="color: ${settings.player1Color};">${escapeHtml(playerName)} ${roundState.playerWins}</span>
        <span style="color: #888;">-</span>
        <span style="color: #cc44ff;">${roundState.enemyWins} ${opponentLabel}</span>
        <span style="color: #555;"> · </span>
        <span style="color: #888;">TO ${gameStateManager.getWinsNeeded()}</span>
      `
    } else {
      centerUIDiv.style.display = 'none'
    }
    
    // Generate health bar HTML
    const healthBarHTML = (lives: number, maxLives: number, isPlayer2: boolean = false) => {
      const percentage = (lives / maxLives) * 100
      const fillClass = isPlayer2 ? 'player-2' : ''
      const color = isPlayer2 ? settings.player2Color : settings.player1Color
      return `
        <div class="health-bar" style="width: 100%; height: 16px; background: #222; border-radius: 8px; overflow: hidden; border: 2px solid #444; margin: 6px 0;">
          <div class="health-bar-fill ${fillClass}" style="width: ${percentage}%; height: 100%; background: linear-gradient(180deg, ${color} 0%, ${color}99 100%); border-radius: 6px; transition: width 0.3s ease; box-shadow: 0 0 8px ${color}88;"></div>
        </div>
      `
    }
    
    // Generate powerup icons
    const powerupIconsHTML = (bombs: number, blast: number, kick: boolean, throwAbility: boolean, speed: number,
      shield: number, pierce: boolean, ghost: number, powerBomb: number, lineBomb: boolean) => {
      let html = `
      <div style="display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap;">
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(66, 165, 245, 0.2); border: 2px solid #42A5F5; position: relative;" title="Bombs">
          <span style="font-size: 16px;">💣</span>
          <span style="font-size: 9px; color: #42A5F5; font-weight: bold;">${bombs}</span>
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(255, 202, 40, 0.2); border: 2px solid #FFCA28; position: relative;" title="Blast Radius">
          <span style="font-size: 16px;">⚡</span>
          <span style="font-size: 9px; color: #FFCA28; font-weight: bold;">${blast}</span>
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: ${kick ? 'rgba(76, 175, 80, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${kick ? '#4CAF50' : '#555'}; opacity: ${kick ? '1' : '0.5'};" title="Kick">
          <span style="font-size: 16px;">🦶</span>
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: ${throwAbility ? 'rgba(76, 175, 80, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${throwAbility ? '#4CAF50' : '#555'}; opacity: ${throwAbility ? '1' : '0.5'};" title="Throw">
          <span style="font-size: 16px;">✋</span>
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0, 188, 212, 0.2); border: 2px solid #00BCD4; position: relative;" title="Speed">
          <span style="font-size: 16px;">👟</span>
          <span style="font-size: 9px; color: #00BCD4; font-weight: bold;">${speed}</span>
        </div>`

      // Extended power-up icons (only shown when extended mode is on)
      if (settings.extendedPowerUps) {
        html += `
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: ${shield > 0 ? 'rgba(255, 215, 0, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${shield > 0 ? '#ffd700' : '#555'}; opacity: ${shield > 0 ? '1' : '0.5'};" title="Shield (${shield})">
          <span style="font-size: 16px;">🛡️</span>
          ${shield > 0 ? `<span style="font-size: 9px; color: #ffd700; font-weight: bold;">${shield}</span>` : ''}
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: ${pierce ? 'rgba(255, 51, 51, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${pierce ? '#ff3333' : '#555'}; opacity: ${pierce ? '1' : '0.5'};" title="Pierce">
          <span style="font-size: 16px;">🔥</span>
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: ${ghost > 0 ? 'rgba(179, 136, 255, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${ghost > 0 ? '#b388ff' : '#555'}; opacity: ${ghost > 0 ? '1' : '0.5'};" title="Ghost${ghost > 0 ? ' (' + Math.ceil(ghost / 1000) + 's)' : ''}">
          <span style="font-size: 16px;">👻</span>
          ${ghost > 0 ? `<span style="font-size: 9px; color: #b388ff; font-weight: bold;">${Math.ceil(ghost / 1000)}s</span>` : ''}
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: ${powerBomb > 0 ? 'rgba(255, 102, 0, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${powerBomb > 0 ? '#ff6600' : '#555'}; opacity: ${powerBomb > 0 ? '1' : '0.5'};" title="Power Bomb (${powerBomb})">
          <span style="font-size: 16px;">☢️</span>
          ${powerBomb > 0 ? `<span style="font-size: 9px; color: #ff6600; font-weight: bold;">${powerBomb}</span>` : ''}
        </div>
        <div style="width: 36px; height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: ${lineBomb ? 'rgba(255, 0, 255, 0.3)' : 'rgba(100,100,100,0.2)'}; border: 2px solid ${lineBomb ? '#ff00ff' : '#555'}; opacity: ${lineBomb ? '1' : '0.5'};" title="Line Bomb">
          <span style="font-size: 16px;">🧨</span>
        </div>`
      }

      html += `</div>`
      return html
    }

    // Online matches have 2-4 humans and no AI, so the offline player-1 /
    // player-2 panels do not describe the match at all. Render the roster.
    if (online) {
      const me = netPlayers.find(p => p.isLocal)
      const startingLives = online.lives

      if (me) {
        const colour = PLAYER_COLORS[me.slot % PLAYER_COLORS.length].value
        playerUIDiv.style.borderColor = `${colour}55`
        playerUIDiv.innerHTML = `
          <div style="font-size: 12px; margin-bottom: 8px; color: ${colour}; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 0 10px ${colour}88;">${escapeHtml(me.name)}</div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">${me.alive ? '❤️' : '💀'}</span>
            <span style="font-size: 14px; font-weight: bold;">${me.lives}/${startingLives}</span>
          </div>
          ${healthBarHTML(me.lives, startingLives)}
          ${powerupIconsHTML(me.maxBombs, me.blastRadius, me.hasKick, me.hasThrow, me.speed, 0, false, 0, 0, false)}
        `
      }

      opponentUIDiv.style.borderColor = 'rgba(204, 68, 255, 0.3)'
      let rosterHTML = `<div style="font-size: 12px; margin-bottom: 10px; color: #cc44ff; text-transform: uppercase; letter-spacing: 2px;">Players</div>`
      for (const p of netPlayers) {
        if (p.isLocal) continue
        const colour = PLAYER_COLORS[p.slot % PLAYER_COLORS.length].value
        const pct = Math.max(0, (p.lives / startingLives) * 100)
        rosterHTML += `
          <div style="margin-bottom: 8px; opacity: ${p.alive ? '1' : '0.45'};">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: ${colour};"></span>
              <span style="font-size: 12px; color: #ddd;">${escapeHtml(p.name)}</span>
              <span style="font-size: 11px; color: #888; margin-left: auto;">💣${p.maxBombs} ⚡${p.blastRadius}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 12px;">${p.alive ? '❤️' : '💀'} ${p.lives}</span>
              <div style="flex: 1; height: 8px; background: #222; border-radius: 4px; overflow: hidden;">
                <div style="width: ${pct}%; height: 100%; background: ${colour}; border-radius: 4px; transition: width 0.2s ease;"></div>
              </div>
            </div>
          </div>`
      }
      opponentUIDiv.innerHTML = rosterHTML
      return
    }

    playerUIDiv.innerHTML = `
      <div style="font-size: 12px; margin-bottom: 8px; color: ${settings.player1Color}; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 0 10px ${settings.player1Color}88;">${escapeHtml(playerName)}</div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 18px;">❤️</span>
        <span style="font-size: 14px; font-weight: bold;">${playerLives}/${difficultyConfig.playerStartingLives}</span>
      </div>
      ${healthBarHTML(playerLives, difficultyConfig.playerStartingLives)}
      ${powerupIconsHTML(maxBombs, blastRadius, hasKick, hasThrow, playerSpeed, shieldCharges, hasPierce, ghostTimer, powerBombCharges, hasLineBomb)}
    `

    if (gameMode === 'pvp') {
      opponentUIDiv.style.borderColor = `${settings.player2Color}44`
      opponentUIDiv.innerHTML = `
        <div style="font-size: 12px; margin-bottom: 8px; color: ${settings.player2Color}; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 0 10px ${settings.player2Color}88;">Player 2</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 18px;">❤️</span>
          <span style="font-size: 14px; font-weight: bold;">${player2Lives}/${difficultyConfig.playerStartingLives}</span>
        </div>
        ${healthBarHTML(player2Lives, difficultyConfig.playerStartingLives, true)}
        ${powerupIconsHTML(player2MaxBombs, player2BlastRadius, player2HasKick, player2HasThrow, player2Speed, player2ShieldCharges, player2HasPierce, player2GhostTimer, player2PowerBombCharges, player2HasLineBomb)}
      `
    } else {
      opponentUIDiv.style.borderColor = 'rgba(204, 68, 255, 0.3)'
      let enemiesHTML = `<div style="font-size: 12px; margin-bottom: 10px; color: #cc44ff; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 0 10px rgba(204, 68, 255, 0.5);">Enemies</div>`
      
      const aliveEnemies = enemies.filter(e => e.lives > 0)
      if (aliveEnemies.length === 0) {
        enemiesHTML += `<div style="color: #4CAF50; font-size: 14px;">All defeated! 🎉</div>`
      } else {
        aliveEnemies.forEach((enemy, i) => {
          enemiesHTML += `
            <div style="margin-bottom: 8px; ${i > 0 ? 'border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px;' : ''}">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                <span style="font-size: 14px;">${enemyEmojis[enemy.id % 3]}</span>
                <span style="font-size: 12px; color: #aaa;">AI ${enemy.id + 1}</span>
                <span style="font-size: 11px; color: #888; margin-left: auto;">💣${enemy.maxBombs} ⚡${enemy.blastRadius}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 12px;">❤️ ${enemy.lives}</span>
                <div style="flex: 1; height: 8px; background: #222; border-radius: 4px; overflow: hidden;">
                  <div style="width: ${(enemy.lives / enemy.maxLives) * 100}%; height: 100%; background: linear-gradient(90deg, #cc44ff, #9933cc); border-radius: 4px;"></div>
                </div>
              </div>
            </div>
          `
        })
      }
      opponentUIDiv.innerHTML = enemiesHTML
    }
    
    if (gameOver) {
      // Hide pause menu if it was showing during game over
      isPaused = false
      pauseMenu.style.display = 'none'

      // Create a winner overlay instead of appending to playerUI
      const existingOverlay = document.getElementById('game-over-overlay')
      if (!existingOverlay) {
        // Score the round before drawing the overlay so the text can report
        // either "round won" or the final match result.
        let matchOver = true
        if (roundState && !roundScored) {
          roundScored = true
          if (gameWon) gameStateManager.recordPlayerRoundWin()
          else gameStateManager.recordEnemyRoundWin()
          matchOver = gameStateManager.isMatchOver()
          if (!matchOver) gameStateManager.nextRound()
        }

        const overlay = document.createElement('div')
        overlay.id = 'game-over-overlay'
        overlay.className = 'winner-overlay'
        overlay.style.position = 'fixed'
        overlay.style.top = '0'
        overlay.style.left = '0'
        overlay.style.width = '100%'
        overlay.style.height = '100%'
        overlay.style.background = 'rgba(0,0,0,0.85)'
        overlay.style.display = 'flex'
        overlay.style.flexDirection = 'column'
        overlay.style.justifyContent = 'center'
        overlay.style.alignItems = 'center'
        overlay.style.zIndex = '3000'
        overlay.style.animation = 'fadeIn 0.5s ease'
        
        // Winner text
        const winnerText = document.createElement('div')
        winnerText.className = `winner-text ${gameWon ? 'victory' : 'defeat'}`
        winnerText.style.fontFamily = "'Press Start 2P', cursive"
        winnerText.style.fontSize = '42px'
        winnerText.style.marginBottom = '20px'
        
        let winColor = gameWon ? '#4CAF50' : '#f44336'
        let titleText = gameWon ? '🎉 VICTORY! 🎉' : '💀 GAME OVER 💀'
        let shadowColor = gameWon ? '#388E3C' : '#c62828'

        if (gameMode === 'pvp') {
          winColor = gameWon ? settings.player1Color : settings.player2Color
          titleText = gameWon ? `🏆 ${playerName.toUpperCase()} WINS! 🏆` : '🏆 PLAYER 2 WINS! 🏆'
          shadowColor = winColor

          // Force victory style for both players in PvP
          winnerText.className = 'winner-text victory'
        }

        if (roundState && !matchOver) {
          titleText = gameWon ? '✔️ ROUND WON!' : '✖️ ROUND LOST'
          winnerText.className = `winner-text ${gameWon ? 'victory' : 'defeat'}`
        } else if (roundState) {
          titleText = gameWon ? '🏆 MATCH WON! 🏆' : '💀 MATCH LOST 💀'
        }

        winnerText.style.color = winColor
        winnerText.style.textShadow = `0 0 20px ${winColor}, 0 0 40px ${winColor}, 0 0 60px ${shadowColor}`
        winnerText.style.animation = 'winnerPulse 1s ease-in-out infinite'
        winnerText.textContent = titleText
        overlay.appendChild(winnerText)

        // Match scoreboard
        if (roundState) {
          const scoreDiv = document.createElement('div')
          scoreDiv.style.fontSize = '22px'
          scoreDiv.style.marginBottom = '10px'
          scoreDiv.style.fontFamily = "'Russo One', sans-serif"
          const opponentLabel = gameMode === 'pvp' ? 'Player 2' : 'AI'
          scoreDiv.innerHTML =
            `<span style="color:${settings.player1Color}">${escapeHtml(playerName)} ${roundState.playerWins}</span>` +
            `<span style="color:#888"> — </span>` +
            `<span style="color:#cc44ff">${roundState.enemyWins} ${opponentLabel}</span>`
          overlay.appendChild(scoreDiv)
        }

        // Survival/Time Attack stats
        if (gameMode === 'survival') {
          const statsDiv = document.createElement('div')
          statsDiv.style.color = '#ffaa00'
          statsDiv.style.fontSize = '20px'
          statsDiv.style.marginBottom = '10px'
          statsDiv.style.fontFamily = "'Russo One', sans-serif"
          statsDiv.innerHTML = `🌊 Survived ${survivalWave} waves!<br>Score: ${survivalScore}`
          overlay.appendChild(statsDiv)
        }
        
        // Button container
        const buttonContainer = document.createElement('div')
        buttonContainer.style.display = 'flex'
        buttonContainer.style.gap = '15px'
        buttonContainer.style.marginTop = '30px'
        if (isMobileDevice) {
          buttonContainer.style.flexDirection = 'column'
          buttonContainer.style.alignItems = 'center'
        }
        
        // Helper: make button touch-friendly
        const touchActivate = (btn: HTMLButtonElement) => {
          ;(btn.style as any).webkitTapHighlightColor = 'transparent'
          btn.style.touchAction = 'manipulation'
          btn.style.userSelect = 'none'
          btn.addEventListener('touchstart', () => btn.style.transform = 'scale(0.95)', { passive: true })
          btn.addEventListener('touchend', () => btn.style.transform = '', { passive: true })
        }

        // Restart button — continues the match when rounds are still to play
        const restartBtn = document.createElement('button')
        restartBtn.innerHTML = roundState && !matchOver ? '▶️ Next Round' : '🔄 Play Again'
        restartBtn.style.fontSize = isMobileDevice ? '20px' : '18px'
        restartBtn.style.padding = isMobileDevice ? '18px 50px' : '15px 35px'
        restartBtn.style.cursor = 'pointer'
        restartBtn.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
        restartBtn.style.color = 'white'
        restartBtn.style.border = '3px solid #2E7D32'
        restartBtn.style.borderRadius = '8px'
        restartBtn.style.fontFamily = "'Russo One', sans-serif"
        restartBtn.style.boxShadow = '0 4px 0 #1B5E20, 0 6px 10px rgba(0,0,0,0.3)'
        restartBtn.style.transition = 'all 0.15s ease'
        if (isMobileDevice) restartBtn.style.width = '80%'
        touchActivate(restartBtn)
        
        restartBtn.addEventListener('mouseenter', () => {
          restartBtn.style.transform = 'translateY(-2px)'
          restartBtn.style.background = 'linear-gradient(180deg, #66BB6A 0%, #4CAF50 100%)'
        })
        restartBtn.addEventListener('mouseleave', () => {
          restartBtn.style.transform = 'translateY(0)'
          restartBtn.style.background = 'linear-gradient(180deg, #4CAF50 0%, #388E3C 100%)'
        })
        restartBtn.addEventListener('click', () => {
          overlay.remove()
          playerUIDiv.remove()
          opponentUIDiv.remove()
          centerUIDiv.remove()
          // Clean up mobile controls and indicators (match "Main Menu" cleanup)
          document.querySelectorAll('.mobile-controls-container, .mobile-controls-wrapper, .game-pause-btn, .offscreen-indicator, #indicator-container').forEach(el => el.remove())
          // A finished match starts a fresh scoreboard; an unfinished one carries on.
          if (matchOver) gameStateManager.reset()
          startGame(gameMode)
        })
        buttonContainer.appendChild(restartBtn)
        
        // Menu button
        const menuBtn = document.createElement('button')
        menuBtn.innerHTML = '🏠 Main Menu'
        menuBtn.style.fontSize = isMobileDevice ? '20px' : '18px'
        menuBtn.style.padding = isMobileDevice ? '18px 50px' : '15px 35px'
        menuBtn.style.cursor = 'pointer'
        menuBtn.style.background = 'linear-gradient(180deg, #f44336 0%, #c62828 100%)'
        menuBtn.style.color = 'white'
        menuBtn.style.border = '3px solid #b71c1c'
        menuBtn.style.borderRadius = '8px'
        menuBtn.style.fontFamily = "'Russo One', sans-serif"
        menuBtn.style.boxShadow = '0 4px 0 #7f0000, 0 6px 10px rgba(0,0,0,0.3)'
        menuBtn.style.transition = 'all 0.15s ease'
        if (isMobileDevice) menuBtn.style.width = '80%'
        touchActivate(menuBtn)
        
        menuBtn.addEventListener('mouseenter', () => {
          menuBtn.style.transform = 'translateY(-2px)'
          menuBtn.style.background = 'linear-gradient(180deg, #ef5350 0%, #f44336 100%)'
        })
        menuBtn.addEventListener('mouseleave', () => {
          menuBtn.style.transform = 'translateY(0)'
          menuBtn.style.background = 'linear-gradient(180deg, #f44336 0%, #c62828 100%)'
        })
        menuBtn.addEventListener('click', () => {
          overlay.remove()
          playerUIDiv.remove()
          opponentUIDiv.remove()
          centerUIDiv.remove()
          mainMenu.style.display = 'flex'
          gameStateManager.reset() // abandoning the match clears the scoreboard
          if (soundManager) soundManager.stopMusic()

          // Dispose scene first, then engine (correct order for GPU resource cleanup)
          if (currentScene) {
            currentScene.dispose()
            currentScene = null
          }
          if (currentEngine) {
            currentEngine.dispose()
            currentEngine = null
          }
          
          document.querySelectorAll('#app > div').forEach(el => {
            if (el.id !== 'main-menu' && el.id !== 'pause-menu') {
              el.remove()
            }
          })
          
          // Explicitly remove mobile controls
          document.querySelectorAll('.mobile-controls-wrapper').forEach(el => el.remove())
          document.querySelectorAll('.mobile-controls-container').forEach(el => el.remove())
          document.querySelectorAll('.game-pause-btn').forEach(el => el.remove())
        })
        buttonContainer.appendChild(menuBtn)
        
        overlay.appendChild(buttonContainer)
        document.body.appendChild(overlay)
        
        // Add confetti for victory
        if (gameWon) {
          for (let i = 0; i < 50; i++) {
            const confetti = document.createElement('div')
            confetti.className = 'confetti'
            confetti.style.position = 'absolute'
            confetti.style.left = `${Math.random() * 100}%`
            confetti.style.top = '-10px'
            confetti.style.width = '10px'
            confetti.style.height = '10px'
            confetti.style.background = ['#ff0', '#f00', '#0f0', '#00f', '#f0f', '#0ff'][Math.floor(Math.random() * 6)]
            confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '0'
            confetti.style.animation = `confettiFall ${2 + Math.random() * 2}s ease-in-out forwards`
            confetti.style.animationDelay = `${Math.random() * 2}s`
            overlay.appendChild(confetti)
          }
        }
      }
    }
  }
  renderUI()

  // Helper function to check if tile blocks explosions
  function blocksExplosion(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= GRID_WIDTH || y >= GRID_HEIGHT) return true
    return grid[y][x] === 'wall'
  }
  
  // Shared explosion material (reused across all explosion visuals)
  const sharedExplosionMat = new StandardMaterial('shared-exp-mat', scene)
  sharedExplosionMat.emissiveColor = new Color3(1, 0.5, 0)
  sharedExplosionMat.diffuseColor = new Color3(1, 0.3, 0)
  sharedExplosionMat.specularColor = new Color3(0, 0, 0)
  sharedExplosionMat.alpha = 0.9

  // Shared halo material for explosions
  const sharedHaloMat = new StandardMaterial('shared-halo-mat', scene)
  sharedHaloMat.emissiveColor = new Color3(1, 0.6, 0.1)
  sharedHaloMat.diffuseColor = new Color3(0, 0, 0)
  sharedHaloMat.alpha = 0.4
  sharedHaloMat.specularColor = new Color3(0, 0, 0)

  // Shared scorch material for explosions
  const sharedScorchMat = new StandardMaterial('shared-scorch-mat', scene)
  sharedScorchMat.diffuseColor = new Color3(0.15, 0.1, 0.05)
  sharedScorchMat.alpha = 0.7
  sharedScorchMat.specularColor = new Color3(0, 0, 0)

  // Cached power-up materials (one per type, reused across all power-ups)
  const powerUpMaterialCache = new Map<PowerUpType, StandardMaterial>()
  function getPowerUpMaterial(type: PowerUpType): StandardMaterial {
    if (powerUpMaterialCache.has(type)) return powerUpMaterialCache.get(type)!
    
    const emoji = type === 'extraBomb' ? '💣' :
                  type === 'largerBlast' ? '⚡' :
                  type === 'kick' ? '🦶' :
                  type === 'throw' ? '✋' :
                  type === 'shield' ? '🛡️' :
                  type === 'pierce' ? '🔥' :
                  type === 'ghost' ? '👻' :
                  type === 'powerBomb' ? '☢️' :
                  type === 'lineBomb' ? '🧨' : '👟'
    const glowColor = type === 'extraBomb' ? 'cyan' :
                      type === 'largerBlast' ? 'yellow' :
                      type === 'kick' ? 'orange' :
                      type === 'throw' ? 'pink' :
                      type === 'shield' ? '#ffd700' :
                      type === 'pierce' ? '#ff3333' :
                      type === 'ghost' ? '#b388ff' :
                      type === 'powerBomb' ? '#ff6600' :
                      type === 'lineBomb' ? '#ff00ff' : 'cyan'
    
    const dynamicTexture = new DynamicTexture('powerupTexture-' + type, 256, scene, true)
    const ctx = dynamicTexture.getContext() as CanvasRenderingContext2D
    
    ctx.clearRect(0, 0, 256, 256)
    ctx.beginPath()
    ctx.arc(128, 128, 120, 0, Math.PI * 2)
    ctx.fillStyle = glowColor
    ctx.fill()
    ctx.beginPath()
    ctx.arc(128, 128, 110, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.9)'
    ctx.fill()
    ctx.font = 'bold 160px Arial'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'white'
    ctx.fillText(emoji, 128, 138)
    dynamicTexture.update()
    
    const mat = new StandardMaterial('emojiMat-' + type, scene)
    mat.diffuseTexture = dynamicTexture
    mat.emissiveColor = new Color3(0.8, 0.8, 0.8)
    mat.opacityTexture = dynamicTexture
    mat.disableLighting = true
    mat.backFaceCulling = false
    
    powerUpMaterialCache.set(type, mat)
    return mat
  }

  // Create a stylized bomb with fuse
  // Shared bomb materials (reused across all bombs to reduce draw calls)
  const sharedBombMat = new StandardMaterial('shared-bomb-mat', scene)
  sharedBombMat.diffuseColor = new Color3(0.12, 0.12, 0.14)
  sharedBombMat.specularColor = new Color3(0.5, 0.5, 0.5)
  sharedBombMat.specularPower = 48

  const sharedFuseMat = new StandardMaterial('shared-fuse-mat', scene)
  sharedFuseMat.diffuseColor = new Color3(0.55, 0.35, 0.15)
  sharedFuseMat.specularColor = new Color3(0, 0, 0)

  const sharedRivetMat = new StandardMaterial('shared-rivet-mat', scene)
  sharedRivetMat.diffuseColor = new Color3(0.45, 0.45, 0.48)
  sharedRivetMat.specularColor = new Color3(0.6, 0.6, 0.6)
  sharedRivetMat.specularPower = 64

  const sharedSparkMat = new StandardMaterial('shared-spark-mat', scene)
  sharedSparkMat.emissiveColor = new Color3(1, 0.7, 0.1)
  sharedSparkMat.diffuseColor = new Color3(1, 0.9, 0.3)
  sharedSparkMat.specularColor = new Color3(0, 0, 0)

  const sharedDangerMat = new StandardMaterial('shared-danger-mat', scene)
  sharedDangerMat.diffuseColor = new Color3(1, 0.15, 0)
  sharedDangerMat.emissiveColor = new Color3(0.3, 0, 0)
  sharedDangerMat.alpha = 0
  sharedDangerMat.specularColor = new Color3(0, 0, 0)

  function createBombMesh() {
    const T = TILE_SIZE

    // Main bomb body — slightly squashed sphere for cartoon feel
    const bombBody = MeshBuilder.CreateSphere('bomb-body', { diameter: T * 0.52, segments: 12 }, scene)
    bombBody.scaling = new Vector3(1, 0.92, 1)
    bombBody.material = sharedBombMat

    // Metallic rim band around equator
    const band = MeshBuilder.CreateTorus('band', {
      diameter: T * 0.36, thickness: T * 0.045, tessellation: 20
    }, scene)
    band.rotation.x = Math.PI / 2
    band.position.y = 0
    band.material = sharedRivetMat
    band.parent = bombBody

    // Rivets around the band (6 evenly spaced)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const rivet = MeshBuilder.CreateSphere('rivet' + i, { diameter: T * 0.04, segments: 4 }, scene)
      rivet.position = new Vector3(
        Math.cos(angle) * T * 0.18,
        0,
        Math.sin(angle) * T * 0.18
      )
      rivet.material = sharedRivetMat
      rivet.parent = bombBody
    }

    // Fuse base (nozzle)
    const nozzle = MeshBuilder.CreateCylinder('nozzle', {
      height: T * 0.08, diameterTop: T * 0.1, diameterBottom: T * 0.06, tessellation: 8
    }, scene)
    nozzle.position.y = T * 0.26
    nozzle.material = sharedRivetMat
    nozzle.parent = bombBody

    // Fuse (slightly curved using two segments)
    const fuseBase = MeshBuilder.CreateCylinder('fuse-base', {
      height: T * 0.12, diameter: T * 0.04, tessellation: 6
    }, scene)
    fuseBase.position.y = T * 0.34
    fuseBase.rotation.z = 0.15
    fuseBase.material = sharedFuseMat
    fuseBase.parent = bombBody

    const fuseTip = MeshBuilder.CreateCylinder('fuse-tip', {
      height: T * 0.1, diameter: T * 0.035, tessellation: 6
    }, scene)
    fuseTip.position.y = T * 0.06
    fuseTip.rotation.z = 0.2
    fuseTip.material = sharedFuseMat
    fuseTip.parent = fuseBase

    // Spark / flame on tip
    const spark = MeshBuilder.CreateSphere('spark', { diameter: T * 0.1, segments: 6 }, scene)
    spark.position.y = T * 0.12
    spark.material = sharedSparkMat
    spark.parent = fuseBase

    // Danger ring on the ground (grows as bomb nears detonation)
    const dangerRing = MeshBuilder.CreateTorus('danger-ring', {
      diameter: T * 0.6, thickness: T * 0.02, tessellation: 24
    }, scene)
    dangerRing.rotation.x = Math.PI / 2
    dangerRing.position.y = -T * 0.24
    dangerRing.material = sharedDangerMat
    dangerRing.parent = bombBody

    return bombBody
  }

  // Cache spark and danger-ring mesh refs on a bomb object for per-frame access
  function cacheBombChildRefs(bomb: any) {
    const children = bomb.mesh.getChildMeshes()
    bomb._spark = children.find((m: any) => m.name === 'spark') || null
    bomb._dangerRing = children.find((m: any) => m.name === 'danger-ring') || null
  }

  // Place bomb function (for player 1 or enemies)
  function placeBomb(x: number, y: number, ownerId: number = -1, ownerBlastRadius?: number) {
    // For player 1
    if (ownerId === -1 && currentBombs >= maxBombs) return
    
    // Check if there's already a bomb at this position
    if (bombs.some(b => b.x === x && b.y === y)) return

    const bombMesh = createBombMesh()
    bombMesh.position = gridToWorld(x, y)

    // Calculate blast radius (with Power Bomb bonus for player 1)
    let effectiveBlastRadius = ownerBlastRadius !== undefined ? ownerBlastRadius : blastRadius
    // Networked owners spend their own charge; the offline player spends theirs.
    const netOwner = netPlayerByOwnerId(ownerId)
    const usesPowerBomb =
      netOwner !== undefined ? netOwner.powerBombCharges > 0 : ownerId === -1 && powerBombCharges > 0
    if (usesPowerBomb) {
      effectiveBlastRadius += 3
      if (netOwner) netOwner.powerBombCharges--
      else powerBombCharges--
      // Visual: tint the bomb orange to indicate power bomb (clone to avoid mutating shared material)
      if (bombMesh.material) {
        const pbMat = (bombMesh.material as StandardMaterial).clone('power-bomb-mat')!
        pbMat.emissiveColor = new Color3(1, 0.4, 0)
        bombMesh.material = pbMat
      }
      updateUI()
    }

    bombs.push({
      x,
      y,
      timer: 2000, // 2.0 seconds
      mesh: bombMesh,
      blastRadius: effectiveBlastRadius,
      ownerId,
    })
    cacheBombChildRefs(bombs[bombs.length - 1])
    
    if (ownerId === -1) {
      currentBombs++
      if ((player as any).triggerSquash) (player as any).triggerSquash()
    }
    
    // Play sound and track stats
    if (soundManager) soundManager.playSFX('bomb-place')
    haptic(10)
    statsManager.recordBombPlaced()
    
    // Check bomber achievement
    if (achievementsManager.incrementProgress('bomber')) {
      showAchievementNotification(achievementsManager.getAchievement('bomber')!)
    }
  }

  // Line Bomb: place a row of bombs in facing direction
  function placeLineBomb(startX: number, startY: number, dx: number, dy: number, ownerId: number) {
    const isP1 = ownerId === -1
    const isP2 = ownerId === -2
    const max = isP1 ? maxBombs : isP2 ? player2MaxBombs : 1
    const current = isP1 ? currentBombs : isP2 ? player2CurrentBombs : 0
    const available = max - current
    if (available <= 0) return

    let placed = 0
    for (let i = 0; i < available; i++) {
      const bx = startX + dx * i
      const by = startY + dy * i
      if (bx < 0 || by < 0 || bx >= GRID_WIDTH || by >= GRID_HEIGHT) break
      if (grid[by][bx] === 'wall') break
      if (grid[by][bx] === 'destructible') break
      if (bombs.some(b => b.x === bx && b.y === by)) continue

      const bombMesh = createBombMesh()
      bombMesh.position = gridToWorld(bx, by)

      const br = isP1 ? blastRadius : isP2 ? player2BlastRadius : 2
      bombs.push({ x: bx, y: by, timer: 2200, mesh: bombMesh, blastRadius: br, ownerId })
      cacheBombChildRefs(bombs[bombs.length - 1])
      placed++
      if (soundManager) soundManager.playSFX('bomb-place')
      statsManager.recordBombPlaced()
    }

    if (isP1) currentBombs += placed
    else if (isP2) player2CurrentBombs += placed
    if (placed > 0) haptic(30)
  }

  // Shared particle constants (avoid per-system allocations)
  let _sharedFlareTexture: Texture | null = null
  function getSharedFlareTexture(): Texture {
    if (_sharedFlareTexture && !(_sharedFlareTexture as any)._isDisposed) return _sharedFlareTexture
    try {
      _sharedFlareTexture = new Texture(FLARE_TEXTURE_DATA_URI, scene)
    } catch (e) {
      _sharedFlareTexture = new Texture('', scene)
    }
    return _sharedFlareTexture!
  }
  const FIRE_COLOR1 = new Color4(1, 0.8, 0.2, 1)
  const FIRE_COLOR2 = new Color4(1, 0.3, 0, 1)
  const FIRE_COLOR_DEAD = new Color4(0.2, 0.2, 0.2, 0)
  const FIRE_GRAVITY = new Vector3(0, 2, 0)
  const FIRE_DIR1 = new Vector3(-1.5, 2, -1.5)
  const FIRE_DIR2 = new Vector3(1.5, 3, 1.5)
  const SMOKE_COLOR1 = new Color4(0.85, 0.85, 0.85, 0.7)
  const SMOKE_COLOR2 = new Color4(0.65, 0.65, 0.65, 0.5)
  const SMOKE_COLOR_DEAD = new Color4(0.5, 0.5, 0.5, 0)
  const SMOKE_GRAVITY = new Vector3(0, 0.3, 0)
  const SMOKE_DIR1 = new Vector3(-1.2, 0.3, -1.2)
  const SMOKE_DIR2 = new Vector3(1.2, 1.8, 1.2)

  // Create particle system for explosions
  function createExplosionParticles(x: number, y: number) {
    const particleSystem = new ParticleSystem('explosion', 50, scene)
    
    // Use Vector3 emitter directly (no mesh allocation needed)
    particleSystem.emitter = gridToWorld(x, y)

    particleSystem.particleTexture = getSharedFlareTexture()
    
    // Use shared color/direction constants
    particleSystem.color1 = FIRE_COLOR1
    particleSystem.color2 = FIRE_COLOR2
    particleSystem.colorDead = FIRE_COLOR_DEAD

    particleSystem.minSize = 0.15
    particleSystem.maxSize = 0.4

    particleSystem.minLifeTime = 0.15
    particleSystem.maxLifeTime = 0.35

    particleSystem.emitRate = 300
    particleSystem.blendMode = ParticleSystem.BLENDMODE_ADD

    particleSystem.gravity = FIRE_GRAVITY

    particleSystem.direction1 = FIRE_DIR1
    particleSystem.direction2 = FIRE_DIR2

    particleSystem.minEmitPower = 3
    particleSystem.maxEmitPower = 6

    particleSystem.updateSpeed = 0.008

    particleSystem.start()

    setTimeout(() => {
      if (scene.isDisposed) return
      particleSystem.stop()
      setTimeout(() => {
        if (!scene.isDisposed) {
          particleSystem.particleTexture = null // protect shared texture
          particleSystem.dispose()
        }
      }, 400)
    }, 150)
  }
  
  // Create a white smoke texture for particle systems
  // Shared smoke texture (reused across all smoke particle systems)
  let _sharedSmokeTexture: Texture | null = null
  function getSharedSmokeTexture(): Texture {
    if (_sharedSmokeTexture && !(_sharedSmokeTexture as any)._isDisposed) return _sharedSmokeTexture
    const dynamicTexture = new DynamicTexture("smokeTexture-shared", 64, scene, false);
    const ctx = dynamicTexture.getContext();
    const size = dynamicTexture.getSize();
    const mid = size.width / 2;
    ctx.clearRect(0, 0, size.width, size.height);
    const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1.0)");
    gradient.addColorStop(0.5, "rgba(220, 220, 220, 0.8)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size.width, size.height);
    dynamicTexture.update();
    _sharedSmokeTexture = dynamicTexture;
    return dynamicTexture;
  }

  // Create smoke particles for after explosion
  function createSmokeParticles(x: number, y: number) {
    const smokeSystem = new ParticleSystem('smoke', 100, scene)
    
    // Wide emit box so smoke starts beyond a single tile
    smokeSystem.emitter = gridToWorld(x, y)
    smokeSystem.minEmitBox = new Vector3(-0.4, 0, -0.4)
    smokeSystem.maxEmitBox = new Vector3(0.4, 0.15, 0.4)
    
    smokeSystem.particleTexture = getSharedSmokeTexture()

    smokeSystem.color1 = SMOKE_COLOR1
    smokeSystem.color2 = SMOKE_COLOR2
    smokeSystem.colorDead = SMOKE_COLOR_DEAD
    
    // Large particles that visually overlap across tiles
    smokeSystem.minSize = 0.4
    smokeSystem.maxSize = 1.4
    
    smokeSystem.minLifeTime = 0.8
    smokeSystem.maxLifeTime = 2.2
    
    smokeSystem.emitRate = 100
    smokeSystem.blendMode = ParticleSystem.BLENDMODE_STANDARD
    
    smokeSystem.gravity = SMOKE_GRAVITY
    smokeSystem.direction1 = SMOKE_DIR1
    smokeSystem.direction2 = SMOKE_DIR2
    
    // Enough power to drift into neighboring tiles
    smokeSystem.minEmitPower = 0.4
    smokeSystem.maxEmitPower = 1.4
    
    // Rotation for natural billowing & merging appearance
    smokeSystem.minAngularSpeed = -0.8
    smokeSystem.maxAngularSpeed = 0.8
    
    // Size growth over lifetime — particles expand as they rise
    smokeSystem.addSizeGradient(0, 0.4)
    smokeSystem.addSizeGradient(0.4, 1.0)
    smokeSystem.addSizeGradient(1.0, 1.6)
    
    smokeSystem.start()
    
    setTimeout(() => {
      if (scene.isDisposed) return
      smokeSystem.stop()
      setTimeout(() => {
        if (!scene.isDisposed) {
          smokeSystem.particleTexture = null // protect shared texture
          smokeSystem.dispose()
        }
      }, 2000)
    }, 350)
  }

  // Explode bomb function
  function explodeBomb(bomb: Bomb) {
    // Screen shake and sound
    screenShake(0.4, 250)
    if (soundManager) soundManager.playSFX('explosion')
    haptic([50, 30, 80])
    
    // Check if bomb owner has pierce ability
    // Networked owners were never consulted here, so a guest holding Pierce got
    // an ordinary blast that stopped at the first crate.
    const netOwner = bomb.ownerId === undefined ? undefined : netPlayerByOwnerId(bomb.ownerId)
    const ownerHasPierce = netOwner ? netOwner.hasPierce :
                           bomb.ownerId === -1 ? hasPierce :
                           bomb.ownerId === -2 ? player2HasPierce : false
    
    const explosionTiles: Array<[number, number]> = [[bomb.x, bomb.y]]
    
    // Check in 4 directions
    const directions = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]

    for (const [dx, dy] of directions) {
      for (let i = 1; i <= bomb.blastRadius; i++) {
        const x = bomb.x + dx * i
        const y = bomb.y + dy * i

        if (blocksExplosion(x, y)) break

        explosionTiles.push([x, y])

        // Stop if we hit a destructible block (unless pierce)
        if (grid[y][x] === 'destructible' && !ownerHasPierce) break
      }
    }

    // A fully upgraded bomb covers 20+ tiles, and the old code spawned two
    // particle systems per tile. Emitters are limited to the centre plus a few
    // spread-out tiles, which looks the same but costs a fraction as much.
    const maxEmitters = particlesOn ? (lowSpec ? 3 : 6) : 0
    const emitterStride = Math.max(1, Math.ceil(explosionTiles.length / Math.max(1, maxEmitters)))

    // Create explosion visuals with animation
    const explosionMeshes: any[] = []
    for (let idx = 0; idx < explosionTiles.length; idx++) {
      const [x, y] = explosionTiles[idx]
      const isCenter = idx === 0
      const emitsParticles = maxEmitters > 0 && (isCenter || idx % emitterStride === 0)

      // ── Core fireball ──
      const fireball = MeshBuilder.CreateSphere('exp-fire', {
        diameter: TILE_SIZE * (isCenter ? 0.95 : 0.8), segments: 8
      }, scene)
      fireball.position = gridToWorld(x, y)
      fireball.material = sharedExplosionMat
      explosionMeshes.push(fireball)

      // ── Outer glow halo ──
      const halo = MeshBuilder.CreateSphere('exp-halo', {
        diameter: TILE_SIZE * (isCenter ? 1.2 : 1.0), segments: 6
      }, scene)
      halo.position = gridToWorld(x, y)
      halo.material = sharedHaloMat
      explosionMeshes.push(halo)

      // ── Ground scorch ring ──
      const scorch = MeshBuilder.CreateDisc('exp-scorch', {
        radius: TILE_SIZE * 0.4, tessellation: 12
      }, scene)
      scorch.rotation.x = Math.PI / 2
      scorch.position = gridToWorld(x, y)
      scorch.position.y = 0.02
      scorch.material = sharedScorchMat
      explosionMeshes.push(scorch)

      if (emitsParticles) {
        // Create fire particle effect
        createExplosionParticles(x, y)

        // Add smoke after fire (slightly later so smoke is visible after fireball fades)
        setTimeout(() => {
          if (!scene.isDisposed) createSmokeParticles(x, y)
        }, 150)
      }

      // Staggered timing for directional tiles (ripple outward)
      const delay = idx === 0 ? 0 : idx * 0.8

      // ── Fireball animation ──
      const scaleAnim = new Animation('scaleAnim', 'scaling', 60, Animation.ANIMATIONTYPE_VECTOR3)
      scaleAnim.setKeys([
        { frame: delay + 0, value: new Vector3(0.05, 0.05, 0.05) },
        { frame: delay + 3, value: new Vector3(1.4, 1.5, 1.4) },
        { frame: delay + 7, value: new Vector3(1.1, 1.0, 1.1) },
        { frame: delay + 14, value: new Vector3(0.5, 0.3, 0.5) },
        { frame: delay + 20, value: new Vector3(0, 0, 0) },
      ])
      fireball.animations.push(scaleAnim)

      const fadeAnim = new Animation('fadeAnim', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      fadeAnim.setKeys([
        { frame: delay + 0, value: 1 },
        { frame: delay + 10, value: 0.9 },
        { frame: delay + 20, value: 0 },
      ])
      fireball.animations.push(fadeAnim)
      scene.beginAnimation(fireball, 0, delay + 24, false)

      // ── Halo animation (expand & fade) — shorter to reduce glow lingering ──
      const haloScale = new Animation('haloScale', 'scaling', 60, Animation.ANIMATIONTYPE_VECTOR3)
      haloScale.setKeys([
        { frame: delay + 0, value: new Vector3(0.3, 0.3, 0.3) },
        { frame: delay + 4, value: new Vector3(1.5, 1.5, 1.5) },
        { frame: delay + 10, value: new Vector3(2.0, 0.5, 2.0) },
      ])
      halo.animations.push(haloScale)

      const haloFade = new Animation('haloFade', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      haloFade.setKeys([
        { frame: delay + 0, value: 0.5 },
        { frame: delay + 4, value: 0.3 },
        { frame: delay + 10, value: 0 },
      ])
      halo.animations.push(haloFade)
      scene.beginAnimation(halo, 0, delay + 14, false)

      // Scorch fades slowly
      const scorchFade = new Animation('scorchFade', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      scorchFade.setKeys([
        { frame: 0, value: 0 },
        { frame: 5, value: 0.7 },
        { frame: 40, value: 0.3 },
        { frame: 60, value: 0 },
      ])
      scorch.animations.push(scorchFade)
      scene.beginAnimation(scorch, 0, 60, false)

      // Record what happened so the host can replay it on the guests.
      if (online) {
        pendingBlasts.push([x, y])
        if (grid[y][x] === 'destructible') pendingCleared.push([x, y])
      }

      // Networked players take blast damage. Only the host resolves this; guests
      // receive lives in the snapshot so the two can never disagree.
      if (online && online.isHost) {
        for (const np of netPlayers) {
          if (!np.alive || np.invulnerable) continue
          if (np.x !== x || np.y !== y) continue

          // Shield soaks the hit instead of a life, as it does offline. Without
          // this a networked shield was collected and then never consulted.
          if (np.shieldCharges > 0) {
            np.shieldCharges--
            np.invulnerable = true
            np.invulnerableTimer = 1000
            updateUI()
            continue
          }

          np.lives--
          np.invulnerable = true
          np.invulnerableTimer = 2000
          showHitIndicator(gridToWorld(np.x, np.y), scene, np.isLocal)
          if (np.lives <= 0) {
            np.alive = false
            np.lives = 0
          }
          updateUI()
        }
      }

      // Destroy destructible blocks
      if (grid[y][x] === 'destructible') {
        grid[y][x] = 'empty'
        if (removeCrateAt(x, y)) {
          // The shadow map is rendered on demand rather than every frame, so it
          // has to be told the arena geometry just changed.
          refreshShadows()
        }
        statsManager.recordBlockDestroyed()
        sessionBlocksDestroyed++
        
        // Check demolition achievement
        if (sessionBlocksDestroyed >= 50) {
          if (achievementsManager.unlock('demolition')) {
            showAchievementNotification(achievementsManager.getAchievement('demolition')!)
          }
        }

        // Chance to spawn power-up (affected by difficulty)
        if (Math.random() < difficultyConfig.powerUpDropRate) {
          const rand = Math.random()
          let powerUpType: PowerUpType
          
          if (settings.extendedPowerUps) {
            // Extended pool: 10 power-up types
            if (rand < 0.16) {
              powerUpType = 'extraBomb'     // 16%
            } else if (rand < 0.36) {
              powerUpType = 'largerBlast'   // 20%
            } else if (rand < 0.44) {
              powerUpType = 'kick'          // 8%
            } else if (rand < 0.49) {
              powerUpType = 'throw'         // 8%
            } else if (rand < 0.59) {
              powerUpType = 'speed'         // 10%
            } else if (rand < 0.69) {
              powerUpType = 'shield'        // 10%
            } else if (rand < 0.77) {
              powerUpType = 'pierce'        // 8%
            } else if (rand < 0.85) {
              powerUpType = 'ghost'         // 8%
            } else if (rand < 0.93) {
              powerUpType = 'powerBomb'     // 8%
            } else {
              powerUpType = 'lineBomb'      // 7%
            }
          } else {
            // Classic pool: 5 power-up types
            if (rand < 0.30) {
              powerUpType = 'extraBomb'  // 30%
            } else if (rand < 0.65) {
              powerUpType = 'largerBlast'  // 35%
            } else if (rand < 0.75) {
              powerUpType = 'kick'  // 10%
            } else if (rand < 0.85) {
              powerUpType = 'throw'  // 10%
            } else {
              powerUpType = 'speed'  // 15%
            }
          }
          
          // Create emoji plane (material is cached per type)
          const pos = gridToWorld(x, y)
          const emojiPlane = MeshBuilder.CreatePlane('powerup-emoji', { 
            size: TILE_SIZE * 0.8  // Increased size from 0.6
          }, scene)
          emojiPlane.position.x = pos.x
          emojiPlane.position.y = TILE_SIZE * 0.5
          emojiPlane.position.z = pos.z
          emojiPlane.billboardMode = 7 // Always face camera
          emojiPlane.material = getPowerUpMaterial(powerUpType)
          
          // Floating animation - Removed duplicate animation code
          const powerUpSphere = emojiPlane
          
          // Add bobbing animation
          let bobTime = Math.random() * Math.PI * 2
          const bobObserver = scene.onBeforeRenderObservable.add(() => {
            if (powerUpSphere && !powerUpSphere.isDisposed()) {
              bobTime += 0.05
              // Bob higher
              powerUpSphere.position.y = TILE_SIZE * 0.5 + Math.sin(bobTime) * 0.15
            }
          })
          
          // Clean up observer when power-up is disposed
          powerUpSphere.onDisposeObservable.add(() => {
            scene.onBeforeRenderObservable.remove(bobObserver)
          })
          
          powerUps.push({ x, y, type: powerUpType, mesh: powerUpSphere })
        }
      }

      // Check if player is hit (offline only). Online matches keep the local
      // player-1 state parked at its spawn, so blasts landing on that corner
      // were draining a player nobody controls — and once its lives hit zero
      // gameOver froze the whole simulation tick.
      if (!online && x === playerGridX && y === playerGridY && !playerInvulnerable) {
        // Shield absorbs the hit
        if (shieldCharges > 0) {
          shieldCharges--
          playerInvulnerable = true
          playerInvulnerableTimer = 1000 // Shorter invuln after shield break
          if (soundManager) soundManager.playSFX('powerup')
          haptic([40, 20, 40])
          const playerPos = gridToWorld(playerGridX, playerGridY)
          showHitIndicator(playerPos, scene, false)
          console.log('Shield absorbed hit! Charges remaining:', shieldCharges)
          updateUI()
        } else {
        playerLives--
        playerInvulnerable = true
        playerInvulnerableTimer = 2000 // 2 seconds invulnerability
        sessionDamageTaken++
        
        // Play death/hit sound
        if (soundManager) soundManager.playSFX('death')
        haptic([50, 30, 80])
        
        // Show hit indicator
        const playerPos = gridToWorld(playerGridX, playerGridY)
        showHitIndicator(playerPos, scene, true)
        
        console.log('Player hit! Lives remaining:', playerLives)
        
        if (playerLives <= 0) {
          gameOver = true
          if (soundManager) soundManager.stopMusic()
          statsManager.recordLoss()
          statsManager.recordDeath()
          if (gameMode === 'survival') {
            statsManager.recordSurvivalScore(survivalWave, survivalScore)
          }
          if (soundManager) soundManager.playSFX('defeat')
          console.log('Game Over! You were defeated!')
        } else {
          statsManager.recordDeath()
        }
        updateUI()
        } // end of shield else
      }

      // Check if any enemy is hit. Iterate over a snapshot: survival waves push
      // new enemies into the array from inside this loop.
      enemies.slice().forEach((enemy) => {
        if (x === enemy.x && y === enemy.y && !enemy.invulnerable && enemy.lives > 0) {
          enemy.lives--
          enemy.invulnerable = true
          enemy.invulnerableTimer = 2000

          // Show hit indicator
          const enemyPos = gridToWorld(enemy.x, enemy.y)
          showHitIndicator(enemyPos, scene, false)

          console.log(`Enemy ${enemy.id + 1} hit! Lives remaining:`, enemy.lives)

          if (enemy.lives <= 0) {
            enemy.mesh.dispose()
            console.log(`Enemy ${enemy.id + 1} destroyed!`)
            statsManager.recordEnemyDefeated()
            sessionEnemiesDefeated++
            
            // Check first blood achievement
            if (achievementsManager.unlock('first-blood')) {
              showAchievementNotification(achievementsManager.getAchievement('first-blood')!)
            }
            
            // Add bonus time in time attack mode
            if (gameMode === 'time-attack') {
              gameStateManager.addBonusTime()
              console.log('+5 seconds bonus time!')
            }
            
            // Check if all enemies are dead
            const allEnemiesDead = enemies.every(e => e.lives <= 0)
            if (allEnemiesDead && gameMode !== 'pvp') {
              if (gameMode === 'survival') {
                // Spawn next wave. Corpses are dropped from the array first —
                // they used to accumulate forever, growing every per-frame loop.
                survivalWave++
                survivalScore += 100 * survivalWave
                const enemiesToSpawn = Math.min(survivalWave, 4) // Max 4 enemies
                pruneDeadEnemies()

                for (let i = 0; i < enemiesToSpawn; i++) {
                  enemies.push(spawnEnemy(enemySpawns[i % enemySpawns.length], survivalWave))
                }

                console.log(`Wave ${survivalWave} incoming! ${enemiesToSpawn} enemies!`)
                if (soundManager) soundManager.playSFX('powerup')
                
                // Check survival achievements
                if (survivalWave >= 5) {
                  if (achievementsManager.unlock('survivor-5')) {
                    showAchievementNotification(achievementsManager.getAchievement('survivor-5')!)
                  }
                }
                if (survivalWave >= 10) {
                  if (achievementsManager.unlock('survivor-10')) {
                    showAchievementNotification(achievementsManager.getAchievement('survivor-10')!)
                  }
                }
              } else {
                gameWon = true
                gameOver = true
                if (soundManager) soundManager.stopMusic()
                statsManager.recordWin()
                
                // Check achievements on win
                if (sessionDamageTaken === 0) {
                  if (achievementsManager.unlock('untouchable')) {
                    showAchievementNotification(achievementsManager.getAchievement('untouchable')!)
                  }
                }
                
                if (sessionEnemiesDefeated >= 3) {
                  if (achievementsManager.unlock('triple-threat')) {
                    showAchievementNotification(achievementsManager.getAchievement('triple-threat')!)
                  }
                }
                
                // Check win streak
                const stats = statsManager.getStats()
                if (stats.currentWinStreak >= 3) {
                  if (achievementsManager.unlock('win-streak-3')) {
                    showAchievementNotification(achievementsManager.getAchievement('win-streak-3')!)
                  }
                }
                
                // Check time attack achievement (2+ minutes remaining = 120000ms)
                if (gameMode === 'time-attack') {
                  const timeAttackState = gameStateManager.getTimeAttackState()
                  if (timeAttackState && timeAttackState.timeRemaining >= 120000) {
                    if (achievementsManager.unlock('speed-demon')) {
                      showAchievementNotification(achievementsManager.getAchievement('speed-demon')!)
                    }
                  }
                }
                
                if (soundManager) soundManager.playSFX('victory')
                console.log('You Win! All enemies destroyed!')
              }
            }
          }
          updateUI()
        }
      })

      // Check if player 2 is hit (local PvP only). Online matches share the
      // 'pvp' mode string but have no player-2 mesh, and its stale grid
      // coordinates would let a blast "kill" a player that does not exist.
      if (!online && gameMode === 'pvp' && x === player2GridX && y === player2GridY && !player2Invulnerable) {
        if (player2ShieldCharges > 0) {
          player2ShieldCharges--
          player2Invulnerable = true
          player2InvulnerableTimer = 1000
          if (soundManager) soundManager.playSFX('powerup')
          haptic([40, 20, 40])
          console.log('Player 2 shield absorbed hit! Charges:', player2ShieldCharges)
          updateUI()
        } else {
        player2Lives--
        player2Invulnerable = true
        player2InvulnerableTimer = 2000
        
        // Play death/hit sound
        if (soundManager) soundManager.playSFX('death')
        haptic([50, 30, 80])
        
        // Show hit indicator
        const player2Pos = gridToWorld(player2GridX, player2GridY)
        showHitIndicator(player2Pos, scene, true)
        
        console.log('Player 2 hit! Lives remaining:', player2Lives)
        
        if (player2Lives <= 0) {
          player2.dispose()
          console.log('Player 1 Wins!')
          gameWon = true
          gameOver = true
          if (soundManager) soundManager.stopMusic()
          statsManager.recordWin()
          if (soundManager) soundManager.playSFX('victory')
        }
        updateUI()
        } // end of shield else
      }
    }

    // Remove explosion visuals after animation finishes
    // Compute cleanup time: max of fireball/halo stagger + 24 frames, and scorch 60 frames
    const maxDelay = (explosionTiles.length - 1) * 0.8
    const fireballEndMs = Math.ceil(((maxDelay + 24) / 60) * 1000)
    const scorchEndMs = 1000 // scorch animation runs to frame 60 at 60fps
    const cleanupMs = Math.max(fireballEndMs, scorchEndMs) + 100
    setTimeout(() => {
      if (scene.isDisposed) return
      explosionMeshes.forEach(mesh => {
        if (!mesh.isDisposed()) mesh.dispose()
      })
    }, cleanupMs)

    // Chain reaction: explode other bombs
    let triggeredChain = false
    bombs.forEach(otherBomb => {
      if (otherBomb !== bomb) {
        for (const [x, y] of explosionTiles) {
          if (otherBomb.x === x && otherBomb.y === y) {
            otherBomb.timer = 0
            triggeredChain = true
          }
        }
      }
    })
    
    // Track chain reactions for achievement
    if (triggeredChain) {
      chainReactionCount++
      // Reset the timer - chain ends when no more bombs explode within 500ms
      if (chainReactionTimer) clearTimeout(chainReactionTimer)
      chainReactionTimer = setTimeout(() => {
        if (chainReactionCount >= 3) {
          if (achievementsManager.unlock('chain-reaction')) {
            showAchievementNotification(achievementsManager.getAchievement('chain-reaction')!)
          }
        }
        chainReactionCount = 0
        chainReactionTimer = null
      }, 500)
    }
  }

  // Update bombs
  function updateBombs(deltaTime: number) {
    const now = Date.now()
    for (let i = bombs.length - 1; i >= 0; i--) {
      const bomb = bombs[i]
      bomb.timer -= deltaTime

      const timeRatio = bomb.timer / 2000
      const urgency = 1 - timeRatio // 0 → 1 as bomb nears detonation

      // ── Pulse: faster & stronger as timer runs out ──
      const pulseSpeed = 5 + urgency * 25
      const pulseAmp = 0.06 + urgency * 0.22
      const pulse = 1 + Math.sin(now * pulseSpeed / 1000) * pulseAmp
      bomb.mesh.scaling.copyFromFloats(pulse, pulse * (1 + urgency * 0.08), pulse)

      // ── Body glow: ramp from dark to angry red/orange ──
      if (bomb.mesh.material && bomb.mesh.material !== sharedBombMat) {
        // power-bomb or already-cloned material – animate glow
        if (urgency > 0.4) {
          const i2 = (urgency - 0.4) / 0.6
          bomb.mesh.material.emissiveColor.copyFromFloats(
            Math.min(1, i2 * 0.9 + (bomb.mesh.material.emissiveColor.r > 0.3 ? 0.4 : 0)),
            i2 * 0.15 + (bomb.mesh.material.emissiveColor.g > 0.2 ? 0.15 : 0),
            0
          )
        }
      } else if (bomb.mesh.material) {
        if (urgency > 0.4) {
          const i2 = (urgency - 0.4) / 0.6
          // Clone material once to avoid tinting all bombs the same
          if (bomb.mesh.material === sharedBombMat) {
            const m = sharedBombMat.clone('bomb-mat-' + i)!
            bomb.mesh.material = m
          }
          bomb.mesh.material.emissiveColor.copyFromFloats(i2 * 0.9, i2 * 0.15, 0)
        }
      }

      // ── Spark flicker: use cached ref ──
      const spark = (bomb as any)._spark
      if (spark) {
        const f = 0.6 + Math.random() * 0.4
        const s = 0.7 + Math.random() * 0.6
        spark.scaling.copyFromFloats(s, s, s)
        if (spark.material && spark.material !== sharedSparkMat) {
          spark.material.emissiveColor.copyFromFloats(f, f * 0.55, f * 0.1)
        } else if (spark.material) {
          // Clone once
          const sm = sharedSparkMat.clone('spark-live-' + i)!
          spark.material = sm
          sm.emissiveColor.copyFromFloats(f, f * 0.55, f * 0.1)
        }
      }

      // ── Danger ring: use cached ref ──
      const dangerRing = (bomb as any)._dangerRing
      if (dangerRing) {
        if (urgency > 0.6) {
          const dp = (urgency - 0.6) / 0.4 // 0→1
          const ringScale = 1 + dp * 1.5
          dangerRing.scaling.copyFromFloats(ringScale, ringScale, ringScale)
          if (dangerRing.material && dangerRing.material !== sharedDangerMat) {
            dangerRing.material.alpha = dp * 0.6 * (0.5 + 0.5 * Math.sin(now * 0.012))
          } else if (dangerRing.material) {
            const dm = sharedDangerMat.clone('danger-live-' + i)!
            dangerRing.material = dm
            dm.alpha = dp * 0.6
          }
        }
      }

      // ── Slight wobble for personality ── 
      bomb.mesh.rotation.z = Math.sin(now * 0.008 + i) * urgency * 0.12
      bomb.mesh.rotation.x = Math.cos(now * 0.006 + i) * urgency * 0.08

      if (bomb.timer <= 0) {
        explodeBomb(bomb)
        // Dispose cloned materials to prevent memory leaks
        // Dispose cloned body material
        if (bomb.mesh.material && bomb.mesh.material !== sharedBombMat) bomb.mesh.material.dispose()
        bomb.mesh.getChildMeshes().forEach((child: any) => {
          if (child.material && child.material !== sharedBombMat && child.material !== sharedFuseMat && child.material !== sharedRivetMat && child.material !== sharedSparkMat && child.material !== sharedDangerMat) {
            child.material.dispose()
          }
          child.dispose()
        })
        bomb.mesh.dispose()
        
        // Decrement the correct owner's bomb count
        if (bomb.ownerId === -1) {
          currentBombs--
        } else if (bomb.ownerId === -2) {
          player2CurrentBombs--
        } else if (bomb.ownerId !== undefined && bomb.ownerId >= 1000) {
          const owner = netPlayerByOwnerId(bomb.ownerId)
          if (owner) owner.currentBombs = Math.max(0, owner.currentBombs - 1)
        } else if (bomb.ownerId !== undefined && bomb.ownerId >= 0) {
          const owner = findEnemyById(bomb.ownerId)
          if (owner) owner.currentBombs = Math.max(0, owner.currentBombs - 1)
        }
        
        bombs.splice(i, 1)
      }
    }
  }

  // Update invulnerability
  function updateInvulnerability(deltaTime: number) {
    // Player 1
    if (playerInvulnerable) {
      playerInvulnerableTimer -= deltaTime
      setCharacterVisibility(player, Math.sin(Date.now() / 100) > 0 ? 0.5 : 1)
      
      if (playerInvulnerableTimer <= 0) {
        playerInvulnerable = false
        setCharacterVisibility(player, 1)
      }
    }

    // Player 2 (PvP mode)
    if (gameMode === 'pvp' && player2Invulnerable && player2) {
      player2InvulnerableTimer -= deltaTime
      setCharacterVisibility(player2, Math.sin(Date.now() / 100) > 0 ? 0.5 : 1)
      
      if (player2InvulnerableTimer <= 0) {
        player2Invulnerable = false
        setCharacterVisibility(player2, 1)
      }
    }

    // Enemies
    enemies.forEach(enemy => {
      if (enemy.invulnerable && enemy.lives > 0) {
        enemy.invulnerableTimer -= deltaTime
        setCharacterVisibility(enemy.mesh, Math.sin(Date.now() / 100) > 0 ? 0.5 : 1)

        if (enemy.invulnerableTimer <= 0) {
          enemy.invulnerable = false
          setCharacterVisibility(enemy.mesh, 1)
        }
      }
    })

    // Ghost mode timers
    if (ghostTimer > 0) {
      ghostTimer -= deltaTime
      // Visual: ghostly flicker
      setCharacterVisibility(player, 0.5 + Math.sin(Date.now() / 150) * 0.2)
      if (ghostTimer <= 0) {
        ghostTimer = 0
        setCharacterVisibility(player, playerInvulnerable ? 0.5 : 1)
        console.log('Player 1: Ghost mode expired!')
      }
    }
    if (player2GhostTimer > 0) {
      player2GhostTimer -= deltaTime
      if (player2) setCharacterVisibility(player2, 0.5 + Math.sin(Date.now() / 150) * 0.2)
      if (player2GhostTimer <= 0) {
        player2GhostTimer = 0
        if (player2) setCharacterVisibility(player2, player2Invulnerable ? 0.5 : 1)
        console.log('Player 2: Ghost mode expired!')
      }
    }
  }

  /** Direction offsets shared by every AI scan. */
  const DIRECTION_STEPS: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]

  /**
   * Who this AI is hunting. Outside PvP that is always Player 1; with a second
   * player present it picks whoever is closer.
   */
  function pickAITarget(enemy: Enemy): { x: number; y: number } | null {
    const p1 = { x: playerGridX, y: playerGridY }
    if (gameMode !== 'pvp' || player2Lives <= 0) return playerLives > 0 ? p1 : null
    const p2 = { x: player2GridX, y: player2GridY }
    if (playerLives <= 0) return p2
    const d1 = Math.abs(enemy.x - p1.x) + Math.abs(enemy.y - p1.y)
    const d2 = Math.abs(enemy.x - p2.x) + Math.abs(enemy.y - p2.y)
    return d1 <= d2 ? p1 : p2
  }

  /** Escape route assuming the AI drops a bomb on its current tile. */
  function getEscapeDirectionForBomb(
    enemy: Enemy,
    bombData: Array<{ x: number; y: number; blastRadius: number }>,
    depth: number,
    blocked: Array<{ x: number; y: number }>,
  ) {
    return getEscapeDirection(
      enemy.x, enemy.y, grid, GRID_WIDTH, GRID_HEIGHT,
      [...bombData, { x: enemy.x, y: enemy.y, blastRadius: enemy.blastRadius }],
      depth, blocked,
    )
  }

  // Smart AI for enemies
  function updateEnemies(deltaTime: number) {
    if (gameOver) return

    // Snapshot the bomb list once per frame rather than once per enemy.
    const bombData = bombs.map(b => ({ x: b.x, y: b.y, blastRadius: b.blastRadius }))

    for (const enemy of enemies) {
      if (enemy.lives <= 0) continue

      enemy.moveTimer -= deltaTime
      if (enemy.moveTimer > 0) continue
      // Difficulty (and Survival waves) drive this interval. It used to be a
      // flat 600-1000ms against a player who moves every 150ms, which is why
      // every difficulty felt the same and none of them felt threatening.
      enemy.moveTimer = enemy.moveInterval

      // Tiles the AI must not walk into: the players and its living siblings.
      const blocked: Array<{ x: number; y: number }> = []
      if (playerLives > 0) blocked.push({ x: playerGridX, y: playerGridY })
      if (gameMode === 'pvp' && player2Lives > 0) blocked.push({ x: player2GridX, y: player2GridY })
      for (const other of enemies) {
        if (other !== enemy && other.lives > 0) blocked.push({ x: other.x, y: other.y })
      }

      const canStandOn = (nx: number, ny: number) =>
        nx >= 0 && ny >= 0 && nx < GRID_WIDTH && ny < GRID_HEIGHT &&
        grid[ny][nx] === 'empty' &&
        !bombs.some(b => b.x === nx && b.y === ny) &&
        !blocked.some(b => b.x === nx && b.y === ny)

      const stepTo = (dx: number, dy: number) => {
        enemy.x += dx
        enemy.y += dy
        const anim = (enemy.mesh as any).playAnimation
        if (anim) {
          if (dx < 0) anim('walk-up')
          else if (dx > 0) anim('walk-down')
          else if (dy < 0) anim('walk-left')
          else if (dy > 0) anim('walk-right')
        }
      }

      const escapeDepth = getEscapeDepth(difficultyConfig, enemy.moveInterval)

      // PRIORITY 1: If in danger, escaping is the only thing that matters.
      const currentlyInDanger = !isPositionSafe(enemy.x, enemy.y, grid, bombData)

      if (currentlyInDanger) {
        const escapeDir = getEscapeDirection(
          enemy.x, enemy.y, grid, GRID_WIDTH, GRID_HEIGHT, bombData, escapeDepth, blocked,
        )

        if (escapeDir && canStandOn(enemy.x + escapeDir.dx, enemy.y + escapeDir.dy)) {
          stepTo(escapeDir.dx, escapeDir.dy)
        } else {
          // No planned escape — take whichever step is least lethal.
          const fallback = DIRECTION_STEPS
            .filter(([dx, dy]) => canStandOn(enemy.x + dx, enemy.y + dy))
            .sort((a, b) => {
              const sa = isPositionSafe(enemy.x + a[0], enemy.y + a[1], grid, bombData) ? 1 : 0
              const sb = isPositionSafe(enemy.x + b[0], enemy.y + b[1], grid, bombData) ? 1 : 0
              return sb - sa
            })[0]
          if (fallback) stepTo(fallback[0], fallback[1])
        }
      } else {
        // PRIORITY 2: Hunt. Higher difficulties navigate with BFS instead of
        // taking greedy single steps that stall against the first wall.
        const target = pickAITarget(enemy)
        let moved = false

        if (target && Math.random() < difficultyConfig.aiPathfindChance) {
          const path = findPathToTarget(
            enemy.x, enemy.y, target.x, target.y,
            grid, GRID_WIDTH, GRID_HEIGHT, bombData, blocked,
          )
          if (path) {
            enemy.tunnelTarget = path.blockedBy ?? null
            const nx = enemy.x + path.step.dx
            const ny = enemy.y + path.step.dy
            if (canStandOn(nx, ny) && isPositionSafe(nx, ny, grid, bombData)) {
              stepTo(path.step.dx, path.step.dy)
              moved = true
            }
          } else {
            enemy.tunnelTarget = null
          }
        }

        if (!moved) {
          // Greedy scoring fallback, which is also the easy difficulty's brain.
          const moveOptions = DIRECTION_STEPS.map(([dx, dy]) => {
            const nx = enemy.x + dx
            const ny = enemy.y + dy
            if (!canStandOn(nx, ny)) return { dx, dy, score: -Infinity }
            if (!isPositionSafe(nx, ny, grid, bombData)) return { dx, dy, score: -Infinity }

            let score = 100
            if (powerUps.some(p => p.x === nx && p.y === ny)) score += 200

            if (target) {
              const next = Math.abs(nx - target.x) + Math.abs(ny - target.y)
              const now = Math.abs(enemy.x - target.x) + Math.abs(enemy.y - target.y)
              if (next < now) score += difficultyConfig.aiChaseWeight
              score -= next * 3
            }
            score += Math.random() * 30
            return { dx, dy, score }
          }).filter(m => m.score > -Infinity)

          if (moveOptions.length > 0) {
            moveOptions.sort((a, b) => b.score - a.score)
            stepTo(moveOptions[0].dx, moveOptions[0].dy)
          }
          // If nothing is safe, standing still beats walking into a blast.
        }
      }

      // BOMB PLACEMENT - only when safe and a bomb is available
      if (!currentlyInDanger && enemy.currentBombs < enemy.maxBombs) {
        const target = pickAITarget(enemy)
        const tunnelAdjacent = !!enemy.tunnelTarget &&
          Math.abs(enemy.tunnelTarget.x - enemy.x) + Math.abs(enemy.tunnelTarget.y - enemy.y) === 1

        const decision = shouldAIPlaceBomb({
          enemyX: enemy.x,
          enemyY: enemy.y,
          targetX: target ? target.x : enemy.x,
          targetY: target ? target.y : enemy.y,
          grid,
          gridWidth: GRID_WIDTH,
          gridHeight: GRID_HEIGHT,
          bombs: bombData,
          blastRadius: enemy.blastRadius,
          blocked,
          config: difficultyConfig,
          moveIntervalMs: enemy.moveInterval,
        })

        // Blast a tunnel when the only route to the target runs through a crate.
        const wantsTunnel = !decision.shouldPlace && tunnelAdjacent &&
          Math.random() < difficultyConfig.aiTunnelChance
        const tunnelEscape = wantsTunnel
          ? getEscapeDirectionForBomb(enemy, bombData, escapeDepth, blocked)
          : null

        const escapeDirection = decision.escapeDirection ?? tunnelEscape
        if ((decision.shouldPlace || (wantsTunnel && tunnelEscape)) && escapeDirection) {
          placeBomb(enemy.x, enemy.y, enemy.id, enemy.blastRadius)
          enemy.currentBombs++
          enemy.tunnelTarget = null

          // Immediately start running in the escape direction (same tick).
          if (canStandOn(enemy.x + escapeDirection.dx, enemy.y + escapeDirection.dy)) {
            stepTo(escapeDirection.dx, escapeDirection.dy)
          }
        }
      }

      // Check for power-up collection
      for (let i = powerUps.length - 1; i >= 0; i--) {
        const powerUp = powerUps[i]
        if (powerUp.x !== enemy.x || powerUp.y !== enemy.y) continue

        // The AI now benefits from the same core power-ups the player does, so
        // it no longer falls hopelessly behind after the first minute.
        // Ceilings come from the difficulty. The AI farms crates efficiently
        // now, and without a cap it snowballs past the player inside a minute.
        if (powerUp.type === 'extraBomb') {
          enemy.maxBombs = Math.min(difficultyConfig.aiMaxBombs, enemy.maxBombs + 1)
        } else if (powerUp.type === 'largerBlast' || powerUp.type === 'powerBomb') {
          enemy.blastRadius = Math.min(difficultyConfig.aiMaxBlast, enemy.blastRadius + 1)
        } else if (powerUp.type === 'speed') {
          enemy.moveInterval = Math.max(difficultyConfig.aiMinMoveSpeed, enemy.moveInterval - 45)
        }
        powerUp.mesh.dispose()
        powerUps.splice(i, 1)
        updateUI()
      }

      // Enemies don't damage on collision - they must use bombs!
    }
  }

  // Check power-up collection
  function checkPowerUps() {
    for (let i = powerUps.length - 1; i >= 0; i--) {
      const powerUp = powerUps[i]
      
      // Player 1 collection
      if (powerUp.x === playerGridX && powerUp.y === playerGridY) {
        if (powerUp.type === 'extraBomb') {
          maxBombs++
          console.log('Player 1: Extra bomb! Max bombs:', maxBombs)
        } else if (powerUp.type === 'largerBlast') {
          blastRadius++
          console.log('Player 1: Larger blast! Blast radius:', blastRadius)
        } else if (powerUp.type === 'kick') {
          hasKick = true
          console.log('Player 1: Kick ability acquired!')
        } else if (powerUp.type === 'throw') {
          hasThrow = true
          console.log('Player 1: Throw ability acquired!')
        } else if (powerUp.type === 'speed') {
          playerSpeed++
          moveDelay = Math.max(50, 150 - (playerSpeed - 1) * 30)
          console.log('Player 1: Speed increased! Speed:', playerSpeed)
        } else if (powerUp.type === 'shield') {
          shieldCharges = Math.min(3, shieldCharges + 1)
          console.log('Player 1: Shield! Charges:', shieldCharges)
        } else if (powerUp.type === 'pierce') {
          hasPierce = true
          console.log('Player 1: Pierce ability acquired! Blasts pass through blocks!')
        } else if (powerUp.type === 'ghost') {
          ghostTimer = 8000 // 8 seconds
          console.log('Player 1: Ghost mode activated! Walk through blocks for 8s!')
        } else if (powerUp.type === 'powerBomb') {
          powerBombCharges++
          console.log('Player 1: Power Bomb! Charges:', powerBombCharges)
        } else if (powerUp.type === 'lineBomb') {
          hasLineBomb = true
          console.log('Player 1: Line Bomb ability acquired!')
        }
        powerUp.mesh.dispose()
        powerUps.splice(i, 1)
        updateUI()
        
        // Play sound and track stats
        if (soundManager) soundManager.playSFX('powerup')
        haptic(35)
        statsManager.recordPowerUpCollected()
        statsManager.recordBlastRadius(blastRadius)
        statsManager.recordBombCount(maxBombs)
        sessionPowerUpsCollected++
        sessionPowerUpTypes.add(powerUp.type)
        
        // Check collector achievement (all 5 types in one game)
        if (sessionPowerUpTypes.size >= 5) {
          if (achievementsManager.unlock('collector')) {
            showAchievementNotification(achievementsManager.getAchievement('collector')!)
          }
        }
        
        // Check power hungry achievement (10 power-ups in one game)
        if (sessionPowerUpsCollected >= 10) {
          if (achievementsManager.unlock('power-hungry')) {
            showAchievementNotification(achievementsManager.getAchievement('power-hungry')!)
          }
        }
        continue
      }
      
      // Player 2 collection (PvP mode)
      if (gameMode === 'pvp' && powerUp.x === player2GridX && powerUp.y === player2GridY) {
        if (powerUp.type === 'extraBomb') {
          player2MaxBombs++
          console.log('Player 2: Extra bomb! Max bombs:', player2MaxBombs)
        } else if (powerUp.type === 'largerBlast') {
          player2BlastRadius++
          console.log('Player 2: Larger blast! Blast radius:', player2BlastRadius)
        } else if (powerUp.type === 'kick') {
          player2HasKick = true
          console.log('Player 2: Kick ability acquired!')
        } else if (powerUp.type === 'throw') {
          player2HasThrow = true
          console.log('Player 2: Throw ability acquired!')
        } else if (powerUp.type === 'speed') {
          player2Speed++
          player2MoveDelay = Math.max(50, 150 - (player2Speed - 1) * 30)
          console.log('Player 2: Speed increased! Speed:', player2Speed)
        } else if (powerUp.type === 'shield') {
          player2ShieldCharges = Math.min(3, player2ShieldCharges + 1)
          console.log('Player 2: Shield! Charges:', player2ShieldCharges)
        } else if (powerUp.type === 'pierce') {
          player2HasPierce = true
          console.log('Player 2: Pierce ability acquired!')
        } else if (powerUp.type === 'ghost') {
          player2GhostTimer = 8000
          console.log('Player 2: Ghost mode activated!')
        } else if (powerUp.type === 'powerBomb') {
          player2PowerBombCharges++
          console.log('Player 2: Power Bomb! Charges:', player2PowerBombCharges)
        } else if (powerUp.type === 'lineBomb') {
          player2HasLineBomb = true
          console.log('Player 2: Line Bomb ability acquired!')
        }
        powerUp.mesh.dispose()
        powerUps.splice(i, 1)
        updateUI()

        // Player 2 collected power-ups silently before this.
        if (soundManager) soundManager.playSFX('powerup')
        statsManager.recordPowerUpCollected()
      }
    }
  }

  // Kick bomb function — shared by both players so Player 2's kick power-up
  // actually does something (it used to be a no-op comment).
  function kickBombFrom(originX: number, originY: number, dx: number, dy: number) {
    // Check if there's a bomb in the direction we're moving
    const bombAtTarget = bombs.find(b => b.x === originX + dx && b.y === originY + dy)
    if (!bombAtTarget) return false

    // Find the nearest obstacle in the kick direction
    let kickDistance = 1
    while (true) {
      const checkX = bombAtTarget.x + dx * kickDistance
      const checkY = bombAtTarget.y + dy * kickDistance

      // Stop if out of bounds
      if (checkX < 0 || checkY < 0 || checkX >= GRID_WIDTH || checkY >= GRID_HEIGHT) {
        kickDistance--
        break
      }

      // Stop if we hit a wall or destructible block
      if (grid[checkY][checkX] === 'wall' || grid[checkY][checkX] === 'destructible') {
        kickDistance--
        break
      }

      // Stop if there's another bomb
      if (bombs.some(b => b !== bombAtTarget && b.x === checkX && b.y === checkY)) {
        kickDistance--
        break
      }

      kickDistance++
    }

    // Move the bomb to the new position
    if (kickDistance > 0) {
      bombAtTarget.x += dx * kickDistance
      bombAtTarget.y += dy * kickDistance
      
      // Play kick sound
      if (soundManager) soundManager.playSFX('kick')
      haptic(30)
      
      // Animate the bomb movement
      const targetPos = gridToWorld(bombAtTarget.x, bombAtTarget.y)
      const moveAnim = new Animation('moveAnim', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3)
      moveAnim.setKeys([
        { frame: 0, value: bombAtTarget.mesh.position.clone() },
        { frame: 10, value: targetPos },
      ])
      bombAtTarget.mesh.animations.push(moveAnim)
      scene.beginAnimation(bombAtTarget.mesh, 0, 10, false)
      
      console.log(`Kicked bomb ${kickDistance} tiles!`)
      return true
    }
    return false
  }

  function kickBomb(dx: number, dy: number) {
    if (!hasKick) return false
    return kickBombFrom(playerGridX, playerGridY, dx, dy)
  }

  function kickBombPlayer2(dx: number, dy: number) {
    if (!player2HasKick) return false
    return kickBombFrom(player2GridX, player2GridY, dx, dy)
  }

  /** Offline player 1. Networked players go through throwBombFrom directly. */
  function throwBomb(dx: number, dy: number) {
    if (!hasThrow) return false
    return throwBombFrom(playerGridX, playerGridY, dx, dy)
  }

  /**
   * Throw the bomb standing on `(originX, originY)` up to three tiles along
   * `(dx, dy)`, clearing obstacles in between.
   *
   * Takes an origin rather than reading player 1's globals so the host can run
   * it for any networked player — throw was collectable online but had no code
   * path that could ever fire it.
   */
  function throwBombFrom(originX: number, originY: number, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return false

    const bombAtPlayer = bombs.find(b => b.x === originX && b.y === originY)
    if (!bombAtPlayer) return false

    // Throw distance is 3 tiles - bomb flies over obstacles and lands on the other side
    const throwDistance = 3
    let finalX = originX
    let finalY = originY

    // Check from farthest to nearest to find valid landing spot (skipping over obstacles)
    for (let i = throwDistance; i >= 1; i--) {
      const checkX = originX + dx * i
      const checkY = originY + dy * i

      // Skip if out of bounds
      if (checkX < 0 || checkY < 0 || checkX >= GRID_WIDTH || checkY >= GRID_HEIGHT) {
        continue
      }

      // Skip if it's a wall or destructible block (can't land there)
      if (grid[checkY][checkX] === 'wall' || grid[checkY][checkX] === 'destructible') {
        continue
      }

      // Skip if there's another bomb
      if (bombs.some(b => b !== bombAtPlayer && b.x === checkX && b.y === checkY)) {
        continue
      }

      // Found a valid spot!
      finalX = checkX
      finalY = checkY
      break
    }

    // Move the bomb to the new position
    if (finalX !== originX || finalY !== originY) {
      bombAtPlayer.x = finalX
      bombAtPlayer.y = finalY
      
      // Play throw sound
      if (soundManager) soundManager.playSFX('throw')
      haptic(30)
      
      // Animate the bomb movement (faster than kick)
      const targetPos = gridToWorld(bombAtPlayer.x, bombAtPlayer.y)
      const moveAnim = new Animation('moveAnim', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3)
      moveAnim.setKeys([
        { frame: 0, value: bombAtPlayer.mesh.position.clone() },
        { frame: 8, value: targetPos },
      ])
      bombAtPlayer.mesh.animations.push(moveAnim)
      scene.beginAnimation(bombAtPlayer.mesh, 0, 8, false)
      
      console.log(`Threw bomb to (${finalX}, ${finalY})!`)
      return true
    }
    return false
  }

  // Track last movement direction for throw
  let lastDx = 0
  let lastDy = -1 // Default facing up

  // Player 2 bomb placement
  function placeBombPlayer2(x: number, y: number) {
    if (player2CurrentBombs >= player2MaxBombs) return
    
    // Check if there's already a bomb at this position
    if (bombs.some(b => b.x === x && b.y === y)) return

    const bombMesh = createBombMesh()
    bombMesh.position = gridToWorld(x, y)

    // Calculate blast radius (with Power Bomb bonus)
    let effectiveBlastRadius = player2BlastRadius
    if (player2PowerBombCharges > 0) {
      effectiveBlastRadius += 3
      player2PowerBombCharges--
      if (bombMesh.material) {
        const pbMat = (bombMesh.material as StandardMaterial).clone('power-bomb-p2-mat')!
        pbMat.emissiveColor = new Color3(1, 0.4, 0)
        bombMesh.material = pbMat
      }
      updateUI()
    }

    bombs.push({
      x,
      y,
      timer: 2200,
      mesh: bombMesh,
      blastRadius: effectiveBlastRadius,
      ownerId: -2,
    })
    cacheBombChildRefs(bombs[bombs.length - 1])
    player2CurrentBombs++
    if (player2 && (player2 as any).triggerSquash) (player2 as any).triggerSquash()
    
    // Play sound
    if (soundManager) soundManager.playSFX('bomb-place')
    haptic(25)
  }

  // Player 2 throw bomb
  function throwBombPlayer2(dx: number, dy: number) {
    if (!player2HasThrow) return false
    
    const bombAtPlayer = bombs.find(b => b.x === player2GridX && b.y === player2GridY)
    if (!bombAtPlayer) return false

    // Throw distance is 3 tiles - bomb flies over obstacles and lands on the other side
    const throwDistance = 3
    let finalX = player2GridX
    let finalY = player2GridY

    // Check from farthest to nearest to find valid landing spot (skipping over obstacles)
    for (let i = throwDistance; i >= 1; i--) {
      const checkX = player2GridX + dx * i
      const checkY = player2GridY + dy * i

      if (checkX < 0 || checkY < 0 || checkX >= GRID_WIDTH || checkY >= GRID_HEIGHT) continue
      if (grid[checkY][checkX] === 'wall' || grid[checkY][checkX] === 'destructible') continue
      if (bombs.some(b => b !== bombAtPlayer && b.x === checkX && b.y === checkY)) continue

      finalX = checkX
      finalY = checkY
      break
    }

    if (finalX !== player2GridX || finalY !== player2GridY) {
      bombAtPlayer.x = finalX
      bombAtPlayer.y = finalY
      
      const targetPos = gridToWorld(bombAtPlayer.x, bombAtPlayer.y)
      const moveAnim = new Animation('moveAnim', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3)
      moveAnim.setKeys([
        { frame: 0, value: bombAtPlayer.mesh.position.clone() },
        { frame: 8, value: targetPos },
      ])
      bombAtPlayer.mesh.animations.push(moveAnim)
      scene.beginAnimation(bombAtPlayer.mesh, 0, 8, false)
      
      return true
    }
    return false
  }

  // Track which keys are currently held down for smooth movement
  const keysHeld: Set<string> = new Set()
  /** Edge-triggered bomb request, consumed once per online tick. */
  let netBombRequested = false

  // On-screen controls. Driven by the "On-Screen Controls" setting rather than
  // isMobile(), so desktop players can opt into the D-pad and bomb button and
  // drive them with the mouse.
  if (useOnScreenControls) {
    // Clean up any existing controls
    document.querySelectorAll('.mobile-controls-container').forEach(el => el.remove())

    const controlsContainer = document.createElement('div')
    controlsContainer.className = 'mobile-controls-container mobile-controls-visible'
    if (!isMobileDevice) controlsContainer.classList.add('desktop-controls')
    document.body.appendChild(controlsContainer)

    // D-Pad with slide support
    const dpad = document.createElement('div')
    dpad.className = 'dpad'
    controlsContainer.appendChild(dpad)

    // Track D-pad buttons for slide detection
    const dpadButtons: { btn: HTMLElement; key: string }[] = []
    let activeDpadKey: string | null = null
    let dpadPointerId: number | null = null

    const releaseAllDpadKeys = () => {
      dpadButtons.forEach(({ btn, key }) => {
        keysHeld.delete(key)
        keyPressTime.delete(key)
        btn.classList.remove('active')
      })
      activeDpadKey = null
    }

    const engageKey = (key: string) => {
      if (activeDpadKey === key) return
      releaseAllDpadKeys()
      const entry = dpadButtons.find(b => b.key === key)
      if (!entry) return
      keysHeld.add(key)
      keyPressTime.set(key, Date.now())
      entry.btn.classList.add('active')
      activeDpadKey = key
      // Step immediately instead of waiting for the next frame's poll. A quick
      // mouse click can start and finish inside a single frame, which would
      // otherwise register as no input at all.
      if (!gameOver && !isPaused) processHeldKeys()
    }

    const createBtn = (cls: string, key: string) => {
      const btn = document.createElement('div')
      btn.className = `dpad-btn ${cls}`
      dpad.appendChild(btn)
      dpadButtons.push({ btn, key })

      // Pointer events cover mouse, touch and pen with one code path.
      btn.addEventListener('pointerdown', (e) => {
        if (e.cancelable) e.preventDefault()
        dpadPointerId = e.pointerId
        engageKey(key)
      })
    }

    createBtn('dpad-up', 'w')
    createBtn('dpad-down', 's')
    createBtn('dpad-left', 'a')
    createBtn('dpad-right', 'd')

    // Slide between D-pad buttons without lifting the finger / mouse button
    dpad.addEventListener('pointermove', (e) => {
      if (dpadPointerId === null || e.pointerId !== dpadPointerId) return
      if (e.cancelable) e.preventDefault()
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (!el) return

      for (const { btn, key } of dpadButtons) {
        if (el === btn || btn.contains(el)) {
          engageKey(key)
          return
        }
      }
    })

    // Releasing anywhere clears the D-pad, so a pointer that leaves the button
    // (or a window that loses focus) can never leave a direction stuck down.
    const releaseDpad = (e?: PointerEvent) => {
      if (e && dpadPointerId !== null && e.pointerId !== dpadPointerId) return
      dpadPointerId = null
      releaseAllDpadKeys()
    }
    window.addEventListener('pointerup', releaseDpad)
    window.addEventListener('pointercancel', releaseDpad)
    window.addEventListener('blur', () => releaseDpad())

    // Action Button
    const actionContainer = document.createElement('div')
    actionContainer.className = 'action-btn-container'
    controlsContainer.appendChild(actionContainer)

    const actionBtn = document.createElement('div')
    actionBtn.className = 'action-btn'
    actionBtn.textContent = 'BOMB'
    actionContainer.appendChild(actionBtn)

    const performAction = (e: PointerEvent) => {
      if (e.cancelable) e.preventDefault()
      actionBtn.classList.add('active')

      if (gameOver || isPaused) return

      // Online: the host owns bomb placement, so this has to raise the same
      // edge-triggered request the keyboard does rather than place one locally.
      //
      // The D-pad works online only because it drives `keysHeld`, which
      // readLocalNetInput reads. This button bypassed that and called
      // placeBomb() straight out, which online targets the parked player-1
      // state — hidden at its spawn corner — so the bomb went nowhere and the
      // host never heard about it. Touch players simply could not bomb.
      if (online) {
        netBombRequested = true
        const local = localNetPlayer()
        if (local) local.input.bomb = true
        // The host's snapshot is a round trip away; buzz now so the button
        // still feels like it responded.
        haptic(30)
        return
      }

      const bombAtPlayer = bombs.find(b => b.x === playerGridX && b.y === playerGridY)
      if (bombAtPlayer && hasThrow) {
        throwBomb(lastDx, lastDy)
      } else if (hasLineBomb && currentBombs < maxBombs) {
        placeLineBomb(playerGridX, playerGridY, lastDx, lastDy, -1)
      } else {
        placeBomb(playerGridX, playerGridY)
      }
    }

    const endAction = () => actionBtn.classList.remove('active')

    actionBtn.addEventListener('pointerdown', performAction)
    window.addEventListener('pointerup', endAction)
    window.addEventListener('pointercancel', endAction)

    // In AUTO mode the controls follow the viewport across resizes/rotations.
    // The pause button is deliberately not tied to this — it stays visible
    // whether or not the D-pad is showing.
    const controlsResizeHandler = () => {
      const visible = showOnScreenControls(settingsManager.getSettings().onScreenControls)
      if (visible) {
        controlsContainer.classList.add('mobile-controls-visible')
      } else {
        controlsContainer.classList.remove('mobile-controls-visible')
        releaseDpad()
      }
    }
    window.addEventListener('resize', controlsResizeHandler)

    scene.onDisposeObservable.add(() => {
      window.removeEventListener('resize', controlsResizeHandler)
      window.removeEventListener('pointerup', releaseDpad)
      window.removeEventListener('pointercancel', releaseDpad)
      window.removeEventListener('pointerup', endAction)
      window.removeEventListener('pointercancel', endAction)
      releaseAllDpadKeys()
      controlsContainer.remove()
    })
  }

  
  // Movement function that can be called repeatedly
  function movePlayer1(dx: number, dy: number, currentTime: number): boolean {
    // Check arrow keys or WASD
    
    // Check if initial delay has passed (tap vs hold)
    // If movement is triggered less than REPEAT_DELAY after press, it's the INITIAL move.
    // If it's been held longer, we use normal moveDelay.
    
    // However, processHeldKeys calls this repeatedly.
    // We need to enforce: 
    // 1. First call (when key pressed) -> Move instantly.
    // 2. Subsequent calls -> Block until REPEAT_DELAY passed since press.
    // 3. After REPEAT_DELAY -> Allow move every moveDelay.
    
    // BUT lastMoveTime tracks global movement cooldown.
    // We need to check if we are in the "wait for repeat" phase.
    
    // Let's rely on lastMoveTime for the repetition rate, but modulate WHEN we can move.
    
    // Logic:
    // If timeSincePress < REPEAT_DELAY:
    //    Allow move ONLY IF this is the FIRST move since press.
    //    We can check this by seeing if lastMoveTime < pressTime? 
    //    Yes! If lastMoveTime < pressTime, we haven't moved yet for this press.
    
    // If timeSincePress >= REPEAT_DELAY:
    //    Allow move if (currentTime - lastMoveTime > moveDelay)
    
    // But wait, if we have multiple keys held?
    // Let's just solve for mobile D-Pad single key scenario mostly.
    
    // Find the oldest pressed key that matches direction? Or just check against ANY recent key press?
    
    // Let's implement logic: 
    
    // We need to check the startTime for the key driving this movement.
    // Since we're inside movePlayer1(dx, dy), specific to direction...
    // We'll approximate the key check from movement direction for simplicity:
    let relevantKeys: string[] = []
    if (dx === -1) relevantKeys = ['w', 'W', 'ArrowUp']
    if (dx === 1) relevantKeys = ['s', 'S', 'ArrowDown']
    if (dy === -1) relevantKeys = ['a', 'A', 'ArrowLeft']
    if (dy === 1) relevantKeys = ['d', 'D', 'ArrowRight']
    
    let pressTime = 0
    for (const k of relevantKeys) {
        if (keyPressTime.has(k)) {
            pressTime = Math.max(pressTime, keyPressTime.get(k) || 0)
        }
    }
    
    if (pressTime > 0) {
        const timeSincePress = currentTime - pressTime
        
        // Phase 1: Initial Move
        if (timeSincePress < REPEAT_DELAY) {
            // Only move if we haven't moved for this press yet
            // If lastMoveTime is OLDER than pressTime, it means this is the first move.
            if (lastMoveTime >= pressTime) {
                return false // We already moved for this press, waiting for repeat delay
            }
        }
        // Phase 2: Rapid Repeat
        // If timeSincePress >= REPEAT_DELAY, we fall through to normal speed check
    }

    if (currentTime - lastMoveTime < moveDelay) return false
    
    lastDx = dx
    lastDy = dy

    // Always update visual direction even if blocked
    if (player.playAnimation) {
      if (dx < 0) player.playAnimation('walk-up')
      else if (dx > 0) player.playAnimation('walk-down')
      else if (dy < 0) player.playAnimation('walk-left')
      else if (dy > 0) player.playAnimation('walk-right')
    }

    const targetX = playerGridX + dx
    const targetY = playerGridY + dy

    if (targetX < 0 || targetY < 0 || targetX >= GRID_WIDTH || targetY >= GRID_HEIGHT) return false

    // Check if there's a bomb at the target position - kick it!
    const bombAtTarget = bombs.find(b => b.x === targetX && b.y === targetY)
    if (bombAtTarget) {
      if (ghostTimer > 0) {
        // Ghost mode: walk through bombs
      } else if (hasKick) {
        kickBomb(dx, dy)
        lastMoveTime = currentTime
        return true
      } else {
        return false // Block movement if no kick ability
      }
    }

    if (grid[targetY][targetX] === 'wall') return false
    if (grid[targetY][targetX] === 'destructible' && ghostTimer <= 0) return false

    // Check collision with enemies (blocking)
    if (enemies.some(e => e.lives > 0 && e.x === targetX && e.y === targetY)) return false
    
    // Check collision with Player 2 (in PvP)
    if (gameMode === 'pvp' && targetX === player2GridX && targetY === player2GridY) return false

    playerGridX = targetX
    playerGridY = targetY
    // Don't instantly set position - let the smooth interpolation handle it
    // const newPos = gridToWorld(playerGridX, playerGridY)
    // player.position.x = newPos.x
    // player.position.z = newPos.z
    lastMoveTime = currentTime
    
    if (player.playAnimation) {
      if (dx < 0) player.playAnimation('walk-up')
      else if (dx > 0) player.playAnimation('walk-down')
      else if (dy < 0) player.playAnimation('walk-left')
      else if (dy > 0) player.playAnimation('walk-right')
    }
    
    checkPowerUps()
    return true
  }
  
  /** Point a character mesh in the direction it just moved. */
  function faceDirection(mesh: any, dx: number, dy: number) {
    if (!mesh || !mesh.playAnimation) return
    if (dx < 0) mesh.playAnimation('walk-up')
    else if (dx > 0) mesh.playAnimation('walk-down')
    else if (dy < 0) mesh.playAnimation('walk-left')
    else if (dy > 0) mesh.playAnimation('walk-right')
  }

  function movePlayer2(dx: number, dy: number, currentTime: number): boolean {
    if (currentTime - lastPlayer2MoveTime < player2MoveDelay) return false

    lastPlayer2Dx = dx
    lastPlayer2Dy = dy

    // Player 2 never got a walk animation, so it slid around always facing the
    // same way. Turn first, exactly like Player 1 does.
    faceDirection(player2, dx, dy)

    const targetX = player2GridX + dx
    const targetY = player2GridY + dy

    if (targetX < 0 || targetY < 0 || targetX >= GRID_WIDTH || targetY >= GRID_HEIGHT) return false

    // Check bomb collision
    if (bombs.some(b => b.x === targetX && b.y === targetY)) {
      if (player2GhostTimer > 0) {
        // Ghost mode: walk through bombs
      } else if (player2HasKick) {
        // Kick it instead of walking onto it (the old code fell through here
        // and let Player 2 stand on top of a live bomb).
        kickBombPlayer2(dx, dy)
        lastPlayer2MoveTime = currentTime
        return true
      } else {
        return false
      }
    }

    if (grid[targetY][targetX] === 'wall') return false
    if (grid[targetY][targetX] === 'destructible' && player2GhostTimer <= 0) return false

    // Check collision with enemies (blocking)
    if (enemies.some(e => e.lives > 0 && e.x === targetX && e.y === targetY)) return false

    // Check collision with Player 1
    if (targetX === playerGridX && targetY === playerGridY) return false

    player2GridX = targetX
    player2GridY = targetY
    // Don't instantly set position - let the smooth interpolation handle it
    lastPlayer2MoveTime = currentTime

    checkPowerUps()
    return true
  }

  // Process held keys each frame for smooth movement
  function processHeldKeys() {
    if (gameOver || isPaused) return
    
    const currentTime = Date.now()
    
    // Player 1 movement (WASD) - check priority order
    if (keysHeld.has('w') || keysHeld.has('W')) {
      movePlayer1(-1, 0, currentTime)
    } else if (keysHeld.has('s') || keysHeld.has('S')) {
      movePlayer1(1, 0, currentTime)
    } else if (keysHeld.has('a') || keysHeld.has('A')) {
      movePlayer1(0, -1, currentTime)
    } else if (keysHeld.has('d') || keysHeld.has('D')) {
      movePlayer1(0, 1, currentTime)
    }
    
    // Player 2 movement (Arrow keys)
    if (gameMode === 'pvp') {
      if (keysHeld.has('ArrowUp')) {
        movePlayer2(-1, 0, currentTime)
      } else if (keysHeld.has('ArrowDown')) {
        movePlayer2(1, 0, currentTime)
      } else if (keysHeld.has('ArrowLeft')) {
        movePlayer2(0, -1, currentTime)
      } else if (keysHeld.has('ArrowRight')) {
        movePlayer2(0, 1, currentTime)
      }
    }
  }

  // Move tracking for tap vs hold logic
  // We want: initial press -> 1 move immediately.
  // Then wait for REPEAT_DELAY (e.g. 200ms).
  // Then if still held, move every moveDelay (depends on speed).
  // This prevents "double move" on quick taps when speed is high (and moveDelay is low).
  
  let keyPressTime: Map<string, number> = new Map() // When was the key first pressed?
  const REPEAT_DELAY = 180 // ms before repeating starts
  
  // Keyboard handlers
  const keydownHandler = (ev: KeyboardEvent) => {
    // Pause/Escape handling
    if (ev.key === 'Escape') {
      if (pauseMenu.style.display === 'none') {
        isPaused = true
        pauseMenu.style.display = 'flex'
      } else {
        isPaused = false
        pauseMenu.style.display = 'none'
      }
      return
    }

    if (gameOver || isPaused) return

    // Add key to held set
    if (!keysHeld.has(ev.key)) {
        keysHeld.add(ev.key)
        keyPressTime.set(ev.key, Date.now()) // Track start time of press
        
        // IMMEDIATE MOVE on press (if cooldown allows, but we force it for responsiveness?)
        // Actually, processHeldKeys runs every frame. We should handle the logic there
        // OR we can force a move here?
        // Better to let processHeldKeys handle it, but we need to reset "lastMoveTime" logic?
        // No, processHeldKeys checks "currentTime - lastMoveTime".
        // If we want to force a move immediately regardless of previous cooldown?
        // Typically, yes, a fresh keypress usually overrides a lingering cooldown slightly for responsiveness,
        // unless it's very fast spamming.
        // But the issue is the OPPOSITE: moving too much.
        // So we don't force move here. We just mark the start time.
    }

    // Online: bomb is edge-triggered and resolved by the host.
    if (online && (ev.key === ' ' || ev.key === 'Enter')) {
      netBombRequested = true
      const local = localNetPlayer()
      if (local) local.input.bomb = true
      return
    }

    // Handle bomb placement (immediate, not held)
    if (ev.key === ' ') {
      const bombAtPlayer = bombs.find(b => b.x === playerGridX && b.y === playerGridY)
      if (bombAtPlayer && hasThrow) {
        throwBomb(lastDx, lastDy)
      } else if (hasLineBomb && currentBombs < maxBombs) {
        placeLineBomb(playerGridX, playerGridY, lastDx, lastDy, -1)
      } else {
        placeBomb(playerGridX, playerGridY)
      }
      return
    }
    
    if (ev.key === 'Enter' && gameMode === 'pvp') {
      const bombAtPlayer2 = bombs.find(b => b.x === player2GridX && b.y === player2GridY)
      if (bombAtPlayer2 && player2HasThrow) {
        throwBombPlayer2(lastPlayer2Dx, lastPlayer2Dy)
      } else if (player2HasLineBomb && player2CurrentBombs < player2MaxBombs) {
        placeLineBomb(player2GridX, player2GridY, lastPlayer2Dx, lastPlayer2Dy, -2)
      } else {
        placeBombPlayer2(player2GridX, player2GridY)
      }
      return
    }
  }
  
  const keyupHandler = (ev: KeyboardEvent) => {
    keysHeld.delete(ev.key)
    keyPressTime.delete(ev.key)
  }
  
  window.addEventListener('keydown', keydownHandler)
  window.addEventListener('keyup', keyupHandler)
  
  // Clean up event listeners when scene is disposed
  scene.onDisposeObservable.add(() => {
    window.removeEventListener('keydown', keydownHandler)
    window.removeEventListener('keyup', keyupHandler)
  })

  // Off-screen indicators
  const indicatorContainer = document.createElement('div')
  indicatorContainer.id = 'indicator-container'
  document.body.appendChild(indicatorContainer)
  const activeIndicators = new Map<string, HTMLElement>()

  // Cleanup on scene dispose
  scene.onDisposeObservable.add(() => {
    indicatorContainer.remove()
  })

  const _indicatorIdentity = Matrix.Identity()
  const _indicatorTargetPos = new Vector3()
  let lastIndicatorUpdate = 0
  const INDICATOR_UPDATE_INTERVAL = 100 // Throttle to ~10fps

  function updateOffscreenIndicators() {
    // Throttle indicator updates to reduce DOM writes + projection overhead
    const now = Date.now()
    if (now - lastIndicatorUpdate < INDICATOR_UPDATE_INTERVAL) return
    lastIndicatorUpdate = now

    // Collect all targets (enemies + player 2 if in PVP)
    const targets: { id: string, x: number, z: number, color: string, active: boolean }[] = []
    
    enemies.forEach((enemy, idx) => {
      if (enemy.lives > 0) {
        // Find the color used for this enemy or default to red
        const color = (idx < enemyColors.length) ? enemyColors[idx] : '#ff4444'
        gridToWorldInPlace(enemy.x, enemy.y, _tmpGridVec)
        targets.push({ id: `enemy-${idx}`, x: _tmpGridVec.x, z: _tmpGridVec.z, color, active: true })
      }
    })

    // Online matches carry gameMode 'pvp' but have no local player 2 mesh —
    // dereferencing it here threw inside the render loop, which silently killed
    // every subsequent frame for the whole scene.
    if (online) {
      for (const np of netPlayers) {
        if (np.isLocal || !np.alive) continue
        gridToWorldInPlace(np.x, np.y, _tmpGridVec)
        targets.push({
          id: `net-${np.slot}`,
          x: _tmpGridVec.x,
          z: _tmpGridVec.z,
          color: PLAYER_COLORS[np.slot % PLAYER_COLORS.length].value,
          active: true,
        })
      }
    } else if (gameMode === 'pvp' && player2 && player2Lives > 0) {
        // Add player 2
        targets.push({ id: 'p2', x: player2.position.x, z: player2.position.z, color: '#4488ff', active: true })
    }

    // Process targets
    targets.forEach(target => {
        let indicator = activeIndicators.get(target.id)
        if (!indicator) {
            indicator = document.createElement('div')
            indicator.className = 'offscreen-indicator'
            const arrow = document.createElement('div')
            arrow.className = 'offscreen-arrow'
            arrow.style.borderBottomColor = target.color
            indicator.appendChild(arrow)
            indicatorContainer.appendChild(indicator)
            activeIndicators.set(target.id, indicator)
        }

        // Project position to screen space (reuse cached objects)
        _indicatorTargetPos.copyFromFloats(target.x, TILE_SIZE/2, target.z)
        const screenPos = Vector3.Project(
            _indicatorTargetPos,
            _indicatorIdentity,
            scene.getTransformMatrix(),
            camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
        )

        const screenWidth = engine.getRenderWidth()
        const screenHeight = engine.getRenderHeight()
        const padding = 40 // Margin from edge

        // Check if onscreen
        // Note: screenPos.x/y are in pixels from top-left (BabylonJS uses bottom-left for viewport usually, but Project returns screen coordinates?)
        // Let's verify Babylon Project. Returns x, y, z where x, y are in pixels (0,0 is usually top-left for overlay logic depending on viewport, but Babylon engine standard is bottom-left? No, usually coordinate system needs checking)
        // Actually, Project returns coordinates in window space usually.
        // Let's check if it's within bounds.
        
        const isOffscreen = screenPos.x < padding || screenPos.x > screenWidth - padding || 
                            screenPos.y < padding || screenPos.y > screenHeight - padding
        
        if (isOffscreen) {
            indicator.style.display = 'flex'
            
            // Calculate clamped position
            const centerX = screenWidth / 2
            const centerY = screenHeight / 2
            
            // Vector from center to target
            // screenPos z is depth (0-1). If z < 0 or > 1, it's clipped by near/far planes.
            // But we care about X/Y being outside viewport.
            
            let dx = screenPos.x - centerX
            let dy = screenPos.y - centerY
            
            // If behind camera (shouldn't happen in top-down ortho usually, but safe to check)
            // Just use the direction
            
            const angle = Math.atan2(dy, dx)
            
            // Ray intersection with simplified box (screen bounds minus padding)
            // Tan(angle) = y/x
            // We want to find x,y on the box border.
            
            const boxW = (screenWidth / 2) - padding
            const boxH = (screenHeight / 2) - padding
            
            // Normalize direction
            // Calculate intersection with vertical edges
            let intersectX = dx > 0 ? boxW : -boxW
            let intersectY = intersectX * Math.tan(angle)
            
            // If y intersection is out of bounds, check horizontal edges
            if (Math.abs(intersectY) > boxH) {
                intersectY = dy > 0 ? boxH : -boxH
                intersectX = intersectY / Math.tan(angle)
            }
            
            const finalX = centerX + intersectX
            const finalY = centerY + intersectY
            
            // Update CSS
            indicator.style.left = `${finalX - 20}px` // Center the 40px div
            indicator.style.top = `${finalY - 20}px`
            
            // Rotation: angle + 90deg because arrow points up by default
            const rotationDeg = (angle * 180 / Math.PI) + 90
            indicator.style.transform = `rotate(${rotationDeg}deg)`
            
        } else {
            indicator.style.display = 'none'
        }
    })

    // Clean up indicators for inactive targets (e.g. dead enemies)
    // Though usually enemies stay in array? Yes, logic uses enemy.lives > 0
    // If enemy dies, we should hide/remove.
    // Ideally we diff the map keys vs current active keys.
    const activeIds = new Set(targets.map(t => t.id))
    activeIndicators.forEach((el, id) => {
        if (!activeIds.has(id)) {
            el.remove()
            activeIndicators.delete(id)
        }
    })
  }

  // Route relayed traffic into this scene. The lobby screen keeps its own
  // handlers for everything else, so these are installed on top and removed
  // when the scene is disposed.
  if (online) {
    const previous = (online.net as any).handlers
    online.net.setHandlers({
      ...previous,
      onRelayInput: msg => {
        // Host only: fold a guest's input into their player slot.
        const np = netPlayerById(msg.playerId)
        if (!np || msg.seq <= np.inputSeq) return
        np.inputSeq = msg.seq
        np.input = { dx: msg.dx, dy: msg.dy, bomb: msg.bomb || np.input.bomb }
      },
      onRelayState: msg => {
        // Guest only: adopt the host's world.
        applySnapshot(msg.payload as WorldSnapshot)
      },
    })
    scene.onDisposeObservable.add(() => {
      online.net.setHandlers(previous ?? {})
    })
  }

  /** Keep the camera on a target, clamped so it never shows outside the arena. */
  function followCamera(targetX: number, targetZ: number): void {
    // The screen axes are transposed relative to the world: world X runs *down*
    // the screen and world Z *across* it (see gridToWorld). So the camera's
    // vertical extent bounds X and its horizontal extent bounds Z.
    //
    // Pairing them the other way round is not a rounding error, it disables the
    // follow entirely: on a phone the box is tall and narrow, so using the
    // vertical extent for Z made the Z limits collapse to zero and pinned the
    // camera on exactly the axis the zoom crops. Read off the camera rather
    // than from viewportHalf*, because the framing resizes the box to the
    // viewport.
    const halfExtentX = (camera.orthoTop! - camera.orthoBottom!) / 2
    const halfExtentZ = (camera.orthoRight! - camera.orthoLeft!) / 2

    const minX = -halfWorldWidth - margin + halfExtentX
    const maxX = halfWorldWidth + margin - halfExtentX
    const minZ = -halfWorldHeight - margin + halfExtentZ
    const maxZ = halfWorldHeight + margin - halfExtentZ

    // When the viewport is wider than the world there is nothing to pan to.
    const clampedX = minX > maxX ? 0 : Math.max(minX, Math.min(maxX, targetX))
    const clampedZ = minZ > maxZ ? 0 : Math.max(minZ, Math.min(maxZ, targetZ))

    const lerpSpeed = 0.1
    camera.target.x = camera.target.x + (clampedX - camera.target.x) * lerpSpeed
    camera.target.z = camera.target.z + (clampedZ - camera.target.z) * lerpSpeed
  }
  // ── Online match plumbing ──────────────────────────────────────────────────
  // Host-authoritative: the host simulates and ships snapshots, guests send
  // inputs and render whatever comes back. Guests never simulate, so there is
  // no second source of truth to drift from.

  /** Blast and crate events accumulated since the last snapshot. */
  const pendingBlasts: Array<[number, number]> = []
  const pendingCleared: Array<[number, number]> = []

  let lastSentInput = ''
  let lastSnapshotAt = 0
  let roundReported = false
  /**
   * Sequence number of the newest input this guest has already acted on locally.
   *
   * Prediction and reconciliation hang off this: applySnapshot ignores the
   * host's position for the local player until the host acknowledges at least
   * this input, so a snapshot in flight cannot undo a move we have shown.
   */
  let lastPredictedSeq = -1
  /** Bomb meshes a guest is showing, keyed by tile. */
  const guestBombMeshes = new Map<string, any>()
  const guestPowerUpMeshes = new Map<string, any>()

  const SNAPSHOT_INTERVAL_MS = 66 // ~15Hz
  const ONLINE_TICK_MS = 33 // ~30Hz simulation, independent of frame rate
  /** How long the host lets the final explosion play before ending the round. */
  const ROUND_OVER_GRACE_MS = 1300

  /**
   * Can this networked player step onto the tile?
   *
   * Ghost mode walks through crates and bombs, matching the offline rule.
   */
  function netCanWalk(np: NetPlayer, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= GRID_WIDTH || ty >= GRID_HEIGHT) return false
    const ghosting = np.ghostTimer > 0
    if (grid[ty][tx] === 'wall') return false
    if (grid[ty][tx] === 'destructible' && !ghosting) return false
    if (!ghosting && bombs.some(b => b.x === tx && b.y === ty)) return false
    return !netPlayers.some(other => other !== np && other.alive && other.x === tx && other.y === ty)
  }

  /** Apply one player's current input. Host only. */
  function stepNetPlayer(np: NetPlayer, now: number, stepMs: number): void {
    if (!np.alive) return
    const { dx, dy, bomb } = np.input

    // Ghost runs down on the host, which owns the clock for it.
    if (np.ghostTimer > 0) {
      np.ghostTimer = Math.max(0, np.ghostTimer - stepMs)
      setCharacterVisibility(np.mesh, np.ghostTimer > 0 ? 0.5 : 1)
    }

    if (dx !== 0 || dy !== 0) {
      np.lastDx = dx
      np.lastDy = dy
      faceDirection(np.mesh, dx, dy)
      if (now - np.lastMoveTime >= np.moveDelay) {
        const tx = np.x + dx
        const ty = np.y + dy
        if (netCanWalk(np, tx, ty)) {
          np.x = tx
          np.y = ty
          np.lastMoveTime = now
          collectNetPowerUps(np)
        } else if (np.hasKick && bombs.some(b => b.x === tx && b.y === ty)) {
          // Blocked by a bomb, and this player can kick — shove it along.
          // kickBombFrom already works from an arbitrary tile; nothing was
          // calling it for networked players, so kick was collectable online
          // but inert.
          kickBombFrom(np.x, np.y, dx, dy)
          np.lastMoveTime = now
        }
      }
    }

    if (bomb) {
      const bombUnderfoot = bombs.find(b => b.x === np.x && b.y === np.y)
      if (bombUnderfoot && np.hasThrow) {
        // Standing on your own bomb with throw: hurl it, exactly as the
        // offline bomb key does.
        throwBombFrom(np.x, np.y, np.lastDx, np.lastDy)
      } else if (!bombUnderfoot && np.currentBombs < np.maxBombs) {
        if (np.hasLineBomb) {
          np.currentBombs += placeNetLineBomb(np)
        } else {
          placeBomb(np.x, np.y, netOwnerId(np.slot), np.blastRadius)
          np.currentBombs++
        }
        if ((np.mesh as any).triggerSquash) (np.mesh as any).triggerSquash()
      }
    }
    // Bomb is edge-triggered: clear it so holding the key does not chain-place.
    np.input.bomb = false
  }

  /**
   * Lay a row of bombs ahead of a networked player, up to their spare capacity.
   * Mirrors placeLineBomb, which reads player-1 globals and so could not serve
   * a networked player.
   */
  function placeNetLineBomb(np: NetPlayer): number {
    const dx = np.lastDx
    const dy = np.lastDy
    const available = np.maxBombs - np.currentBombs
    if (available <= 0) return 0

    let placed = 0
    for (let i = 0; i < available; i++) {
      const bx = np.x + dx * i
      const by = np.y + dy * i
      if (bx < 0 || by < 0 || bx >= GRID_WIDTH || by >= GRID_HEIGHT) break
      if (grid[by][bx] === 'wall' || grid[by][bx] === 'destructible') break
      if (bombs.some(b => b.x === bx && b.y === by)) continue
      placeBomb(bx, by, netOwnerId(np.slot), np.blastRadius)
      placed++
    }
    return placed
  }

  /** Power-up pickup for networked players. Host only. */
  function collectNetPowerUps(np: NetPlayer): void {
    for (let i = powerUps.length - 1; i >= 0; i--) {
      const pu = powerUps[i]
      if (pu.x !== np.x || pu.y !== np.y) continue

      if (pu.type === 'extraBomb') np.maxBombs = Math.min(8, np.maxBombs + 1)
      else if (pu.type === 'largerBlast') np.blastRadius = Math.min(8, np.blastRadius + 1)
      else if (pu.type === 'kick') np.hasKick = true
      else if (pu.type === 'throw') np.hasThrow = true
      else if (pu.type === 'speed') {
        np.speed++
        np.moveDelay = Math.max(60, 150 - (np.speed - 1) * 30)
      }
      // Extended pool. These were missing entirely, so online the pickup was
      // consumed and silently discarded — strictly worse than not dropping it.
      // Caps and durations match the offline player exactly.
      else if (pu.type === 'shield') np.shieldCharges = Math.min(3, np.shieldCharges + 1)
      else if (pu.type === 'pierce') np.hasPierce = true
      else if (pu.type === 'ghost') np.ghostTimer = 8000
      else if (pu.type === 'powerBomb') np.powerBombCharges++
      else if (pu.type === 'lineBomb') np.hasLineBomb = true

      pu.mesh.dispose()
      powerUps.splice(i, 1)
      if (np.isLocal && soundManager) soundManager.playSFX('powerup')
      updateUI()
    }
  }

  /**
   * Current movement direction from the keyboard or D-pad.
   *
   * Split out from readLocalNetInput because prediction reads the direction
   * every frame, and must not consume the edge-triggered bomb request while
   * doing so.
   */
  function readLocalMoveDirection(): { dx: number; dy: number } {
    if (keysHeld.has('w') || keysHeld.has('W') || keysHeld.has('ArrowUp')) return { dx: -1, dy: 0 }
    if (keysHeld.has('s') || keysHeld.has('S') || keysHeld.has('ArrowDown')) return { dx: 1, dy: 0 }
    if (keysHeld.has('a') || keysHeld.has('A') || keysHeld.has('ArrowLeft')) return { dx: 0, dy: -1 }
    if (keysHeld.has('d') || keysHeld.has('D') || keysHeld.has('ArrowRight')) return { dx: 0, dy: 1 }
    return { dx: 0, dy: 0 }
  }

  /** Read local controls into the local player's input slot. */
  function readLocalNetInput(): { dx: number; dy: number; bomb: boolean } {
    const { dx, dy } = readLocalMoveDirection()
    const bomb = netBombRequested
    netBombRequested = false
    return { dx, dy, bomb }
  }

  function buildSnapshot(): WorldSnapshot {
    const snapshot: WorldSnapshot = {
      players: netPlayers.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        lives: p.lives,
        alive: p.alive,
        dx: p.lastDx,
        dy: p.lastDy,
        invulnerable: p.invulnerable,
        bombs: p.maxBombs,
        blast: p.blastRadius,
        kick: p.hasKick,
        throwing: p.hasThrow,
        shield: p.shieldCharges,
        pierce: p.hasPierce,
        ghost: p.ghostTimer,
        powerBomb: p.powerBombCharges,
        lineBomb: p.hasLineBomb,
        ackSeq: p.inputSeq,
      })),
      bombs: bombs.map(b => ({ x: b.x, y: b.y, timer: b.timer, blast: b.blastRadius })),
      powerUps: powerUps.map(p => ({ x: p.x, y: p.y, type: p.type })),
      blasts: pendingBlasts.splice(0),
      cleared: pendingCleared.splice(0),
    }
    return snapshot
  }

  /** Guests reconcile their world to the host's snapshot. */
  function applySnapshot(snapshot: WorldSnapshot): void {
    for (const sp of snapshot.players) {
      const np = netPlayerById(sp.id)
      if (!np) continue
      // A drop in lives is the only signal a guest gets that someone was hit,
      // so the feedback has to be raised here rather than in explodeBomb.
      if (sp.lives < np.lives) {
        showHitIndicator(gridToWorld(sp.x, sp.y), scene, np.isLocal)
        if (np.isLocal) {
          if (soundManager) soundManager.playSFX('death')
          haptic([50, 30, 80])
        }
      }
      if (np.isLocal) {
        // The local player predicts its own movement, so the host's position is
        // only worth adopting once it has seen the input we predicted from — a
        // snapshot built before our latest input would drag us back to where we
        // were a round trip ago, which is the rubber-banding that made guests
        // feel laggy in the first place.
        //
        // Even then, a single tile of disagreement along a held direction is
        // just the two clocks being a tick apart and resolves itself. Only a
        // larger gap means we genuinely diverged — blocked, kicked, or killed —
        // and has to be corrected.
        const acknowledged = sp.ackSeq >= lastPredictedSeq
        const drift = Math.abs(sp.x - np.x) + Math.abs(sp.y - np.y)
        if (acknowledged && drift > 1) {
          np.x = sp.x
          np.y = sp.y
        }
      } else {
        np.x = sp.x
        np.y = sp.y
      }

      np.lives = sp.lives
      np.maxBombs = sp.bombs
      np.blastRadius = sp.blast
      np.invulnerable = sp.invulnerable
      np.hasKick = sp.kick
      np.hasThrow = sp.throwing
      np.shieldCharges = sp.shield
      np.hasPierce = sp.pierce
      np.ghostTimer = sp.ghost
      np.powerBombCharges = sp.powerBomb
      np.hasLineBomb = sp.lineBomb

      if (np.alive !== sp.alive) {
        np.alive = sp.alive
        setCharacterVisibility(np.mesh, sp.alive ? 1 : 0)
      } else if (sp.alive) {
        // Ghosted players are see-through on every screen, not just the host's.
        setCharacterVisibility(np.mesh, sp.ghost > 0 ? 0.5 : 1)
      }
      if (sp.dx !== 0 || sp.dy !== 0) faceDirection(np.mesh, sp.dx, sp.dy)
    }

    // Bombs: create meshes for new tiles, drop meshes for tiles that cleared.
    const live = new Set<string>()
    for (const sb of snapshot.bombs) {
      const key = `${sb.x},${sb.y}`
      live.add(key)
      if (!guestBombMeshes.has(key)) {
        const mesh = createBombMesh()
        mesh.position = gridToWorld(sb.x, sb.y)
        guestBombMeshes.set(key, mesh)
      }
      // Keep the fuse time on the mesh so the pulse can be driven per frame.
      // The host animates bombs inside updateBombs, which guests never run, so
      // without this a bomb just sits there inert on every screen but the
      // host's — no wind-up, no warning that it is about to go off.
      ;(guestBombMeshes.get(key) as any)._fuseMs = sb.timer
    }
    for (const [key, mesh] of [...guestBombMeshes]) {
      if (live.has(key)) continue
      mesh.getChildMeshes().forEach((c: any) => c.dispose())
      mesh.dispose()
      guestBombMeshes.delete(key)
    }

    // Replay the host's explosions and crate removals.
    for (const [x, y] of snapshot.cleared) {
      if (grid[y]?.[x] === 'destructible') {
        grid[y][x] = 'empty'
        if (removeCrateAt(x, y)) refreshShadows()
      }
    }
    if (snapshot.blasts.length > 0) {
      playRemoteBlast(snapshot.blasts)
    }

    // Power-ups.
    const livePowerUps = new Set<string>()
    for (const pu of snapshot.powerUps) {
      const key = `${pu.x},${pu.y}`
      livePowerUps.add(key)
      if (!guestPowerUpMeshes.has(key)) {
        const pos = gridToWorld(pu.x, pu.y)
        const plane = MeshBuilder.CreatePlane('powerup-emoji', { size: TILE_SIZE * 0.8 }, scene)
        plane.position.x = pos.x
        plane.position.y = TILE_SIZE * 0.5
        plane.position.z = pos.z
        plane.billboardMode = 7
        plane.material = getPowerUpMaterial(pu.type as PowerUpType)
        guestPowerUpMeshes.set(key, plane)
      }
    }
    for (const [key, mesh] of [...guestPowerUpMeshes]) {
      if (livePowerUps.has(key)) continue
      mesh.dispose()
      guestPowerUpMeshes.delete(key)
    }

    updateUI()
  }

  /**
   * Replay the visuals for blasts the host resolved.
   *
   * Mirrors what explodeBomb draws locally — fireball, halo, ground scorch,
   * fire particles and the trailing smoke — so a guest sees the same
   * explosion the host does rather than a bare flash.
   */
  function playRemoteBlast(tiles: Array<[number, number]>): void {
    screenShake(0.4, 250)
    if (soundManager) soundManager.playSFX('explosion')
    haptic([50, 30, 80])

    const maxEmitters = particlesOn ? (lowSpec ? 3 : 6) : 0
    const stride = Math.max(1, Math.ceil(tiles.length / Math.max(1, maxEmitters)))
    const meshes: any[] = []

    tiles.forEach(([x, y], idx) => {
      const isCenter = idx === 0
      const world = gridToWorld(x, y)

      const fireball = MeshBuilder.CreateSphere('exp-fire', {
        diameter: TILE_SIZE * (isCenter ? 0.95 : 0.8), segments: 8,
      }, scene)
      fireball.position = world.clone()
      fireball.material = sharedExplosionMat
      meshes.push(fireball)

      const halo = MeshBuilder.CreateSphere('exp-halo', {
        diameter: TILE_SIZE * (isCenter ? 1.2 : 1.0), segments: 6,
      }, scene)
      halo.position = world.clone()
      halo.material = sharedHaloMat
      meshes.push(halo)

      const scorch = MeshBuilder.CreateDisc('exp-scorch', {
        radius: TILE_SIZE * 0.4, tessellation: 12,
      }, scene)
      scorch.rotation.x = Math.PI / 2
      scorch.position = world.clone()
      scorch.position.y = 0.02
      scorch.material = sharedScorchMat
      meshes.push(scorch)

      // Same emitter budget the host uses, so a big blast does not spawn a
      // particle system per tile.
      if (maxEmitters > 0 && (isCenter || idx % stride === 0)) {
        createExplosionParticles(x, y)
        setTimeout(() => {
          if (!scene.isDisposed) createSmokeParticles(x, y)
        }, 150)
      }

      const delay = isCenter ? 0 : idx * 0.8

      const scaleAnim = new Animation('scaleAnim', 'scaling', 60, Animation.ANIMATIONTYPE_VECTOR3)
      scaleAnim.setKeys([
        { frame: delay + 0, value: new Vector3(0.05, 0.05, 0.05) },
        { frame: delay + 3, value: new Vector3(1.4, 1.5, 1.4) },
        { frame: delay + 7, value: new Vector3(1.1, 1.0, 1.1) },
        { frame: delay + 14, value: new Vector3(0.5, 0.3, 0.5) },
        { frame: delay + 20, value: new Vector3(0, 0, 0) },
      ])
      fireball.animations.push(scaleAnim)

      const fadeAnim = new Animation('fadeAnim', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      fadeAnim.setKeys([
        { frame: delay + 0, value: 1 },
        { frame: delay + 10, value: 0.9 },
        { frame: delay + 20, value: 0 },
      ])
      fireball.animations.push(fadeAnim)
      scene.beginAnimation(fireball, 0, delay + 24, false)

      const haloScale = new Animation('haloScale', 'scaling', 60, Animation.ANIMATIONTYPE_VECTOR3)
      haloScale.setKeys([
        { frame: delay + 0, value: new Vector3(0.3, 0.3, 0.3) },
        { frame: delay + 4, value: new Vector3(1.5, 1.5, 1.5) },
        { frame: delay + 10, value: new Vector3(2.0, 0.5, 2.0) },
      ])
      halo.animations.push(haloScale)

      const haloFade = new Animation('haloFade', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      haloFade.setKeys([
        { frame: delay + 0, value: 0.5 },
        { frame: delay + 4, value: 0.3 },
        { frame: delay + 10, value: 0 },
      ])
      halo.animations.push(haloFade)
      scene.beginAnimation(halo, 0, delay + 14, false)

      const scorchFade = new Animation('scorchFade', 'visibility', 60, Animation.ANIMATIONTYPE_FLOAT)
      scorchFade.setKeys([
        { frame: 0, value: 0 },
        { frame: 5, value: 0.7 },
        { frame: 40, value: 0.3 },
        { frame: 60, value: 0 },
      ])
      scorch.animations.push(scorchFade)
      scene.beginAnimation(scorch, 0, 60, false)
    })

    const maxDelay = (tiles.length - 1) * 0.8
    const cleanupMs = Math.max(Math.ceil(((maxDelay + 24) / 60) * 1000), 1000) + 100
    setTimeout(() => {
      if (scene.isDisposed) return
      meshes.forEach(m => { if (!m.isDisposed()) m.dispose() })
    }, cleanupMs)
  }
  /**
   * Round ends when at most one player is standing. Host reports the result.
   *
   * The report is held back for a beat. `roundOver` makes every client dispose
   * its arena on the spot, and the blast that just decided the round is still
   * sitting in `pendingBlasts` waiting for the next snapshot — so reporting
   * immediately tore guests down on the frame *before* the explosion, which
   * read as the game freezing rather than as a death.
   */
  function checkNetRoundOver(): void {
    if (!online || !online.isHost || roundReported) return
    const alive = netPlayers.filter(p => p.alive)
    if (alive.length > 1) return
    roundReported = true

    const net = online.net
    const winnerId = alive.length === 1 ? alive[0].id : null

    // Push the killing blast and the death out now, ahead of the result.
    net.send({ t: 'state', tick: Date.now(), payload: buildSnapshot() })
    lastSnapshotAt = Date.now()

    const timer = setTimeout(() => net.send({ t: 'roundResult', winnerId }), ROUND_OVER_GRACE_MS)
    scene.onDisposeObservable.add(() => clearTimeout(timer))
  }

  /**
   * One fixed-rate simulation step.
   *
   * Deliberately NOT driven by requestAnimationFrame. Browsers suspend rAF in
   * unfocused tabs, and because the host owns the simulation that would freeze
   * the match for everyone the moment the host alt-tabbed. A timer keeps
   * ticking (throttled, but alive) and recovers immediately on refocus.
   */
  function simulateOnlineTick(): void {
    if (!online || isPaused || gameOver) return
    const now = Date.now()
    const stepMs = ONLINE_TICK_MS

    const local = localNetPlayer()
    const input = readLocalNetInput()
    if (local) local.input = { ...input, bomb: input.bomb || local.input.bomb }

    if (online.isHost) {
      for (const np of netPlayers) stepNetPlayer(np, now, stepMs)

      // Invulnerability flicker is the host's call, mirrored via the snapshot.
      for (const np of netPlayers) {
        if (!np.invulnerable) continue
        np.invulnerableTimer -= stepMs
        if (np.invulnerableTimer <= 0) {
          np.invulnerable = false
          setCharacterVisibility(np.mesh, np.alive ? 1 : 0)
        }
      }

      checkNetRoundOver()

      // Blasts and crate removals are one-shot events, not state: they are
      // carried by exactly one snapshot and are gone from the next. Waiting out
      // the interval delays every remote explosion by up to a frame's worth of
      // fuse, so send as soon as there is an event to carry.
      const hasEvents = pendingBlasts.length > 0 || pendingCleared.length > 0
      if (hasEvents || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        lastSnapshotAt = now
        online.net.send({ t: 'state', tick: now, payload: buildSnapshot() })
      }
    } else {
      // Guests only publish input, and only when it actually changes, so a
      // still player costs nothing.
      const signature = `${input.dx},${input.dy},${input.bomb}`
      if (signature !== lastSentInput || input.bomb) {
        lastSentInput = signature
        online.net.send({
          t: 'input',
          seq: ++localInputSeq,
          dx: input.dx,
          dy: input.dy,
          bomb: input.bomb,
        })
      }

    }
  }

  /**
   * Apply the local player's movement optimistically, under the host's rules.
   *
   * Deliberately movement only. Bombs, pickups and damage stay entirely with
   * the host — predicting those would mean showing outcomes that might not
   * survive reconciliation, and a bomb that appears and then vanishes is worse
   * than one that appears a few frames late.
   */
  function predictLocalStep(np: NetPlayer, input: { dx: number; dy: number }, now: number): void {
    const { dx, dy } = input
    if (dx === 0 && dy === 0) return

    np.lastDx = dx
    np.lastDy = dy
    faceDirection(np.mesh, dx, dy)

    if (now - np.lastMoveTime < np.moveDelay) return
    const tx = np.x + dx
    const ty = np.y + dy
    if (!netCanWalk(np, tx, ty)) return

    np.x = tx
    np.y = ty
    np.lastMoveTime = now
    lastPredictedSeq = localInputSeq
  }

  /** Visual-only: smooth meshes toward their authoritative grid position. */
  function renderOnlineVisuals(deltaTime: number): void {
    // Predict here rather than on the simulation tick.
    //
    // The tick only runs every 33ms, so predicting there left a keypress
    // waiting up to a full tick before anything moved — small, but enough to
    // feel like the controls answer a frame late. Movement is still gated by
    // the player's own moveDelay, so this only removes the tick quantisation.
    if (online && !online.isHost) {
      const me = localNetPlayer()
      if (me && me.alive && !isPaused && !gameOver) {
        predictLocalStep(me, readLocalMoveDirection(), Date.now())
      }
    }

    const lerp = Math.min(1, MOVE_LERP_SPEED * deltaTime / 1000)
    for (const np of netPlayers) {
      gridToWorldInPlace(np.x, np.y, _tmpGridVec)
      np.visualX += (_tmpGridVec.x - np.visualX) * lerp
      np.visualZ += (_tmpGridVec.z - np.visualZ) * lerp
      np.mesh.position.x = np.visualX
      np.mesh.position.z = np.visualZ
    }

    // Pulse the bombs a guest is showing.
    //
    // The host does this in updateBombs, which guests never run — so on every
    // screen but the host's a bomb sat perfectly still, giving no sense that it
    // was about to go off. The fuse arrives on each snapshot; run it down
    // locally between them so the pulse is smooth rather than stepping at the
    // ~15Hz snapshot rate. Same curve as the host's, so they look identical.
    const now = Date.now()
    for (const mesh of guestBombMeshes.values()) {
      const remaining = ((mesh as any)._fuseMs ?? 0) - deltaTime
      ;(mesh as any)._fuseMs = remaining

      const urgency = Math.max(0, Math.min(1, 1 - remaining / 2000))
      const pulseSpeed = 5 + urgency * 25
      const pulseAmp = 0.06 + urgency * 0.22
      const pulse = 1 + Math.sin((now * pulseSpeed) / 1000) * pulseAmp
      mesh.scaling.copyFromFloats(pulse, pulse * (1 + urgency * 0.08), pulse)
    }
  }

  if (online) {
    // Bombs tick here too, for the same reason: their fuses must not depend on
    // whether the host is looking at the tab.
    let lastTickAt = Date.now()
    const tickTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - lastTickAt
      lastTickAt = now
      // A throw here must not take the match down with it: an uncaught error
      // inside the loop is exactly what silently froze clients before.
      try {
        simulateOnlineTick()
        if (online.isHost && !isPaused && !gameOver) {
          updateBombs(Math.min(elapsed, 250))
        }
      } catch (err) {
        console.error('[net] simulation tick failed', err)
      }
    }, ONLINE_TICK_MS)
    scene.onDisposeObservable.add(() => clearInterval(tickTimer))
  }

  // Dev-only handle for inspecting a live match from the console. Vite strips
  // this branch from production builds.
  if (import.meta.env.DEV) {
    ;(window as any).__game = {
      get scene() { return scene },
      get netPlayers() { return netPlayers },
      get bombs() { return bombs },
      get powerUps() { return powerUps },
      get online() { return online ? { isHost: online.isHost, youId: online.youId, seed: online.seed } : null },
      get grid() { return grid },
      get keysHeld() { return [...keysHeld] },
      get paused() { return isPaused },
      get over() { return gameOver },
      get isCurrentScene() { return currentScene === scene },
      get engineIsCurrent() { return currentEngine === engine },
      get net() { return online?.net ?? null },
    }
  }

  // Game loop update
  let lastTime = Date.now()
  let lastUIUpdateTime = 0
  const UI_UPDATE_INTERVAL = 250 // Update UI at most 4 times per second
  scene.onBeforeRenderObservable.add(() => {
    const currentTime = Date.now()
    const deltaTime = currentTime - lastTime
    lastTime = currentTime

    // Flush coalesced UI writes even while paused, so the panels are populated
    // during the pre-game countdown.
    flushUI()

    if (!isPaused) {
      // Online matches drive movement from the networked player list instead of
      // the local player-1/player-2 pair.
      if (online) {
        // Simulation runs on its own fixed-rate timer; the frame only draws.
        // Guarded because an exception escaping scene.render() permanently
        // kills every later frame for this client.
        try {
          renderOnlineVisuals(deltaTime)
          if (isMobileDevice) {
            const me = localNetPlayer()
            if (me) followCamera(me.visualX, me.visualZ)
          }
          updateOffscreenIndicators()
        } catch (err) {
          console.error('[net] render step failed', err)
        }
        return
      }

      // Process held keys for smooth continuous movement
      processHeldKeys()
      
      // Smooth movement interpolation for player 1 (reuse _tmpGridVec to avoid allocations)
      gridToWorldInPlace(playerGridX, playerGridY, _tmpGridVec)
      const lerpFactor = Math.min(1, MOVE_LERP_SPEED * deltaTime / 1000)
      playerVisualX += (_tmpGridVec.x - playerVisualX) * lerpFactor
      playerVisualZ += (_tmpGridVec.z - playerVisualZ) * lerpFactor
      player.position.x = playerVisualX
      player.position.z = playerVisualZ
      
      // Smooth movement interpolation for player 2 (PvP mode)
      if (gameMode === 'pvp' && player2) {
        gridToWorldInPlace(player2GridX, player2GridY, _tmpGridVec)
        player2VisualX += (_tmpGridVec.x - player2VisualX) * lerpFactor
        player2VisualZ += (_tmpGridVec.z - player2VisualZ) * lerpFactor
        player2.position.x = player2VisualX
        player2.position.z = player2VisualZ
      }
      
      // Smooth movement interpolation for enemies
      enemies.forEach(enemy => {
        if (enemy.lives > 0 && enemy.visualX !== undefined && enemy.visualZ !== undefined) {
          gridToWorldInPlace(enemy.x, enemy.y, _tmpGridVec)
          enemy.visualX += (_tmpGridVec.x - enemy.visualX) * lerpFactor
          enemy.visualZ += (_tmpGridVec.z - enemy.visualZ) * lerpFactor
          enemy.mesh.position.x = enemy.visualX
          enemy.mesh.position.z = enemy.visualZ
        }
      })
      
      // Camera follow logic for mobile (cached — isMobile() reads window.innerWidth)
      if (isMobileDevice) followCamera(player.position.x, player.position.z)
      
      // Call indicator update
      updateOffscreenIndicators()

      updateBombs(deltaTime)
      if (!gameOver) updateEnemies(deltaTime)
      updateInvulnerability(deltaTime)
      
      // Update time attack
      if (gameMode === 'time-attack') {
        gameStateManager.updateTimeAttack(deltaTime)
        
        // Throttle UI updates to avoid heavy DOM manipulation every frame
        if (currentTime - lastUIUpdateTime >= UI_UPDATE_INTERVAL) {
          updateUI()
          lastUIUpdateTime = currentTime
        }
        
        if (gameStateManager.isTimeUp() && !gameOver) {
          gameOver = true
          statsManager.recordLoss()
          if (soundManager) soundManager.playSFX('defeat')
          console.log('Time Up! Game Over!')
          updateUI()
        }
      }
      
    }
  })

  return scene
}

function startGame(mode: GameMode, online?: OnlineContext) {
  // Clean up previous game
  if (currentScene) {
    currentScene.dispose()
  }
  if (currentEngine) {
    currentEngine.dispose()
  }

  // stencil/depth buffers this game never reads just cost bandwidth, and
  // antialiasing is dropped on phones where fill rate is the bottleneck.
  const onPhone = isMobile()
  currentEngine = new Engine(canvas, !onPhone, {
    preserveDrawingBuffer: false,
    stencil: false,
    powerPreference: 'high-performance',
    doNotHandleContextLost: true,
  })
  // Render at the display's real pixel density, capped at 2x.
  //
  // Babylon's hardware scaling level divides the CSS size to get the backbuffer
  // size, so it is the inverse of a device ratio: 0.5 means "two device pixels
  // per CSS pixel". The old `dpr / 2` therefore did the opposite of what it
  // meant — on a 3x phone it rendered at two thirds of CSS resolution, which the
  // display then blew up 4.5x. That is the mobile blur.
  const dpr = window.devicePixelRatio || 1
  currentEngine.setHardwareScalingLevel(1 / Math.min(dpr, 2))

  currentScene = createScene(currentEngine, mode, online)
  
  // IMMEDIATELY UNLOCK AUDIO on user interaction
  if (soundManager) {
      soundManager.resumeAudio()
  }

  // Auto-enter fullscreen on mobile for maximum play area (Android only — iOS doesn't support fullscreen API)
  if (isMobile() && !isIOS()) {
    toggleFullscreen()
  }
  
  // Start paused for countdown
  isPaused = true

  // Handle resize — remove previous listener to prevent accumulation
  const resize = () => {
    currentEngine?.resize()
  }
  window.addEventListener('resize', resize)
  currentScene.onDisposeObservable.add(() => {
    window.removeEventListener('resize', resize)
  })

  currentEngine.runRenderLoop(() => {
    if (currentScene) {
      currentScene.render()
    }
  })
  
  // Show countdown then start game
  showCountdown(() => {
    isPaused = false
    if (soundManager) {
      soundManager.resumeAudio() // Ensure context is unlocked
      soundManager.playSFX('game-start')
      soundManager.playMusic('bgm')
    }
  }, () => {
    // Play tick sound for each countdown number
    if (soundManager) soundManager.playSFX('countdown-tick')
  })
}

// Fullscreen toggle for mobile
function toggleFullscreen() {
  const doc = document as any
  if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
    const el = document.documentElement as any
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  } else {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(() => {})
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen()
  }
}

// Create pause menu
const pauseMenu = createPauseMenu({
  audioPanel: createAudioSettings(settingsManager, () => ensureSoundManager()),
  onResume: () => {
    isPaused = false
    pauseMenu.style.display = 'none'
    ;(pauseMenu as any).collapseAudio?.()
  },
  onQuit: () => {
    // Quit to menu
    isPaused = false
    pauseMenu.style.display = 'none'
    ;(pauseMenu as any).collapseAudio?.()
    mainMenu.style.display = 'flex'

    if (soundManager) soundManager.stopMusic()
    
    // Clean up game — dispose scene first, then engine (correct order for GPU resource cleanup)
    if (currentScene) {
      currentScene.dispose()
      currentScene = null
    }
    if (currentEngine) {
      currentEngine.dispose()
      currentEngine = null
    }
    
    // Remove UI elements
    const elementsToRemove = ['.game-ui-panel', '.center-ui', '.mobile-controls-container', '.offscreen-indicator', '.game-pause-btn']
    elementsToRemove.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => el.remove())
    })
    document.querySelectorAll('#app > div').forEach(el => {
      if (el.id !== 'main-menu' && el.id !== 'pause-menu') {
        el.remove()
      }
    })
  },
})
document.body.appendChild(pauseMenu)

// Create settings menu
const settingsMenu = createSettingsMenu(
  settingsManager,
  () => ensureSoundManager(),
  () => {
    settingsMenu.style.display = 'none'
    mainMenu.style.display = 'flex'
    // The same setting is exposed on both screens — resync the menu toggle.
    ;(mainMenu as any).refreshExtendedPowerUps?.()
  }
)
document.body.appendChild(settingsMenu)

// Create stats screen
const statsScreen = createStatsScreen(() => {
  statsScreen.style.display = 'none'
  mainMenu.style.display = 'flex'
})
document.body.appendChild(statsScreen)

// Create main menu
const mainMenu = createMainMenu({
  onStartGame: (mode) => {
    startGame(mode)
  },
  onPlayOnline: () => {
    mainMenu.style.display = 'none'
    lobbyScreen.style.display = 'flex'
  },
  getExtendedPowerUps: () => settingsManager.getSettings().extendedPowerUps,
  onToggleExtendedPowerUps: (enabled) => settingsManager.setExtendedPowerUps(enabled),
  getPlayerName: () => sanitizePlayerName(settingsManager.getSettings().playerName),
  onApplyPlayerName: (name) => {
    settingsManager.setPlayerName(name)
    return settingsManager.getSettings().playerName
  },
})
document.body.appendChild(mainMenu)

// Create achievements screen
const achievementsScreen = createAchievementsScreen(
  achievementsManager,
  () => {
    achievementsScreen.style.display = 'none'
    mainMenu.style.display = 'flex'
  }
)
document.body.appendChild(achievementsScreen)

// Create tutorial screen
const tutorialScreen = createTutorialScreen(() => {
  tutorialScreen.style.display = 'none'
  mainMenu.style.display = 'flex'
})
document.body.appendChild(tutorialScreen)

// Create map selection screen
const mapSelectionScreen = createMapSelectionScreen(
  (mapKey: string) => {
    currentMapConfig = getMapConfig(mapKey)
    mapSelectionScreen.style.display = 'none'
    mainMenu.style.display = 'flex'
  },
  () => {
    mapSelectionScreen.style.display = 'none'
    mainMenu.style.display = 'flex'
  }
)
document.body.appendChild(mapSelectionScreen)

// ── Online lobby ────────────────────────────────────────────────────────────
// The server owns lobby state; this screen only renders what it sends back.
const netClient = new NetClient()

const lobbyScreen = createLobbyScreen({
  net: netClient,
  getPlayerName: () => sanitizePlayerName(settingsManager.getSettings().playerName),
  onBack: () => {
    lobbyScreen.style.display = 'none'
    mainMenu.style.display = 'flex'
  },
  onMatchStart: info => {
    const lobby = netClient.lobby
    if (!lobby || !netClient.youId) return

    lobbyScreen.style.display = 'none'
    startGame('pvp', {
      net: netClient,
      seed: info.seed,
      round: info.round,
      youId: netClient.youId,
      isHost: info.youAreHost,
      lives: lobby.config.lives,
      roster: lobby.players
        .filter(p => p.connected)
        .map(p => ({ id: p.id, name: p.name, slot: p.slot })),
    })
  },
  // The arena has no idea the round ended — the server decides that. Tear the
  // scene down, show the result, and hand control back to the lobby so the
  // next round can be readied up.
  onRoundOver: info => {
    teardownOnlineMatch()
    showOnlineRoundResult(info)
  },
})

/** Dispose the running online arena and its DOM furniture. */
function teardownOnlineMatch(): void {
  if (currentScene) {
    currentScene.dispose()
    currentScene = null
  }
  if (currentEngine) {
    currentEngine.dispose()
    currentEngine = null
  }
  if (soundManager) soundManager.stopMusic()
  document
    .querySelectorAll(
      '.game-ui-panel, .center-ui, .mobile-controls-container, .offscreen-indicator, .game-pause-btn, #indicator-container, #game-over-overlay',
    )
    .forEach(el => el.remove())
  isPaused = false
}

/** Between-rounds banner, then back to the lobby. */
function showOnlineRoundResult(info: {
  winnerName: string | null
  matchWinnerName: string | null
  youWon: boolean
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'winner-overlay'
  overlay.id = 'online-round-result'

  const heading = document.createElement('div')
  heading.className = `winner-text ${info.youWon ? 'victory' : 'defeat'}`
  heading.style.fontSize = '34px'
  heading.style.textAlign = 'center'

  if (info.matchWinnerName) {
    heading.textContent = info.youWon ? '🏆 YOU WIN THE MATCH!' : `🏆 ${info.matchWinnerName} WINS!`
  } else if (info.winnerName) {
    heading.textContent = info.youWon ? '✔️ ROUND WON!' : `${info.winnerName} takes the round`
  } else {
    heading.textContent = '🤝 DRAW'
  }
  overlay.appendChild(heading)

  const hint = document.createElement('div')
  hint.style.fontFamily = "'Russo One', sans-serif"
  hint.style.fontSize = '15px'
  hint.style.color = '#9ca3af'
  hint.style.marginTop = '18px'
  hint.textContent = info.matchWinnerName
    ? 'Back to the lobby — ready up to play again'
    : 'Back to the lobby — ready up for the next round'
  overlay.appendChild(hint)

  const button = document.createElement('button')
  button.className = 'menu-button'
  button.textContent = 'CONTINUE'
  button.style.marginTop = '26px'
  button.addEventListener('click', () => {
    overlay.remove()
    lobbyScreen.style.display = 'flex'
  })
  overlay.appendChild(button)

  document.body.appendChild(overlay)

  if (soundManager) soundManager.playSFX(info.youWon ? 'victory' : 'defeat')
}
document.body.appendChild(lobbyScreen)

// Add global menu sound effects
// This plays sounds for any menu button interactions
document.addEventListener('mouseenter', (e) => {
  const target = e.target as HTMLElement
  if (target.tagName === 'BUTTON' && (target.closest('.menu-container') || target.closest('#main-menu'))) {
    soundManager?.playSFX('menu-select')
  }
}, true)

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  if (target.tagName === 'BUTTON' && (target.closest('.menu-container') || target.closest('#main-menu'))) {
    // A click is a user gesture, which is the only moment an AudioContext can
    // be unlocked — so the menus get their own sound rather than staying mute
    // until the first match has been played.
    const manager = ensureSoundManager()
    manager.resumeAudio()
    manager.playSFX('menu-click')
  }
}, true)

// Add event listeners for menu buttons via event delegation (no setTimeout race condition)
mainMenu.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const button = target.closest('button')
  if (!button) return
  
  switch (button.id) {
    case 'settings-button':
      ;(settingsMenu as any).refresh?.()
      mainMenu.style.display = 'none'
      settingsMenu.style.display = 'flex'
      break
    case 'stats-button':
      mainMenu.style.display = 'none'
      statsScreen.style.display = 'flex'
      break
    case 'achievements-button':
      if ((achievementsScreen as any).refresh) {
        ;(achievementsScreen as any).refresh()
      }
      mainMenu.style.display = 'none'
      achievementsScreen.style.display = 'flex'
      break
    case 'tutorial-button':
      mainMenu.style.display = 'none'
      tutorialScreen.style.display = 'flex'
      break
    case 'map-selection-button':
      mainMenu.style.display = 'none'
      mapSelectionScreen.style.display = 'flex'
      break
    case 'online-button':
      mainMenu.style.display = 'none'
      lobbyScreen.style.display = 'flex'
      break
    case 'fullscreen-button':
      toggleFullscreen()
      break
  }
})
