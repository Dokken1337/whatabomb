export interface GameStats {
  gamesPlayed: number
  wins: number
  losses: number
  enemiesDefeated: number
  blocksDestroyed: number
  powerUpsCollected: number
  bombsPlaced: number
  deaths: number
  longestWinStreak: number
  currentWinStreak: number
  highestBlastRadius: number
  mostBombsInGame: number
  survivalHighScore: number
  survivalHighWave: number
}

export class StatisticsManager {
  private stats: GameStats
  private storageKey = 'whatabomb-stats'
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.stats = this.loadStats()
  }

  private getDefaultStats(): GameStats {
    return {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      enemiesDefeated: 0,
      blocksDestroyed: 0,
      powerUpsCollected: 0,
      bombsPlaced: 0,
      deaths: 0,
      longestWinStreak: 0,
      currentWinStreak: 0,
      highestBlastRadius: 0,
      mostBombsInGame: 0,
      survivalHighScore: 0,
      survivalHighWave: 0,
    }
  }

  private loadStats(): GameStats {
    const saved = localStorage.getItem(this.storageKey)
    if (saved) {
      try {
        return { ...this.getDefaultStats(), ...JSON.parse(saved) }
      } catch (e) {
        console.error('Failed to load stats:', e)
      }
    }
    
    return this.getDefaultStats()
  }

  private saveStats() {
    // Debounce saves to avoid writing to localStorage on every single action
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      localStorage.setItem(this.storageKey, JSON.stringify(this.stats))
      this.saveTimer = null
    }, 500)
  }

  // Force immediate save (e.g. on game over)
  private saveStatsNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    localStorage.setItem(this.storageKey, JSON.stringify(this.stats))
  }

  // Record game result (immediate save since game is ending)
  recordWin() {
    this.stats.gamesPlayed++
    this.stats.wins++
    this.stats.currentWinStreak++
    if (this.stats.currentWinStreak > this.stats.longestWinStreak) {
      this.stats.longestWinStreak = this.stats.currentWinStreak
    }
    this.saveStatsNow()
  }

  recordLoss() {
    this.stats.gamesPlayed++
    this.stats.losses++
    this.stats.currentWinStreak = 0
    this.saveStatsNow()
  }

  // Record actions
  recordEnemyDefeated() {
    this.stats.enemiesDefeated++
    this.saveStats()
  }

  recordBlockDestroyed() {
    this.stats.blocksDestroyed++
    this.saveStats()
  }

  recordPowerUpCollected() {
    this.stats.powerUpsCollected++
    this.saveStats()
  }

  recordBombPlaced() {
    this.stats.bombsPlaced++
    this.saveStats()
  }

  recordDeath() {
    this.stats.deaths++
    this.saveStats()
  }

  recordBlastRadius(radius: number) {
    if (radius > this.stats.highestBlastRadius) {
      this.stats.highestBlastRadius = radius
      this.saveStats()
    }
  }

  recordBombCount(count: number) {
    if (count > this.stats.mostBombsInGame) {
      this.stats.mostBombsInGame = count
      this.saveStats()
    }
  }

  recordSurvivalScore(wave: number, score: number) {
    if (score > this.stats.survivalHighScore) {
      this.stats.survivalHighScore = score
    }
    if (wave > this.stats.survivalHighWave) {
      this.stats.survivalHighWave = wave
    }
    this.saveStatsNow()
  }

  getStats(): GameStats {
    return { ...this.stats }
  }

  getWinRate(): number {
    if (this.stats.gamesPlayed === 0) return 0
    return (this.stats.wins / this.stats.gamesPlayed) * 100
  }

  resetStats() {
    this.stats = {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      enemiesDefeated: 0,
      blocksDestroyed: 0,
      powerUpsCollected: 0,
      bombsPlaced: 0,
      deaths: 0,
      longestWinStreak: 0,
      currentWinStreak: 0,
      highestBlastRadius: 0,
      mostBombsInGame: 0,
      survivalHighScore: 0,
      survivalHighWave: 0,
    }
    this.saveStatsNow()
  }
}
