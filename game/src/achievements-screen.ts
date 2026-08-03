import { AchievementsManager } from './achievements'

export function createAchievementsScreen(
  achievementsManager: AchievementsManager,
  onClose: () => void
): HTMLDivElement {
  const achievementsDiv = document.createElement('div')
  achievementsDiv.id = 'achievements-screen'
  achievementsDiv.style.position = 'absolute'
  achievementsDiv.style.top = '0'
  achievementsDiv.style.left = '0'
  achievementsDiv.style.width = '100vw'
  achievementsDiv.style.height = '100vh'
  achievementsDiv.style.background = 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)'
  achievementsDiv.style.display = 'none'
  achievementsDiv.style.flexDirection = 'column'
  achievementsDiv.style.justifyContent = 'flex-start'
  achievementsDiv.style.alignItems = 'center'
  achievementsDiv.style.zIndex = '2500'
  achievementsDiv.style.color = 'white'
  achievementsDiv.style.overflowY = 'auto'
  achievementsDiv.style.padding = '40px 20px'
  
  // Function to refresh the achievements display
  function refreshAchievements() {
    // Clear existing content
    achievementsDiv.innerHTML = ''
    
    const achievements = achievementsManager.getAllAchievements()
    const unlockedCount = achievementsManager.getUnlockedCount()
    const totalCount = achievementsManager.getTotalCount()

  const title = document.createElement('h1')
  title.textContent = '🏆 ACHIEVEMENTS'
  title.style.fontFamily = "'Press Start 2P', monospace"
  title.style.fontSize = '28px'
  title.style.marginBottom = '15px'
  title.style.background = 'linear-gradient(180deg, #fcd34d 0%, #f59e0b 100%)'
  title.style.webkitBackgroundClip = 'text'
  title.style.webkitTextFillColor = 'transparent'
  title.style.filter = 'drop-shadow(0 4px 8px rgba(251, 191, 36, 0.4))'
  achievementsDiv.appendChild(title)

  // Progress bar
  const progressContainer = document.createElement('div')
  progressContainer.style.width = '300px'
  progressContainer.style.marginBottom = '30px'
  
  const progressText = document.createElement('div')
  progressText.textContent = `${unlockedCount} / ${totalCount} Unlocked`
  progressText.style.fontFamily = "'Russo One', sans-serif"
  progressText.style.fontSize = '14px'
  progressText.style.marginBottom = '8px'
  progressText.style.color = '#9ca3af'
  progressText.style.textAlign = 'center'
  
  const progressBarBg = document.createElement('div')
  progressBarBg.style.width = '100%'
  progressBarBg.style.height = '12px'
  progressBarBg.style.background = 'linear-gradient(180deg, #1f2937 0%, #111827 100%)'
  progressBarBg.style.borderRadius = '6px'
  progressBarBg.style.border = '2px solid #374151'
  progressBarBg.style.overflow = 'hidden'
  
  const progressBarFill = document.createElement('div')
  progressBarFill.style.width = `${(unlockedCount / totalCount) * 100}%`
  progressBarFill.style.height = '100%'
  progressBarFill.style.background = 'linear-gradient(90deg, #fbbf24, #f59e0b)'
  progressBarFill.style.borderRadius = '4px'
  progressBarFill.style.boxShadow = '0 0 10px rgba(251, 191, 36, 0.5)'
  progressBarFill.style.transition = 'width 0.5s ease'
  
  progressBarBg.appendChild(progressBarFill)
  progressContainer.appendChild(progressText)
  progressContainer.appendChild(progressBarBg)
  achievementsDiv.appendChild(progressContainer)

  const achievementsContainer = document.createElement('div')
  achievementsContainer.style.display = 'grid'
  achievementsContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))'
  achievementsContainer.style.gap = '15px'
  achievementsContainer.style.maxWidth = '1200px'
  achievementsContainer.style.width = '100%'
  achievementsContainer.style.marginBottom = '30px'
  achievementsContainer.style.padding = '20px'
  achievementsContainer.style.background = 'rgba(0, 0, 0, 0.2)'
  achievementsContainer.style.borderRadius = '15px'
  achievementsContainer.style.border = '1px solid rgba(255, 255, 255, 0.05)'

  achievements.forEach(achievement => {
    const achievementDiv = document.createElement('div')
    achievementDiv.style.padding = '18px'
    achievementDiv.style.background = achievement.unlocked 
      ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.15) 0%, rgba(245, 158, 11, 0.1) 100%)' 
      : 'linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.01) 100%)'
    achievementDiv.style.borderRadius = '12px'
    achievementDiv.style.border = achievement.unlocked 
      ? '2px solid rgba(251, 191, 36, 0.4)' 
      : '2px solid rgba(255, 255, 255, 0.05)'
    achievementDiv.style.textAlign = 'center'
    achievementDiv.style.transition = 'all 0.3s ease'
    achievementDiv.style.cursor = 'default'
    achievementDiv.style.position = 'relative'
    achievementDiv.style.overflow = 'hidden'

    if (achievement.unlocked) {
      // Add shimmer effect for unlocked
      const shimmer = document.createElement('div')
      shimmer.style.position = 'absolute'
      shimmer.style.top = '0'
      shimmer.style.left = '-100%'
      shimmer.style.width = '100%'
      shimmer.style.height = '100%'
      shimmer.style.background = 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)'
      shimmer.style.animation = 'shimmer 3s infinite'
      achievementDiv.appendChild(shimmer)
      
      achievementDiv.addEventListener('mouseenter', () => {
        achievementDiv.style.transform = 'translateY(-5px) scale(1.02)'
        achievementDiv.style.boxShadow = '0 10px 30px rgba(251, 191, 36, 0.3)'
      })
      achievementDiv.addEventListener('mouseleave', () => {
        achievementDiv.style.transform = 'translateY(0) scale(1)'
        achievementDiv.style.boxShadow = 'none'
      })
    }

    const icon = document.createElement('div')
    icon.textContent = achievement.unlocked ? achievement.icon : '🔒'
    icon.style.fontSize = '40px'
    icon.style.marginBottom = '10px'
    icon.style.filter = achievement.unlocked ? 'drop-shadow(0 0 8px rgba(251,191,36,0.5))' : 'grayscale(100%)'
    icon.style.opacity = achievement.unlocked ? '1' : '0.3'
    icon.style.position = 'relative'
    icon.style.zIndex = '1'

    const name = document.createElement('div')
    name.textContent = achievement.name
    name.style.fontFamily = "'Russo One', sans-serif"
    name.style.fontSize = '14px'
    name.style.fontWeight = 'bold'
    name.style.marginBottom = '6px'
    name.style.color = achievement.unlocked ? '#fbbf24' : '#4b5563'
    name.style.textShadow = achievement.unlocked ? '0 0 10px rgba(251,191,36,0.3)' : 'none'
    name.style.position = 'relative'
    name.style.zIndex = '1'

    const description = document.createElement('div')
    description.textContent = achievement.unlocked 
      ? achievement.description 
      : '???'
    description.style.fontFamily = "'Russo One', sans-serif"
    description.style.fontSize = '11px'
    description.style.color = achievement.unlocked ? '#9ca3af' : '#374151'
    description.style.marginBottom = '8px'
    description.style.position = 'relative'
    description.style.zIndex = '1'

    achievementDiv.appendChild(icon)
    achievementDiv.appendChild(name)
    achievementDiv.appendChild(description)

    // Show progress bar if applicable
    if (achievement.maxProgress && achievement.progress !== undefined) {
      const progressBar = document.createElement('div')
      progressBar.style.width = '100%'
      progressBar.style.height = '6px'
      progressBar.style.background = 'linear-gradient(180deg, #1f2937 0%, #111827 100%)'
      progressBar.style.borderRadius = '3px'
      progressBar.style.overflow = 'hidden'
      progressBar.style.marginTop = '8px'
      progressBar.style.border = '1px solid #374151'
      progressBar.style.position = 'relative'
      progressBar.style.zIndex = '1'

      const progressFill = document.createElement('div')
      const progressPercent = (achievement.progress / achievement.maxProgress) * 100
      progressFill.style.width = `${progressPercent}%`
      progressFill.style.height = '100%'
      progressFill.style.background = achievement.unlocked 
        ? 'linear-gradient(90deg, #fbbf24, #f59e0b)' 
        : 'linear-gradient(90deg, #22c55e, #16a34a)'
      progressFill.style.transition = 'width 0.3s'
      progressFill.style.boxShadow = achievement.unlocked 
        ? '0 0 8px rgba(251, 191, 36, 0.5)' 
        : '0 0 8px rgba(34, 197, 94, 0.5)'

      progressBar.appendChild(progressFill)
      achievementDiv.appendChild(progressBar)

      const progressText = document.createElement('div')
      progressText.textContent = `${achievement.progress} / ${achievement.maxProgress}`
      progressText.style.fontFamily = "'Press Start 2P', monospace"
      progressText.style.fontSize = '8px'
      progressText.style.color = '#6b7280'
      progressText.style.marginTop = '5px'
      progressText.style.position = 'relative'
      progressText.style.zIndex = '1'
      achievementDiv.appendChild(progressText)
    }

    achievementsContainer.appendChild(achievementDiv)
  })

  achievementsDiv.appendChild(achievementsContainer)

  // Add shimmer keyframes
  const shimmerStyle = document.createElement('style')
  shimmerStyle.textContent = `
    @keyframes shimmer {
      0% { left: -100%; }
      50%, 100% { left: 100%; }
    }
  `
  achievementsDiv.appendChild(shimmerStyle)

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
    achievementsDiv.appendChild(closeButton)
  }
  
  // Initial render
  refreshAchievements()
  
  // Store refresh function on the element so it can be called externally
  ;(achievementsDiv as any).refresh = refreshAchievements

  return achievementsDiv
}

export function showAchievementNotification(achievement: { name: string; icon: string; description: string }) {
  const notification = document.createElement('div')
  notification.style.position = 'fixed'
  notification.style.top = '20px'
  notification.style.right = '20px'
  notification.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)'
  notification.style.border = '3px solid #fbbf24'
  notification.style.color = '#fff'
  notification.style.padding = '20px 25px'
  notification.style.borderRadius = '15px'
  notification.style.boxShadow = '0 0 30px rgba(251, 191, 36, 0.4), 0 10px 40px rgba(0, 0, 0, 0.5)'
  notification.style.zIndex = '9999'
  notification.style.minWidth = '320px'
  notification.style.animation = 'achievementSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)'

  const style = document.createElement('style')
  style.textContent = `
    @keyframes achievementSlideIn {
      from {
        transform: translateX(400px) scale(0.8);
        opacity: 0;
      }
      to {
        transform: translateX(0) scale(1);
        opacity: 1;
      }
    }
    @keyframes achievementSlideOut {
      from {
        transform: translateX(0) scale(1);
        opacity: 1;
      }
      to {
        transform: translateX(400px) scale(0.8);
        opacity: 0;
      }
    }
    @keyframes achievementGlow {
      0%, 100% { box-shadow: 0 0 30px rgba(251, 191, 36, 0.4), 0 10px 40px rgba(0, 0, 0, 0.5); }
      50% { box-shadow: 0 0 50px rgba(251, 191, 36, 0.6), 0 10px 40px rgba(0, 0, 0, 0.5); }
    }
    @keyframes achievementIconBounce {
      0%, 100% { transform: scale(1) rotate(0deg); }
      25% { transform: scale(1.2) rotate(-10deg); }
      50% { transform: scale(1) rotate(0deg); }
      75% { transform: scale(1.2) rotate(10deg); }
    }
  `
  document.head.appendChild(style)
  
  // Add glow animation after slide in
  setTimeout(() => {
    notification.style.animation = 'achievementGlow 2s ease-in-out infinite'
  }, 500)

  notification.innerHTML = `
    <div style="display: flex; align-items: center; gap: 18px;">
      <div style="font-size: 50px; animation: achievementIconBounce 0.6s ease-in-out; filter: drop-shadow(0 0 10px rgba(251, 191, 36, 0.5));">${achievement.icon}</div>
      <div>
        <div style="font-family: 'Press Start 2P', monospace; font-size: 8px; font-weight: bold; color: #fbbf24; margin-bottom: 8px; letter-spacing: 1px; text-shadow: 0 0 10px rgba(251, 191, 36, 0.5);">🏆 ACHIEVEMENT UNLOCKED!</div>
        <div style="font-family: 'Russo One', sans-serif; font-size: 18px; font-weight: bold; margin-bottom: 6px; color: #fff;">${achievement.name}</div>
        <div style="font-family: 'Russo One', sans-serif; font-size: 12px; color: #9ca3af;">${achievement.description}</div>
      </div>
    </div>
  `

  document.body.appendChild(notification)

  setTimeout(() => {
    notification.style.animation = 'achievementSlideOut 0.5s ease-in forwards'
    setTimeout(() => {
      notification.remove()
      style.remove()
    }, 500)
  }, 4500)
}
