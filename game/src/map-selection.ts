import { MAP_CONFIGS } from './maps'
import { isMobile } from './device'

export function createMapSelectionScreen(
  onSelect: (mapKey: string) => void,
  onBack: () => void
): HTMLDivElement {
  const mapDiv = document.createElement('div')
  mapDiv.id = 'map-selection-screen'
  mapDiv.style.position = 'absolute'
  mapDiv.style.top = '0'
  mapDiv.style.left = '0'
  mapDiv.style.width = '100vw'
  mapDiv.style.height = '100vh'
  mapDiv.style.background = 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)'
  mapDiv.style.display = 'none'
  mapDiv.style.flexDirection = 'column'
  mapDiv.style.justifyContent = 'flex-start'
  mapDiv.style.alignItems = 'center'
  mapDiv.style.zIndex = '2500'
  mapDiv.style.color = 'white'
  mapDiv.style.overflowY = 'auto'
  mapDiv.style.padding = '40px 20px'

  const title = document.createElement('h1')
  title.textContent = '🗺️ SELECT MAP'
  title.style.fontFamily = "'Press Start 2P', monospace"
  title.style.fontSize = '28px'
  title.style.marginBottom = '30px'
  title.style.background = 'linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)'
  title.style.webkitBackgroundClip = 'text'
  title.style.webkitTextFillColor = 'transparent'
  title.style.filter = 'drop-shadow(0 4px 8px rgba(59, 130, 246, 0.4))'
  mapDiv.appendChild(title)

  const mapsContainer = document.createElement('div')
  mapsContainer.style.display = 'grid'
  mapsContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(260px, 1fr))'
  mapsContainer.style.gap = '20px'
  mapsContainer.style.maxWidth = '1100px'
  mapsContainer.style.width = '100%'
  mapsContainer.style.marginBottom = '30px'
  mapsContainer.style.padding = '20px'
  mapsContainer.style.background = 'rgba(0, 0, 0, 0.2)'
  mapsContainer.style.borderRadius = '15px'
  mapsContainer.style.border = '1px solid rgba(255, 255, 255, 0.05)'

  const allKeys = Object.keys(MAP_CONFIGS)
  // Show all maps on both mobile and PC, except large maps on mobile
  const mapKeys = allKeys.filter(key => {
    if (key === 'small-moon') return false
    if (isMobile() && MAP_CONFIGS[key].size === 'large') return false
    return true
  })

  mapKeys.forEach((key) => {
    const map = MAP_CONFIGS[key]
    const mapCard = document.createElement('div')
    mapCard.style.padding = '15px'
    mapCard.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)'
    mapCard.style.borderRadius = '12px'
    mapCard.style.border = '2px solid rgba(255, 255, 255, 0.1)'
    mapCard.style.cursor = 'pointer'
    mapCard.style.transition = 'all 0.3s ease'
    mapCard.style.textAlign = 'center'
    mapCard.style.position = 'relative'
    mapCard.style.overflow = 'hidden'

    mapCard.addEventListener('mouseenter', () => {
      mapCard.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)'
      mapCard.style.borderColor = '#3b82f6'
      mapCard.style.transform = 'translateY(-5px) scale(1.02)'
      mapCard.style.boxShadow = '0 15px 30px rgba(59, 130, 246, 0.3)'
    })
    mapCard.addEventListener('mouseleave', () => {
      mapCard.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)'
      mapCard.style.borderColor = 'rgba(255, 255, 255, 0.1)'
      mapCard.style.transform = 'translateY(0) scale(1)'
      mapCard.style.boxShadow = 'none'
    })

    // Map preview (colored box)
    const preview = document.createElement('div')
    preview.style.width = '100%'
    preview.style.height = '100px'
    preview.style.borderRadius = '8px'
    preview.style.marginBottom = '12px'
    preview.style.background = getThemeGradient(map.theme)
    preview.style.display = 'flex'
    preview.style.alignItems = 'center'
    preview.style.justifyContent = 'center'
    preview.style.fontSize = '42px'
    preview.style.boxShadow = 'inset 0 -3px 10px rgba(0,0,0,0.3)'
    preview.textContent = getThemeIcon(map.theme)

    const name = document.createElement('div')
    name.textContent = map.name
    name.style.fontFamily = "'Russo One', sans-serif"
    name.style.fontSize = '16px'
    name.style.fontWeight = 'bold'
    name.style.marginBottom = '6px'
    name.style.color = '#fff'

    const description = document.createElement('div')
    description.textContent = map.description
    description.style.fontFamily = "'Russo One', sans-serif"
    description.style.fontSize = '11px'
    description.style.color = '#9ca3af'
    description.style.marginBottom = '10px'

    const size = document.createElement('div')
    size.textContent = `📐 ${map.gridWidth}x${map.gridHeight}`
    size.style.fontFamily = "'Press Start 2P', monospace"
    size.style.fontSize = '8px'
    size.style.color = '#60a5fa'
    size.style.padding = '6px 10px'
    size.style.background = 'rgba(59, 130, 246, 0.2)'
    size.style.borderRadius = '6px'
    size.style.display = 'inline-block'
    size.style.border = '1px solid rgba(59, 130, 246, 0.3)'

    mapCard.appendChild(preview)
    mapCard.appendChild(name)
    mapCard.appendChild(description)
    mapCard.appendChild(size)

    mapCard.addEventListener('click', () => {
      onSelect(key)
    })

    mapsContainer.appendChild(mapCard)
  })

  mapDiv.appendChild(mapsContainer)

  const backButton = document.createElement('button')
  backButton.textContent = '← BACK'
  backButton.style.fontFamily = "'Press Start 2P', monospace"
  backButton.style.fontSize = '12px'
  backButton.style.padding = '15px 35px'
  backButton.style.cursor = 'pointer'
  backButton.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
  backButton.style.color = '#e5e5e5'
  backButton.style.border = '3px solid #4b5563'
  backButton.style.borderRadius = '8px'
  backButton.style.fontWeight = 'bold'
  backButton.style.boxShadow = '0 4px 0 #1f2937'
  backButton.style.transition = 'all 0.1s ease'
  backButton.style.transform = 'translateY(0)'
  
  backButton.addEventListener('click', onBack)
  backButton.addEventListener('mouseenter', () => {
    backButton.style.background = 'linear-gradient(180deg, #4b5563 0%, #374151 100%)'
    backButton.style.transform = 'translateY(-2px)'
    backButton.style.boxShadow = '0 6px 0 #1f2937'
  })
  backButton.addEventListener('mouseleave', () => {
    backButton.style.background = 'linear-gradient(180deg, #374151 0%, #1f2937 100%)'
    backButton.style.transform = 'translateY(0)'
    backButton.style.boxShadow = '0 4px 0 #1f2937'
  })
  backButton.addEventListener('mousedown', () => {
    backButton.style.transform = 'translateY(4px)'
    backButton.style.boxShadow = '0 0 0 #1f2937'
  })
  backButton.addEventListener('mouseup', () => {
    backButton.style.transform = 'translateY(-2px)'
    backButton.style.boxShadow = '0 6px 0 #1f2937'
  })
  mapDiv.appendChild(backButton)

  return mapDiv
}

function getThemeGradient(theme: string): string {
  switch (theme) {
    case 'ice':
      return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    case 'lava':
      return 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
    case 'forest':
      return 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
    case 'moon':
      return 'linear-gradient(135deg, #2c3e50 0%, #bdc3c7 100%)'
    case 'space':
      return 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)'
    default:
      return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
  }
}

function getThemeIcon(theme: string): string {
  switch (theme) {
    case 'ice':
      return '❄️'
    case 'lava':
      return '🌋'
    case 'forest':
      return '🌲'
    case 'moon':
      return '🌑'
    case 'space':
      return '🌌'
    default:
      return '🏟️'
  }
}
