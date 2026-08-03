import { StatisticsManager } from './statistics'

export function createStatsScreen(onClose: () => void): HTMLDivElement {
  const statsDiv = document.createElement('div')
  statsDiv.id = 'stats-screen'
  statsDiv.style.position = 'absolute'
  statsDiv.style.top = '0'
  statsDiv.style.left = '0'
  statsDiv.style.width = '100vw'
  statsDiv.style.height = '100vh'
  statsDiv.style.background = 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)'
  statsDiv.style.display = 'none'
  statsDiv.style.flexDirection = 'column'
  statsDiv.style.justifyContent = 'center'
  statsDiv.style.alignItems = 'center'
  statsDiv.style.zIndex = '2500'
  statsDiv.style.color = 'white'
  statsDiv.style.overflow = 'auto'

  const statsManager = new StatisticsManager()
  const stats = statsManager.getStats()
  const winRate = statsManager.getWinRate().toFixed(1)

  const title = document.createElement('h1')
  title.textContent = '📊 STATISTICS'
  title.style.fontFamily = "'Press Start 2P', monospace"
  title.style.fontSize = '28px'
  title.style.marginBottom = '30px'
  title.style.background = 'linear-gradient(180deg, #fbbf24 0%, #f97316 100%)'
  title.style.webkitBackgroundClip = 'text'
  title.style.webkitTextFillColor = 'transparent'
  title.style.textShadow = 'none'
  title.style.filter = 'drop-shadow(0 4px 8px rgba(251, 191, 36, 0.4))'
  statsDiv.appendChild(title)

  const statsContainer = document.createElement('div')
  statsContainer.style.display = 'grid'
  statsContainer.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))'
  statsContainer.style.gap = '15px'
  statsContainer.style.maxWidth = '750px'
  statsContainer.style.width = '90%'
  statsContainer.style.marginBottom = '30px'
  statsContainer.style.padding = '20px'
  statsContainer.style.background = 'rgba(0, 0, 0, 0.3)'
  statsContainer.style.borderRadius = '15px'
  statsContainer.style.border = '2px solid rgba(255, 255, 255, 0.1)'

  const statItems = [
    { label: 'Games Played', value: stats.gamesPlayed, icon: '🎮', color: '#60a5fa' },
    { label: 'Wins', value: stats.wins, icon: '🏆', color: '#fbbf24' },
    { label: 'Losses', value: stats.losses, icon: '💀', color: '#f87171' },
    { label: 'Win Rate', value: `${winRate}%`, icon: '📈', color: '#4ade80' },
    { label: 'Enemies Defeated', value: stats.enemiesDefeated, icon: '⚔️', color: '#f472b6' },
    { label: 'Blocks Destroyed', value: stats.blocksDestroyed, icon: '🧱', color: '#a78bfa' },
    { label: 'Power-Ups', value: stats.powerUpsCollected, icon: '⭐', color: '#fcd34d' },
    { label: 'Bombs Placed', value: stats.bombsPlaced, icon: '💣', color: '#fb923c' },
    { label: 'Deaths', value: stats.deaths, icon: '☠️', color: '#94a3b8' },
    { label: 'Win Streak', value: stats.longestWinStreak, icon: '🔥', color: '#ef4444' },
    { label: 'Max Blast', value: stats.highestBlastRadius, icon: '💥', color: '#f97316' },
    { label: 'Max Bombs', value: stats.mostBombsInGame, icon: '🎯', color: '#22d3ee' },
    { label: 'Survival Wave', value: stats.survivalHighWave, icon: '🌊', color: '#38bdf8' },
    { label: 'Survival Score', value: stats.survivalHighScore, icon: '🏅', color: '#fbbf24' },
  ]

  statItems.forEach(item => {
    const statDiv = document.createElement('div')
    statDiv.style.padding = '15px 12px'
    statDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)'
    statDiv.style.borderRadius = '12px'
    statDiv.style.textAlign = 'center'
    statDiv.style.border = '1px solid rgba(255,255,255,0.1)'
    statDiv.style.transition = 'all 0.2s ease'
    statDiv.style.cursor = 'default'

    statDiv.addEventListener('mouseenter', () => {
      statDiv.style.transform = 'translateY(-3px) scale(1.02)'
      statDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)'
      statDiv.style.boxShadow = `0 8px 20px rgba(0,0,0,0.3), 0 0 20px ${item.color}33`
    })
    statDiv.addEventListener('mouseleave', () => {
      statDiv.style.transform = 'translateY(0) scale(1)'
      statDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)'
      statDiv.style.boxShadow = 'none'
    })

    const icon = document.createElement('div')
    icon.textContent = item.icon
    icon.style.fontSize = '24px'
    icon.style.marginBottom = '8px'

    const value = document.createElement('div')
    value.textContent = String(item.value)
    value.style.fontFamily = "'Press Start 2P', monospace"
    value.style.fontSize = '18px'
    value.style.fontWeight = 'bold'
    value.style.color = item.color
    value.style.textShadow = `0 0 10px ${item.color}66`
    value.style.marginBottom = '5px'

    const label = document.createElement('div')
    label.textContent = item.label
    label.style.fontFamily = "'Russo One', sans-serif"
    label.style.fontSize = '11px'
    label.style.color = '#9ca3af'
    label.style.textTransform = 'uppercase'
    label.style.letterSpacing = '0.5px'

    statDiv.appendChild(icon)
    statDiv.appendChild(value)
    statDiv.appendChild(label)
    statsContainer.appendChild(statDiv)
  })

  statsDiv.appendChild(statsContainer)

  // Reset Stats Button
  const resetButton = document.createElement('button')
  resetButton.textContent = '🗑️ RESET STATS'
  resetButton.style.fontFamily = "'Press Start 2P', monospace"
  resetButton.style.fontSize = '10px'
  resetButton.style.padding = '12px 25px'
  resetButton.style.marginBottom = '15px'
  resetButton.style.cursor = 'pointer'
  resetButton.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
  resetButton.style.color = '#9ca3af'
  resetButton.style.border = '2px solid #4b5563'
  resetButton.style.borderRadius = '8px'
  resetButton.style.transition = 'all 0.2s ease'
  
  resetButton.addEventListener('mouseenter', () => {
    resetButton.style.background = 'linear-gradient(180deg, #ef4444 0%, #b91c1c 100%)'
    resetButton.style.color = '#fff'
    resetButton.style.border = '2px solid #dc2626'
  })
  resetButton.addEventListener('mouseleave', () => {
    resetButton.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
    resetButton.style.color = '#9ca3af'
    resetButton.style.border = '2px solid #4b5563'
  })
  resetButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all statistics? This cannot be undone!')) {
      statsManager.resetStats()
      onClose()
    }
  })
  statsDiv.appendChild(resetButton)

  const closeButton = document.createElement('button')
  closeButton.textContent = '✓ CLOSE'
  closeButton.style.fontFamily = "'Press Start 2P', monospace"
  closeButton.style.fontSize = '14px'
  closeButton.style.padding = '15px 40px'
  closeButton.style.cursor = 'pointer'
  closeButton.style.background = 'linear-gradient(180deg, #4ade80 0%, #22c55e 50%, #16a34a 100%)'
  closeButton.style.color = '#000'
  closeButton.style.border = '3px solid #166534'
  closeButton.style.borderRadius = '8px'
  closeButton.style.fontWeight = 'bold'
  closeButton.style.textShadow = '1px 1px 0 rgba(255,255,255,0.3)'
  closeButton.style.boxShadow = '0 4px 0 #166534, 0 6px 10px rgba(0,0,0,0.4)'
  closeButton.style.transition = 'all 0.1s ease'
  closeButton.style.transform = 'translateY(0)'
  
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.background = 'linear-gradient(180deg, #86efac 0%, #4ade80 50%, #22c55e 100%)'
    closeButton.style.transform = 'translateY(-2px)'
    closeButton.style.boxShadow = '0 6px 0 #166534, 0 8px 15px rgba(0,0,0,0.5)'
  })
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.background = 'linear-gradient(180deg, #4ade80 0%, #22c55e 50%, #16a34a 100%)'
    closeButton.style.transform = 'translateY(0)'
    closeButton.style.boxShadow = '0 4px 0 #166534, 0 6px 10px rgba(0,0,0,0.4)'
  })
  closeButton.addEventListener('mousedown', () => {
    closeButton.style.transform = 'translateY(4px)'
    closeButton.style.boxShadow = '0 0 0 #166534, 0 2px 5px rgba(0,0,0,0.3)'
  })
  closeButton.addEventListener('mouseup', () => {
    closeButton.style.transform = 'translateY(-2px)'
    closeButton.style.boxShadow = '0 6px 0 #166534, 0 8px 15px rgba(0,0,0,0.5)'
  })
  closeButton.addEventListener('click', onClose)
  statsDiv.appendChild(closeButton)

  return statsDiv
}
