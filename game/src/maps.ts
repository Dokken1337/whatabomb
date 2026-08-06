import { Color3 } from '@babylonjs/core'

export type MapSize = 'small' | 'medium' | 'large'
export type MapTheme = 'classic' | 'ice' | 'lava' | 'forest' | 'space' | 'moon'

export interface MapConfig {
  size: MapSize
  theme: MapTheme
  gridWidth: number
  gridHeight: number
  colors: {
    ground: Color3
    wall: Color3
  }
  name: string
  description: string
}

export const MAP_CONFIGS: Record<string, MapConfig> = {
  'small-classic': {
    size: 'small',
    theme: 'classic',
    gridWidth: 13,
    gridHeight: 13,
    name: 'Small Arena',
    description: 'Fast-paced battles, good for mobile devices',
    colors: {
      ground: new Color3(0.2, 0.45, 0.2), // More vibrant green
      wall: new Color3(0.55, 0.55, 0.6), // Brighter wall
    },
  },
  'small-moon': {
    size: 'small',
    theme: 'moon',
    gridWidth: 13,
    gridHeight: 13,
    name: 'Moon Base',
    description: 'Low gravity battles on the moon!',
    colors: {
      ground: new Color3(0.2, 0.2, 0.25),
      wall: new Color3(0.4, 0.4, 0.45),
    },
  },
  'small-ice': {
    size: 'small',
    theme: 'ice',
    gridWidth: 13,
    gridHeight: 13,
    name: 'Small Ice Arena',
    description: 'Quick frozen battles',
    colors: {
      ground: new Color3(0.7, 0.9, 1.0), // Brighter ice
      wall: new Color3(0.32, 0.46, 0.62), // Dark slate, so walls read against the pale floor
    },
  },
  'small-lava': {
    size: 'small',
    theme: 'lava',
    gridWidth: 13,
    gridHeight: 13,
    name: 'Small Lava Arena',
    description: 'Intense volcanic action',
    colors: {
      ground: new Color3(0.75, 0.62, 0.58), // Basalt tint; the floor texture carries the colour
      wall: new Color3(0.82, 0.78, 0.74), // Pale stone, the lightest surface here
    },
  },
  'small-forest': {
    size: 'small',
    theme: 'forest',
    gridWidth: 13,
    gridHeight: 13,
    name: 'Small Forest Arena',
    description: 'Quick woodland skirmishes',
    colors: {
      ground: new Color3(0.55, 0.78, 0.45), // Vibrant forest green
      wall: new Color3(0.72, 0.70, 0.62), // Pale birch, well above the floor in value
    },
  },
  'medium-classic': {
    size: 'medium',
    theme: 'classic',
    gridWidth: 17,
    gridHeight: 17,
    name: 'Classic Arena',
    description: 'The original battlefield',
    colors: {
      ground: new Color3(0.2, 0.45, 0.2),
      wall: new Color3(0.55, 0.55, 0.6),
    },
  },
  'medium-ice': {
    size: 'medium',
    theme: 'ice',
    gridWidth: 17,
    gridHeight: 17,
    name: 'Ice Arena',
    description: 'Frozen battlefield with icy colors',
    colors: {
      ground: new Color3(0.7, 0.9, 1.0),
      wall: new Color3(0.32, 0.46, 0.62), // Dark slate, so walls read against the pale floor
    },
  },
  'medium-lava': {
    size: 'medium',
    theme: 'lava',
    gridWidth: 17,
    gridHeight: 17,
    name: 'Lava Arena',
    description: 'Volcanic battlefield with fiery colors',
    colors: {
      ground: new Color3(0.75, 0.62, 0.58),
      wall: new Color3(0.82, 0.78, 0.74), // Pale stone, the lightest surface here
    },
  },
  'medium-forest': {
    size: 'medium',
    theme: 'forest',
    gridWidth: 17,
    gridHeight: 17,
    name: 'Forest Arena',
    description: 'Natural battlefield with earthy colors',
    colors: {
      ground: new Color3(0.55, 0.78, 0.45),
      wall: new Color3(0.72, 0.70, 0.62), // Pale birch, well above the floor in value
    },
  },
  'medium-space': {
    size: 'medium',
    theme: 'space',
    gridWidth: 17,
    gridHeight: 17,
    name: 'Space Station',
    description: 'Low gravity battles in the deep void',
    colors: {
      ground: new Color3(0.1, 0.05, 0.2),
      wall: new Color3(0.1, 0.8, 0.9),
    },
  },
  'large-classic': {
    size: 'large',
    theme: 'classic',
    gridWidth: 21,
    gridHeight: 21,
    name: 'Large Classic Arena',
    description: 'Epic battles on a massive battlefield',
    colors: {
      ground: new Color3(0.15, 0.35, 0.15),
      wall: new Color3(0.5, 0.5, 0.5),
    },
  },
  'large-ice': {
    size: 'large',
    theme: 'ice',
    gridWidth: 21,
    gridHeight: 21,
    name: 'Large Ice Arena',
    description: 'Expansive frozen battlefield',
    colors: {
      ground: new Color3(0.7, 0.85, 0.95),
      wall: new Color3(0.30, 0.44, 0.60), // Dark slate, so walls read against the pale floor
    },
  },
  'large-lava': {
    size: 'large',
    theme: 'lava',
    gridWidth: 21,
    gridHeight: 21,
    name: 'Large Lava Arena',
    description: 'Massive volcanic warzone',
    colors: {
      ground: new Color3(0.68, 0.56, 0.52),
      wall: new Color3(0.78, 0.74, 0.70),
    },
  },
  'large-forest': {
    size: 'large',
    theme: 'forest',
    gridWidth: 21,
    gridHeight: 21,
    name: 'Large Forest Arena',
    description: 'Sprawling woodland battleground',
    colors: {
      ground: new Color3(0.48, 0.68, 0.38),
      wall: new Color3(0.68, 0.66, 0.58), // Pale birch, well above the floor in value
    },
  },
  'chaos-neon': {
    size: 'small',
    theme: 'space',
    gridWidth: 13,
    gridHeight: 13,
    name: '⚡ Neon Chaos ⚡',
    description: 'Compact cyberpunk arena with neon vibes!',
    colors: {
      ground: new Color3(0.05, 0.0, 0.1),
      wall: new Color3(1.0, 0.0, 0.5),
    },
  },
  'chaos-neon-large': {
    size: 'medium',
    theme: 'space',
    gridWidth: 17,
    gridHeight: 17,
    name: '⚡ Large Neon Chaos ⚡',
    description: 'Full-sized cyberpunk battlefield!',
    colors: {
      ground: new Color3(0.05, 0.0, 0.1),
      wall: new Color3(1.0, 0.0, 0.5),
    },
  },
}

export function getMapConfig(key: string): MapConfig {
  return MAP_CONFIGS[key] || MAP_CONFIGS['medium-classic']
}



