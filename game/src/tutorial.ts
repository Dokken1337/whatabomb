export function createTutorialScreen(onClose: () => void): HTMLDivElement {
  const tutorialDiv = document.createElement('div')
  tutorialDiv.id = 'tutorial-screen'
  tutorialDiv.style.position = 'absolute'
  tutorialDiv.style.top = '0'
  tutorialDiv.style.left = '0'
  tutorialDiv.style.width = '100vw'
  tutorialDiv.style.height = '100vh'
  tutorialDiv.style.background = 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)'
  tutorialDiv.style.display = 'none'
  tutorialDiv.style.flexDirection = 'column'
  tutorialDiv.style.justifyContent = 'flex-start'
  tutorialDiv.style.alignItems = 'center'
  tutorialDiv.style.zIndex = '2500'
  tutorialDiv.style.color = 'white'
  tutorialDiv.style.overflowY = 'auto'
  tutorialDiv.style.padding = '40px 20px'

  const title = document.createElement('h1')
  title.innerHTML = '📖 HOW TO PLAY'
  title.style.fontFamily = "'Press Start 2P', monospace"
  title.style.fontSize = '24px'
  title.style.marginBottom = '30px'
  title.style.background = 'linear-gradient(180deg, #a78bfa 0%, #8b5cf6 100%)'
  title.style.webkitBackgroundClip = 'text'
  title.style.webkitTextFillColor = 'transparent'
  title.style.filter = 'drop-shadow(0 4px 8px rgba(139, 92, 246, 0.4))'
  title.style.textAlign = 'center'
  tutorialDiv.appendChild(title)

  const content = document.createElement('div')
  content.style.maxWidth = '900px'
  content.style.width = '100%'
  content.style.padding = '20px'
  content.style.background = 'rgba(0, 0, 0, 0.2)'
  content.style.borderRadius = '15px'
  content.style.border = '1px solid rgba(255, 255, 255, 0.05)'

  const sections = [
    {
      title: '🎮 Controls',
      color: '#60a5fa',
      items: [
        '<strong style="color:#4ade80">Player 1:</strong> WASD to move, SPACE to place/throw bomb',
        '<strong style="color:#f87171">Player 2 (PvP):</strong> Arrow Keys to move, ENTER to place/throw bomb',
        '<strong style="color:#fbbf24">ESC:</strong> Pause/Resume game',
      ]
    },
    {
      title: '💣 Gameplay',
      color: '#f97316',
      items: [
        'Place bombs to destroy blocks and defeat enemies',
        'Bombs explode after 2 seconds in a cross pattern',
        'Chain reactions occur when bombs hit other bombs',
        'You have 3 lives - avoid explosions and enemies!',
        'Invulnerability lasts 2 seconds after taking damage',
        'This game supports PWAs!',
        'Want to play fullscreen on iOS? Add locally with Share - Add to Homescreen',
      ]
    },
    {
      title: '⚡ Power-Ups',
      color: '#fbbf24',
      items: [
        '<span style="color: #60a5fa;">💣 Extra Bomb</span> - Carry more bombs at once',
        '<span style="color: #fbbf24;">⚡ Larger Blast</span> - Increase explosion radius',
        '<span style="color: #a78bfa;">🦶 Kick</span> - Walk into bombs to kick them',
        '<span style="color: #f472b6;">✋ Throw</span> - Press bomb key to throw',
        '<span style="color: #22d3ee;">👟 Speed</span> - Move faster',
      ]
    },
    {
      title: '🎲 Extended Power-Ups',
      color: '#ff6600',
      items: [
        '<span style="color: #999;">Enable in Settings → Extended Power-Ups</span>',
        '<span style="color: #ffd700;">🛡️ Shield</span> - Absorbs one explosion hit (max 3)',
        '<span style="color: #ff3333;">🔥 Pierce</span> - Blasts pass through destructible blocks',
        '<span style="color: #b388ff;">👻 Ghost</span> - Walk through blocks & bombs for 8s',
        '<span style="color: #ff6600;">☢️ Power Bomb</span> - Next bomb gets +3 blast radius',
        '<span style="color: #ff00ff;">🧨 Line Bomb</span> - Place a row of bombs in facing direction',
      ]
    },
    {
      title: '🎯 Game Modes',
      color: '#4ade80',
      items: [
        '<strong>VS AI:</strong> Defeat 1-3 AI enemies',
        '<strong>PvP:</strong> Local multiplayer battle',
        '<strong>🌊 Survival:</strong> Endless waves with increasing difficulty',
        '<strong>⏱️ Time Attack:</strong> Beat the clock (bonus time for kills)',
        'VS AI and PvP are played as a match — set the length in Settings (1 round, best of 3, or best of 5)',
      ]
    },
    {
      title: '🤖 AI Behavior',
      color: '#f472b6',
      items: [
        'AI enemies path toward you and place bombs strategically',
        'They avoid danger zones and collect power-ups of their own',
        'They will blast a tunnel through crates to reach you',
        'Difficulty affects AI speed, health, aggression and power-up ceiling',
        'Higher waves in Survival Mode make enemies tougher and faster',
      ]
    },
    {
      title: '⚙️ Settings Worth Knowing',
      color: '#60a5fa',
      items: [
        '<strong>On-Screen Controls:</strong> AUTO shows the D-pad on touch devices; ON adds it on desktop too',
        '<strong>Match Length:</strong> 1 round, best of 3, or best of 5',
        '<strong>Difficulty:</strong> changes AI speed, aggression, power ceiling and enemy health',
        '<strong>Particle Effects:</strong> turn off for more frames on slower devices',
      ]
    },
    {
      title: '🏆 Tips & Strategies',
      color: '#fcd34d',
      items: [
        'Corner enemies with bombs to trap them',
        'Use kick/throw to surprise opponents',
        'Collect power-ups early for an advantage',
        'Watch bomb timers - don\'t get caught!',
        'Chain reactions clear large areas quickly',
      ]
    },
  ]

  sections.forEach(section => {
    const sectionDiv = document.createElement('div')
    sectionDiv.style.marginBottom = '20px'
    sectionDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)'
    sectionDiv.style.padding = '18px'
    sectionDiv.style.borderRadius = '12px'
    sectionDiv.style.border = '1px solid rgba(255, 255, 255, 0.08)'
    sectionDiv.style.transition = 'all 0.2s ease'

    sectionDiv.addEventListener('mouseenter', () => {
      sectionDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)'
      sectionDiv.style.borderColor = (section as any).color + '44'
    })
    sectionDiv.addEventListener('mouseleave', () => {
      sectionDiv.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)'
      sectionDiv.style.borderColor = 'rgba(255, 255, 255, 0.08)'
    })

    const sectionTitle = document.createElement('h2')
    sectionTitle.textContent = section.title
    sectionTitle.style.fontFamily = "'Russo One', sans-serif"
    sectionTitle.style.fontSize = '18px'
    sectionTitle.style.marginBottom = '12px'
    sectionTitle.style.color = (section as any).color
    sectionTitle.style.textShadow = `0 0 15px ${(section as any).color}44`
    sectionDiv.appendChild(sectionTitle)

    const list = document.createElement('ul')
    list.style.listStyle = 'none'
    list.style.padding = '0'
    list.style.margin = '0'

    section.items.forEach(item => {
      const listItem = document.createElement('li')
      listItem.innerHTML = `<span style="color:${(section as any).color}; margin-right: 8px;">▸</span>${item}`
      listItem.style.fontFamily = "'Russo One', sans-serif"
      listItem.style.fontSize = '13px'
      listItem.style.marginBottom = '8px'
      listItem.style.lineHeight = '1.6'
      listItem.style.color = '#d1d5db'
      list.appendChild(listItem)
    })

    sectionDiv.appendChild(list)
    content.appendChild(sectionDiv)
  })

  tutorialDiv.appendChild(content)

  const closeButton = document.createElement('button')
  closeButton.textContent = '✓ GOT IT!'
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
  closeButton.style.marginTop = '25px'
  
  closeButton.addEventListener('click', onClose)
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
  tutorialDiv.appendChild(closeButton)

  return tutorialDiv
}
