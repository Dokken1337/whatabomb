import type { Grid } from './grid'
import type { DifficultyConfig } from './difficulty'

export interface BombPlacementDecision {
  shouldPlace: boolean
  reason: string
  escapeDirection?: { dx: number, dy: number }
}

export interface AIBomb {
  x: number
  y: number
  blastRadius: number
}

export interface AIBombContext {
  enemyX: number
  enemyY: number
  targetX: number
  targetY: number
  grid: Grid
  gridWidth: number
  gridHeight: number
  bombs: AIBomb[]
  blastRadius: number
  /** Tiles occupied by other characters — the AI must not escape into them. */
  blocked: Array<{ x: number; y: number }>
  config: DifficultyConfig
  /** Actual tick interval for this AI, which may be faster than the base config. */
  moveIntervalMs: number
}

const DIRECTIONS = [
  { dx: 0, dy: -1 },  // up
  { dx: 0, dy: 1 },   // down
  { dx: -1, dy: 0 },  // left
  { dx: 1, dy: 0 },   // right
]

/** Bomb fuse length in ms — kept in sync with the timer used when placing bombs. */
const BOMB_FUSE_MS = 2000

/**
 * How far the AI can realistically walk before the fuse burns out, capped by
 * the difficulty's search depth. A slow (easy) AI knows it cannot sprint 10
 * tiles in 2 seconds, so it only commits to bombs it can actually run from.
 */
export function getEscapeDepth(config: DifficultyConfig, moveIntervalMs: number): number {
  const reachable = Math.floor(BOMB_FUSE_MS / Math.max(60, moveIntervalMs)) - 1
  return Math.max(2, Math.min(config.aiEscapeDepth, reachable))
}

/**
 * Check if a position is in the blast zone of a bomb
 */
function isInBlastZone(
  posX: number,
  posY: number,
  bombX: number,
  bombY: number,
  blastRadius: number,
  grid: Grid
): boolean {
  // On the bomb itself
  if (posX === bombX && posY === bombY) return true

  // Check horizontal
  if (posY === bombY) {
    const dist = Math.abs(posX - bombX)
    if (dist <= blastRadius) {
      // Check for blocking walls
      const step = posX > bombX ? 1 : -1
      for (let i = 1; i < dist; i++) {
        const checkX = bombX + step * i
        const tile = grid[bombY]?.[checkX]
        if (tile === 'wall' || tile === 'destructible') return false
      }
      return true
    }
  }

  // Check vertical
  if (posX === bombX) {
    const dist = Math.abs(posY - bombY)
    if (dist <= blastRadius) {
      // Check for blocking walls
      const step = posY > bombY ? 1 : -1
      for (let i = 1; i < dist; i++) {
        const checkY = bombY + step * i
        const tile = grid[checkY]?.[bombX]
        if (tile === 'wall' || tile === 'destructible') return false
      }
      return true
    }
  }

  return false
}

export { isInBlastZone }

/**
 * Check if a position is dangerous from any active bomb
 */
export function isPositionSafe(
  x: number,
  y: number,
  grid: Grid,
  bombs: AIBomb[],
  additionalBomb?: AIBomb
): boolean {
  // Check all existing bombs
  for (const bomb of bombs) {
    if (isInBlastZone(x, y, bomb.x, bomb.y, bomb.blastRadius, grid)) {
      return false
    }
  }

  // Check additional hypothetical bomb
  if (additionalBomb && isInBlastZone(x, y, additionalBomb.x, additionalBomb.y, additionalBomb.blastRadius, grid)) {
    return false
  }

  return true
}

/**
 * Check if a tile is walkable (empty and no bomb)
 */
function canWalkTo(
  x: number,
  y: number,
  grid: Grid,
  gridWidth: number,
  gridHeight: number,
  bombs: AIBomb[]
): boolean {
  if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return false
  if (grid[y][x] !== 'empty') return false
  if (bombs.some(b => b.x === x && b.y === y)) return false
  return true
}

/**
 * Find escape path using BFS - returns the FIRST STEP direction to take.
 * `blocked` tiles (other characters) are treated as impassable for the first
 * step only, since they will have moved on by the time the AI gets further.
 */
export function findEscapeDirection(
  startX: number,
  startY: number,
  grid: Grid,
  gridWidth: number,
  gridHeight: number,
  bombs: AIBomb[],
  newBomb?: AIBomb,
  maxDepth: number = 6,
  blocked?: Array<{ x: number; y: number }>
): { dx: number, dy: number } | null {
  const allBombs = newBomb ? [...bombs, newBomb] : bombs

  const visited = new Set<string>()
  visited.add(`${startX},${startY}`)

  // Queue entries: [x, y, firstStepDx, firstStepDy, depth]
  const queue: Array<[number, number, number, number, number]> = []
  let head = 0

  // Add all valid adjacent tiles as starting points
  for (const dir of DIRECTIONS) {
    const nx = startX + dir.dx
    const ny = startY + dir.dy

    if (!canWalkTo(nx, ny, grid, gridWidth, gridHeight, allBombs)) continue
    if (blocked && blocked.some(b => b.x === nx && b.y === ny)) continue

    visited.add(`${nx},${ny}`)
    queue.push([nx, ny, dir.dx, dir.dy, 1])
  }

  while (head < queue.length) {
    const [x, y, firstDx, firstDy, depth] = queue[head++]

    // Check if this tile is safe
    if (isPositionSafe(x, y, grid, allBombs)) {
      return { dx: firstDx, dy: firstDy }
    }

    if (depth >= maxDepth) continue

    // Explore neighbors
    for (const dir of DIRECTIONS) {
      const nx = x + dir.dx
      const ny = y + dir.dy
      const key = `${nx},${ny}`

      if (visited.has(key)) continue
      if (!canWalkTo(nx, ny, grid, gridWidth, gridHeight, allBombs)) continue

      visited.add(key)
      queue.push([nx, ny, firstDx, firstDy, depth + 1]) // Keep tracking the FIRST step
    }
  }

  return null // No safe escape found
}

export interface PathResult {
  /** First step to take along the path. */
  step: { dx: number, dy: number }
  /** Number of steps to the goal. */
  distance: number
  /** Set when the path is blocked by a destructible the AI should bomb. */
  blockedBy?: { x: number, y: number }
}

/**
 * BFS toward a target tile. Walks through empty tiles only, but if no clean
 * route exists it reports the first destructible standing in the way so the
 * caller can bomb a tunnel instead of milling around a wall.
 */
export function findPathToTarget(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  grid: Grid,
  gridWidth: number,
  gridHeight: number,
  bombs: AIBomb[],
  blocked: Array<{ x: number; y: number }> = [],
  maxNodes: number = 900
): PathResult | null {
  if (startX === targetX && startY === targetY) return null

  const visited = new Set<string>()
  visited.add(`${startX},${startY}`)

  // [x, y, firstDx, firstDy, depth]
  const queue: Array<[number, number, number, number, number]> = []
  let head = 0

  // Nearest destructible encountered along the search, used as a fallback goal.
  let softBlock: { step: { dx: number, dy: number }, distance: number, at: { x: number, y: number } } | null = null

  for (const dir of DIRECTIONS) {
    const nx = startX + dir.dx
    const ny = startY + dir.dy
    if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue
    const key = `${nx},${ny}`

    if (grid[ny][nx] === 'destructible') {
      if (!softBlock) softBlock = { step: dir, distance: 1, at: { x: nx, y: ny } }
      continue
    }
    if (!canWalkTo(nx, ny, grid, gridWidth, gridHeight, bombs)) continue
    if (blocked.some(b => b.x === nx && b.y === ny)) continue

    visited.add(key)
    queue.push([nx, ny, dir.dx, dir.dy, 1])
  }

  while (head < queue.length && head < maxNodes) {
    const [x, y, firstDx, firstDy, depth] = queue[head++]

    if (x === targetX && y === targetY) {
      return { step: { dx: firstDx, dy: firstDy }, distance: depth }
    }

    for (const dir of DIRECTIONS) {
      const nx = x + dir.dx
      const ny = y + dir.dy
      if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue
      const key = `${nx},${ny}`
      if (visited.has(key)) continue

      if (grid[ny][nx] === 'destructible') {
        visited.add(key)
        if (!softBlock || depth + 1 < softBlock.distance) {
          softBlock = { step: { dx: firstDx, dy: firstDy }, distance: depth + 1, at: { x: nx, y: ny } }
        }
        continue
      }
      if (!canWalkTo(nx, ny, grid, gridWidth, gridHeight, bombs)) continue

      visited.add(key)
      queue.push([nx, ny, firstDx, firstDy, depth + 1])
    }
  }

  if (softBlock) {
    return { step: softBlock.step, distance: softBlock.distance, blockedBy: softBlock.at }
  }
  return null
}

/**
 * MAIN AI DECISION: Should the AI place a bomb?
 * Returns decision with escape direction if bomb should be placed
 */
export function shouldAIPlaceBomb(context: AIBombContext): BombPlacementDecision {
  const {
    enemyX, enemyY, targetX, targetY, grid, gridWidth, gridHeight,
    bombs, blastRadius, blocked, config, moveIntervalMs,
  } = context

  // SAFETY CHECK 1: Never place if standing on a bomb
  if (bombs.some(b => b.x === enemyX && b.y === enemyY)) {
    return { shouldPlace: false, reason: 'Standing on bomb' }
  }

  // SAFETY CHECK 2: Never place if currently in danger
  if (!isPositionSafe(enemyX, enemyY, grid, bombs)) {
    return { shouldPlace: false, reason: 'Currently in danger' }
  }

  // SAFETY CHECK 3: Find escape route BEFORE deciding to place
  const hypotheticalBomb = { x: enemyX, y: enemyY, blastRadius }
  const depth = getEscapeDepth(config, moveIntervalMs)
  const escapeDir = findEscapeDirection(
    enemyX, enemyY, grid, gridWidth, gridHeight, bombs, hypotheticalBomb, depth, blocked,
  )

  if (!escapeDir) {
    return { shouldPlace: false, reason: 'No escape route' }
  }

  // Now we know escape is possible - check if we SHOULD place a bomb
  const distToTarget = Math.abs(enemyX - targetX) + Math.abs(enemyY - targetY)
  const targetInBlast = isInBlastZone(targetX, targetY, enemyX, enemyY, blastRadius, grid)

  // Check for nearby destructibles (to farm powerups / open up the map)
  let breaksCrate = false
  for (const dir of DIRECTIONS) {
    const checkX = enemyX + dir.dx
    const checkY = enemyY + dir.dy
    if (grid[checkY] && grid[checkY][checkX] === 'destructible') {
      breaksCrate = true
      break
    }
  }

  // `aiBombChance` scales every opportunistic roll, so difficulty controls how
  // trigger-happy the AI is without duplicating the decision tree per level.
  const c = config.aiBombChance
  let shouldPlace = false
  let reason = ''

  if (targetInBlast) {
    // A free hit is always worth taking, at every difficulty.
    shouldPlace = true
    reason = 'Target in blast range'
  } else if (distToTarget <= 2 && Math.random() < 0.55 * c) {
    shouldPlace = true
    reason = 'Cornering target'
  } else if (breaksCrate && Math.random() < 0.55 * c) {
    shouldPlace = true
    reason = 'Farming crates'
  } else if (distToTarget <= 4 && Math.random() < 0.3 * c) {
    shouldPlace = true
    reason = 'Pressuring target'
  } else if (Math.random() < 0.03 * c) {
    shouldPlace = true
    reason = 'Opportunistic'
  }

  if (shouldPlace) {
    return { shouldPlace: true, reason, escapeDirection: escapeDir }
  }

  return { shouldPlace: false, reason: 'Waiting' }
}

/** Convenience wrapper used when the AI just needs to run from live bombs. */
export function getEscapeDirection(
  x: number,
  y: number,
  grid: Grid,
  gridWidth: number,
  gridHeight: number,
  bombs: AIBomb[],
  maxDepth: number = 6,
  blocked?: Array<{ x: number; y: number }>
): { dx: number, dy: number } | null {
  return findEscapeDirection(x, y, grid, gridWidth, gridHeight, bombs, undefined, maxDepth, blocked)
}
