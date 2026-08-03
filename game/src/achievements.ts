export interface Achievement {
  id: string
  name: string
  description: string
  icon: string
  unlocked: boolean
  progress?: number
  maxProgress?: number
}

export class AchievementsManager {
  private achievements: Map<string, Achievement>
  private storageKey = 'whatabomb-achievements'

  constructor() {
    this.achievements = new Map()
    this.initializeAchievements()
    this.loadAchievements()
  }

  private initializeAchievements() {
    const achievementList: Achievement[] = [
      {
        id: 'first-blood',
        name: 'First Blood',
        description: 'Defeat your first enemy',
        icon: '🎯',
        unlocked: false,
      },
      {
        id: 'survivor-5',
        name: 'Survivor',
        description: 'Reach wave 5 in survival mode',
        icon: '🌊',
        unlocked: false,
      },
      {
        id: 'survivor-10',
        name: 'Wave Master',
        description: 'Reach wave 10 in survival mode',
        icon: '🌊🌊',
        unlocked: false,
      },
      {
        id: 'speed-demon',
        name: 'Speed Demon',
        description: 'Win time attack with 2+ minutes remaining',
        icon: '⚡',
        unlocked: false,
      },
      {
        id: 'untouchable',
        name: 'Untouchable',
        description: 'Win a game without taking damage',
        icon: '🛡️',
        unlocked: false,
      },
      {
        id: 'bomber',
        name: 'Bomber',
        description: 'Place 100 bombs total',
        icon: '💣',
        unlocked: false,
        progress: 0,
        maxProgress: 100,
      },
      {
        id: 'collector',
        name: 'Collector',
        description: 'Collect all 5 power-up types in one game',
        icon: '🎁',
        unlocked: false,
      },
      {
        id: 'triple-threat',
        name: 'Triple Threat',
        description: 'Defeat 3 enemies in one game',
        icon: '👾',
        unlocked: false,
      },
      {
        id: 'chain-reaction',
        name: 'Chain Reaction',
        description: 'Trigger a chain of 3+ bomb explosions',
        icon: '💥',
        unlocked: false,
      },
      {
        id: 'demolition',
        name: 'Demolition Expert',
        description: 'Destroy 50 blocks in one game',
        icon: '🧱',
        unlocked: false,
      },
      {
        id: 'win-streak-3',
        name: 'On Fire',
        description: 'Win 3 games in a row',
        icon: '🔥',
        unlocked: false,
      },
      {
        id: 'power-hungry',
        name: 'Power Hungry',
        description: 'Collect 10 power-ups in one game',
        icon: '⭐',
        unlocked: false,
      },
    ]

    achievementList.forEach(achievement => {
      this.achievements.set(achievement.id, achievement)
    })
  }

  private loadAchievements() {
    const saved = localStorage.getItem(this.storageKey)
    if (saved) {
      try {
        const data = JSON.parse(saved)
        Object.entries(data).forEach(([id, achievement]: [string, any]) => {
          if (this.achievements.has(id)) {
            this.achievements.set(id, { ...this.achievements.get(id)!, ...achievement })
          }
        })
      } catch (e) {
        console.error('Failed to load achievements:', e)
      }
    }
  }

  private saveAchievements() {
    const data: any = {}
    this.achievements.forEach((achievement, id) => {
      data[id] = achievement
    })
    localStorage.setItem(this.storageKey, JSON.stringify(data))
  }

  unlock(id: string): boolean {
    const achievement = this.achievements.get(id)
    if (achievement && !achievement.unlocked) {
      achievement.unlocked = true
      this.saveAchievements()
      return true // Newly unlocked
    }
    return false // Already unlocked or doesn't exist
  }

  updateProgress(id: string, progress: number): boolean {
    const achievement = this.achievements.get(id)
    if (achievement && !achievement.unlocked && achievement.maxProgress) {
      achievement.progress = progress
      if (progress >= achievement.maxProgress) {
        achievement.unlocked = true
        this.saveAchievements()
        return true // Newly unlocked
      }
      this.saveAchievements()
    }
    return false
  }

  incrementProgress(id: string): boolean {
    const achievement = this.achievements.get(id)
    if (achievement && !achievement.unlocked && achievement.maxProgress) {
      achievement.progress = (achievement.progress || 0) + 1
      if (achievement.progress >= achievement.maxProgress) {
        achievement.unlocked = true
        this.saveAchievements()
        return true // Newly unlocked
      }
      this.saveAchievements()
    }
    return false
  }

  getAchievement(id: string): Achievement | undefined {
    return this.achievements.get(id)
  }

  getAllAchievements(): Achievement[] {
    return Array.from(this.achievements.values())
  }

  getUnlockedCount(): number {
    return Array.from(this.achievements.values()).filter(a => a.unlocked).length
  }

  getTotalCount(): number {
    return this.achievements.size
  }

  resetAchievements() {
    this.achievements.forEach(achievement => {
      achievement.unlocked = false
      if (achievement.progress !== undefined) {
        achievement.progress = 0
      }
    })
    this.saveAchievements()
  }
}
