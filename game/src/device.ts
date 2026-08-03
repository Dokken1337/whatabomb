export function isMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 800;
}

/** Detect if running on iOS (Safari only supports fullscreen for video/audio) */
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)
}

/** Resolve the on-screen-controls setting against the current device. */
export function showOnScreenControls(mode: 'auto' | 'on' | 'off'): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return isMobile()
}

let hapticsEnabled = true

/** Enable or disable haptic feedback globally. */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled
}

/** Trigger haptic feedback if supported and enabled (Android only — iOS has no Vibration API).
 * Pattern: number for single vibration, or [vibrate, pause, vibrate, ...] in ms.
 * Note: Very short durations (<20ms) may not be felt on some devices. */
export function haptic(pattern: number | number[] = 30): void {
  if (!hapticsEnabled) return
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(pattern)
    }
  } catch {
    // Silently ignore - haptics not available
  }
}
