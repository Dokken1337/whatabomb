import type { MapTheme } from './maps'
import type { Grid, TileType } from './grid'

export interface SpawnPoint {
  x: number
  y: number
}

export interface GeneratedMap {
  grid: Grid
  playerSpawn: SpawnPoint
  /** Ordered so that the first entry is the furthest from the player spawn. */
  enemySpawns: SpawnPoint[]
}

const DIRECTIONS: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]]

/** A pillar sits on every even/even tile — these are the fixed indestructible posts. */
function isPillar(x: number, y: number): boolean {
  return x % 2 === 0 && y % 2 === 0
}

function isBorder(x: number, y: number, width: number, height: number): boolean {
  return x === 0 || y === 0 || x === width - 1 || y === height - 1
}

/**
 * Rotate a coordinate 90° around the centre of a square grid.
 * Parity is preserved for odd-sized grids, so pillars always map onto pillars.
 */
function rotate(x: number, y: number, size: number): [number, number] {
  return [y, size - 1 - x]
}

/**
 * Force 4-fold rotational symmetry. Every cell takes the value of its
 * "canonical" representative (the lexicographically smallest of its four
 * rotations), which turns a random scatter into a layout where all four
 * corners get an identical opening — no more spawning next to a sealed pocket
 * while the AI starts in open ground.
 */
function symmetrize(grid: Grid, size: number) {
  const canonical = new Map<string, TileType>()

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bx = x, by = y
      let cx = x, cy = y
      for (let r = 0; r < 3; r++) {
        ;[bx, by] = rotate(bx, by, size)
        if (by < cy || (by === cy && bx < cx)) {
          cx = bx
          cy = by
        }
      }
      const key = `${cx},${cy}`
      if (!canonical.has(key)) canonical.set(key, grid[cy][cx])
      grid[y][x] = canonical.get(key)!
    }
  }
}

/** Clear the spawn tile plus an L-shaped corridor pointing into the arena. */
function carveSpawnZone(grid: Grid, sx: number, sy: number, width: number, height: number) {
  const dirX = sx < width / 2 ? 1 : -1
  const dirY = sy < height / 2 ? 1 : -1

  const tiles: Array<[number, number]> = [
    [sx, sy],
    [sx + dirX, sy],
    [sx + dirX * 2, sy],
    [sx, sy + dirY],
    [sx, sy + dirY * 2],
  ]

  for (const [x, y] of tiles) {
    if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) continue
    if (isPillar(x, y)) continue // never punch holes through the structural posts
    grid[y][x] = 'empty'
  }
}

/** Flood fill over every tile that is not an indestructible wall. */
function reachableFrom(grid: Grid, width: number, height: number, sx: number, sy: number): boolean[][] {
  const seen: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false))
  if (grid[sy][sx] === 'wall') return seen

  const queue: Array<[number, number]> = [[sx, sy]]
  seen[sy][sx] = true
  let head = 0

  while (head < queue.length) {
    const [x, y] = queue[head++]
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      if (seen[ny][nx]) continue
      if (grid[ny][nx] === 'wall') continue
      seen[ny][nx] = true
      queue.push([nx, ny])
    }
  }

  return seen
}

/**
 * Guarantee the whole arena is one connected region.
 *
 * Themes that add extra walls (lava channels, space room dividers) can seal off
 * pockets that neither the player nor the AI can ever reach, which strands
 * power-ups and leaves the AI pacing a dead end. Any pocket found here is
 * joined to the main region by opening the single wall between them.
 */
function ensureConnectivity(grid: Grid, width: number, height: number, seed: SpawnPoint) {
  for (let pass = 0; pass < 8; pass++) {
    const seen = reachableFrom(grid, width, height, seed.x, seed.y)

    // Find a wall that separates a reached tile from an unreached one.
    let carved = false
    for (let y = 1; y < height - 1 && !carved; y++) {
      for (let x = 1; x < width - 1 && !carved; x++) {
        if (grid[y][x] !== 'wall') continue
        if (isBorder(x, y, width, height)) continue

        let touchesReached = false
        let touchesUnreached = false
        for (const [dx, dy] of DIRECTIONS) {
          const nx = x + dx
          const ny = y + dy
          if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1) continue
          if (grid[ny][nx] === 'wall') continue
          if (seen[ny][nx]) touchesReached = true
          else touchesUnreached = true
        }

        if (touchesReached && touchesUnreached) {
          // Keep structural pillars looking like obstacles by turning them into
          // a destructible block rather than plain floor.
          grid[y][x] = isPillar(x, y) ? 'destructible' : 'empty'
          carved = true
        }
      }
    }

    if (!carved) {
      // Nothing left to join, or the remaining pockets are fully walled in —
      // fill those so no power-up can ever spawn somewhere unreachable.
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          if (!seen[y][x] && grid[y][x] === 'destructible') grid[y][x] = 'wall'
        }
      }
      return
    }
  }
}

/** Count destructibles so a map always has enough crates to farm power-ups from. */
function countDestructibles(grid: Grid, width: number, height: number): number {
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (grid[y][x] === 'destructible') n++
    }
  }
  return n
}

function generateBase(width: number, height: number, theme: MapTheme): Grid {
  const grid: Grid = []

  for (let y = 0; y < height; y++) {
    const row: TileType[] = []

    for (let x = 0; x < width; x++) {
      if (isBorder(x, y, width, height)) {
        row.push('wall')
      } else if (isPillar(x, y)) {
        // Theme-specific pillar variations
        if (theme === 'ice') {
          // Ice: remove some inner pillars to create open frozen lakes
          const cx = width / 2, cy = height / 2
          const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
          row.push(dist < Math.min(width, height) * 0.25 ? 'empty' : 'wall')
        } else if (theme === 'lava') {
          // Lava: keep all pillars (tight dangerous corridors)
          row.push('wall')
        } else if (theme === 'space' || theme === 'moon') {
          // Space/Moon: remove alternate pillars for more open feel
          row.push((x + y) % 4 === 0 ? 'wall' : 'empty')
        } else {
          row.push('wall')
        }
      } else {
        // Theme-specific destructible density & extra walls
        if (theme === 'lava') {
          // Lava: "lava channels" - extra walls forming corridors
          const isChannel = (y % 4 === 1 && x > 3 && x < width - 4 && x % 6 === 0) ||
                            (x % 4 === 1 && y > 3 && y < height - 4 && y % 6 === 0)
          if (isChannel) {
            row.push('wall')
          } else {
            row.push(Math.random() < 0.7 ? 'destructible' : 'empty')
          }
        } else if (theme === 'ice') {
          // Ice: less clutter, more open space
          row.push(Math.random() < 0.58 ? 'destructible' : 'empty')
        } else if (theme === 'forest') {
          // Forest: organic clusters - denser beside pillars, clearings elsewhere
          const nearPillar = isPillar(x - 1, y) || isPillar(x + 1, y) ||
                             isPillar(x, y - 1) || isPillar(x, y + 1)
          row.push(Math.random() < (nearPillar ? 0.85 : 0.6) ? 'destructible' : 'empty')
        } else if (theme === 'space' || theme === 'moon') {
          // Space: open "rooms" joined by denser corridors
          const inRoom = (x % 5 >= 1 && x % 5 <= 3 && y % 5 >= 1 && y % 5 <= 3)
          row.push(Math.random() < (inRoom ? 0.35 : 0.8) ? 'destructible' : 'empty')
        } else {
          // Classic: standard Bomberman density
          row.push(Math.random() < 0.74 ? 'destructible' : 'empty')
        }
      }
    }
    grid.push(row)
  }

  // --- Theme-specific structural features ---
  if (theme === 'forest') {
    // Small "clearing" circles that open up sight lines
    const clearings = 2 + Math.floor(Math.random() * 2)
    for (let c = 0; c < clearings; c++) {
      const cx = 3 + Math.floor(Math.random() * (width - 6))
      const cy = 3 + Math.floor(Math.random() * (height - 6))
      const r = 1.5 + Math.random()
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx > 0 && ny > 0 && nx < width - 1 && ny < height - 1) {
            if (Math.sqrt(dx * dx + dy * dy) <= r && grid[ny][nx] === 'destructible') {
              grid[ny][nx] = 'empty'
            }
          }
        }
      }
    }
  }

  if (theme === 'moon') {
    // "Crater" rings - circular walls of rubble with a clear middle
    const craters = 1 + Math.floor(Math.random() * 2)
    for (let c = 0; c < craters; c++) {
      const cx = 4 + Math.floor(Math.random() * (width - 8))
      const cy = 4 + Math.floor(Math.random() * (height - 8))
      const r = 2.5
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx > 0 && ny > 0 && nx < width - 1 && ny < height - 1) {
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist >= r - 0.5 && dist <= r + 0.5 && !isPillar(nx, ny)) {
              grid[ny][nx] = 'destructible'
            } else if (dist < r - 0.5 && !isPillar(nx, ny)) {
              grid[ny][nx] = 'empty'
            }
          }
        }
      }
    }
  }

  return grid
}

/**
 * Build a playable arena.
 *
 * `paddingBottom` appends empty rows below the arena; they are never part of
 * the playable area and exist only so the renderer has floor to draw under the
 * on-screen controls.
 */
export function generateMap(
  width: number,
  height: number,
  theme: MapTheme,
  paddingBottom: number = 0,
): GeneratedMap {
  const grid = generateBase(width, height, theme)

  // Fair, designed-looking layouts: every corner gets the same opening.
  if (width === height) symmetrize(grid, width)

  // An odd coordinate near the middle — never lands on a structural pillar.
  const midOdd = 2 * Math.floor(width / 4) + 1

  const playerSpawn: SpawnPoint = { x: 1, y: 1 }
  const enemySpawns: SpawnPoint[] = [
    { x: width - 2, y: height - 2 },  // opposite corner
    { x: 1, y: height - 2 },
    { x: width - 2, y: 1 },
    { x: midOdd, y: height - 2 },     // edge midpoint for the 4th survival enemy
  ]

  for (const s of [playerSpawn, ...enemySpawns]) {
    carveSpawnZone(grid, s.x, s.y, width, height)
  }

  ensureConnectivity(grid, width, height, playerSpawn)

  // A map with almost no crates starves both sides of power-ups. Top up the
  // interior if a theme's randomness (or the connectivity pass) went too far.
  const playable = (width - 2) * (height - 2)
  const minCrates = Math.floor(playable * 0.22)
  if (countDestructibles(grid, width, height) < minCrates) {
    const spawnSafe = new Set<string>()
    for (const s of [playerSpawn, ...enemySpawns]) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) spawnSafe.add(`${s.x + dx},${s.y + dy}`)
      }
    }
    let need = minCrates - countDestructibles(grid, width, height)
    for (let y = 1; y < height - 1 && need > 0; y++) {
      for (let x = 1; x < width - 1 && need > 0; x++) {
        if (grid[y][x] !== 'empty') continue
        if (isPillar(x, y) || spawnSafe.has(`${x},${y}`)) continue
        grid[y][x] = 'destructible'
        need--
      }
    }
  }

  // Cosmetic padding rows (mobile control area) — outside the playable grid.
  for (let y = 0; y < paddingBottom; y++) {
    grid.push(new Array<TileType>(width).fill('empty'))
  }

  return { grid, playerSpawn, enemySpawns }
}
