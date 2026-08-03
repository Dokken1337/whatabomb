import { Scene, ParticleSystem, Texture, Color4, Vector3 } from '@babylonjs/core'

import { FLARE_TEXTURE_DATA_URI } from './assets'

let particlesEnabled = true

/** Mirrors the "Particle Effects" setting so effects can be skipped entirely. */
export function setParticlesEnabled(enabled: boolean): void {
  particlesEnabled = enabled
}

export function areParticlesEnabled(): boolean {
  return particlesEnabled
}

// One flare texture per scene, reused by every hit indicator. Creating a
// Texture from the data URI on each hit meant a fresh GPU upload per explosion.
let flareTexture: Texture | null = null
let flareScene: Scene | null = null

function getFlareTexture(scene: Scene): Texture | null {
  if (flareTexture && flareScene === scene) return flareTexture
  try {
    flareTexture = new Texture(FLARE_TEXTURE_DATA_URI, scene)
    flareScene = scene
    scene.onDisposeObservable.addOnce(() => {
      flareTexture = null
      flareScene = null
    })
    return flareTexture
  } catch {
    return null
  }
}

export function showHitIndicator(position: Vector3, scene: Scene, isPlayer: boolean = true) {
  if (particlesEnabled) {
    // Create a red flash particle effect at hit location
    const particleSystem = new ParticleSystem('hit', 40, scene)

    const texture = getFlareTexture(scene)
    if (texture) particleSystem.particleTexture = texture

    particleSystem.emitter = position.clone()
    particleSystem.minEmitBox = new Vector3(-0.3, 0, -0.3)
    particleSystem.maxEmitBox = new Vector3(0.3, 0.5, 0.3)

    // Red/orange colors for damage
    particleSystem.color1 = new Color4(1, 0, 0, 1)
    particleSystem.color2 = new Color4(1, 0.3, 0, 1)
    particleSystem.colorDead = new Color4(0.5, 0, 0, 0)

    particleSystem.minSize = 0.1
    particleSystem.maxSize = 0.3

    particleSystem.minLifeTime = 0.3
    particleSystem.maxLifeTime = 0.6

    particleSystem.emitRate = 100
    particleSystem.blendMode = ParticleSystem.BLENDMODE_ONEONE

    particleSystem.gravity = new Vector3(0, -2, 0)

    particleSystem.direction1 = new Vector3(-1, 2, -1)
    particleSystem.direction2 = new Vector3(1, 3, 1)

    particleSystem.minEmitPower = 2
    particleSystem.maxEmitPower = 4
    particleSystem.updateSpeed = 0.01

    particleSystem.start()

    setTimeout(() => {
      if (scene.isDisposed) return
      particleSystem.stop()
      setTimeout(() => {
        if (scene.isDisposed) return
        // Null the shared texture first so disposing the system cannot take it down.
        particleSystem.particleTexture = null
        particleSystem.dispose()
      }, 600)
    }, 300)
  }

  // Show damage text (CSS animated so it costs nothing per frame)
  const damageText = document.createElement('div')
  damageText.textContent = isPlayer ? '-1 LIFE!' : 'HIT!'
  damageText.className = 'damage-popup'
  damageText.style.color = isPlayer ? '#ff0000' : '#ffaa00'
  document.body.appendChild(damageText)
  setTimeout(() => damageText.remove(), 900)
}
