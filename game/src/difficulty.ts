export interface DifficultyConfig {
  /** Milliseconds between AI decision ticks. Lower = the AI acts more often. */
  aiMoveSpeed: number
  /** Floor for aiMoveSpeed once an AI has collected speed power-ups. */
  aiMinMoveSpeed: number
  /** Multiplier applied to every opportunistic bomb-placement roll (0-1+). */
  aiBombChance: number
  /** How many BFS steps the AI is willing to walk to reach cover. */
  aiEscapeDepth: number
  /** Score bonus for a step that closes distance on the target. */
  aiChaseWeight: number
  /** Probability the AI follows its BFS path instead of taking a greedy step. */
  aiPathfindChance: number
  /** Bomb capacity an AI starts the round with. */
  aiStartingBombs: number
  /** Blast radius an AI starts the round with. */
  aiStartingBlast: number
  /** Ceiling on bomb capacity gained from power-ups. */
  aiMaxBombs: number
  /** Ceiling on blast radius gained from power-ups. */
  aiMaxBlast: number
  /** Probability (0-1) the AI drops a bomb to tunnel through a block that blocks its path. */
  aiTunnelChance: number
  powerUpDropRate: number
  enemyStartingLives: number
  playerStartingLives: number
}

export const DIFFICULTY_CONFIGS: Record<'easy' | 'medium' | 'hard', DifficultyConfig> = {
  // Player movement is one tile per 150ms at base speed. The AI intervals below
  // are deliberately slower than that — an AI that keeps pace with the player
  // leaves no room to outmanoeuvre it, which is the whole game.
  easy: {
    aiMoveSpeed: 620,
    aiMinMoveSpeed: 470,
    aiBombChance: 0.25,
    aiEscapeDepth: 4,
    aiChaseWeight: 20,
    aiPathfindChance: 0.15,
    aiStartingBombs: 1,
    aiStartingBlast: 1,
    aiMaxBombs: 2,
    aiMaxBlast: 3,
    aiTunnelChance: 0.1,
    powerUpDropRate: 0.55,
    enemyStartingLives: 3,
    playerStartingLives: 3,
  },
  medium: {
    aiMoveSpeed: 440,
    aiMinMoveSpeed: 330,
    aiBombChance: 0.55,
    aiEscapeDepth: 7,
    aiChaseWeight: 55,
    aiPathfindChance: 0.6,
    aiStartingBombs: 1,
    aiStartingBlast: 2,
    aiMaxBombs: 3,
    aiMaxBlast: 4,
    aiTunnelChance: 0.3,
    powerUpDropRate: 0.42,
    enemyStartingLives: 3,
    playerStartingLives: 3,
  },
  hard: {
    aiMoveSpeed: 300,
    aiMinMoveSpeed: 210,
    aiBombChance: 1.0,
    aiEscapeDepth: 10,
    aiChaseWeight: 110,
    aiPathfindChance: 0.95,
    aiStartingBombs: 2,
    aiStartingBlast: 2,
    aiMaxBombs: 4,
    aiMaxBlast: 5,
    aiTunnelChance: 0.7,
    powerUpDropRate: 0.33,
    enemyStartingLives: 4,
    playerStartingLives: 3,
  },
}

export function getDifficultyConfig(difficulty: 'easy' | 'medium' | 'hard'): DifficultyConfig {
  return DIFFICULTY_CONFIGS[difficulty]
}

/**
 * Extra pressure applied to enemies spawned in later Survival waves.
 * Wave 1 returns the plain difficulty values; every wave after that the AI
 * gets a little faster, tougher and more explosive.
 */
export function getWaveScaling(base: DifficultyConfig, wave: number) {
  const step = Math.max(0, wave - 1)
  return {
    moveSpeed: Math.max(base.aiMinMoveSpeed, Math.round(base.aiMoveSpeed - step * 15)),
    lives: base.enemyStartingLives + Math.floor(step / 3),
    blastRadius: Math.min(base.aiMaxBlast, base.aiStartingBlast + Math.floor(step / 2)),
    maxBombs: Math.min(base.aiMaxBombs, base.aiStartingBombs + Math.floor(step / 4)),
  }
}
