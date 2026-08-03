# What'a Bomb!

A fast-paced, explosive multiplayer Bomberman-style game built with TypeScript and Babylon.js!

## Features

- **Multiple Game Modes**: 1v1, 1v2, 1v3 against AI, local PvP, Survival waves, and Time Attack
- **Match Play**: VS AI and PvP run as a single round, best of 3, or best of 5
- **Arena Maps**: 3 sizes (small, medium, large) across 6 themes (classic, ice, lava, forest, space, moon)
- **Fair, Connected Arenas**: layouts are 4-fold symmetric so every corner gets the same opening, and the generator guarantees the whole map is reachable
- **Smart AI**: pathfinds toward you, blasts tunnels through crates, escapes its own blasts, and collects power-ups — speed, health, aggression and power ceiling all scale with difficulty
- **Power-Ups**: Extra bombs, larger blasts, kick, throw, and speed boosts (plus 5 more with Extended Power-Ups)
- **Statistics & Achievements**: Track your progress and unlock achievements
- **Customization**: Player colors, character shapes, difficulty, match length, and on-screen controls

## Controls

### Player 1
- **WASD** - Move
- **Space** - Place/Throw Bomb

### Player 2 (PvP Mode)
- **Arrow Keys** - Move
- **Enter** - Place/Throw Bomb

### General
- **Escape** - Pause/Resume Game

### On-Screen Controls
A touch D-pad and bomb button appear automatically on mobile. Desktop players can
turn them on from **Settings → On-Screen Controls** (`AUTO` / `ON` / `OFF`) and
drive them with the mouse — click a direction or drag across the D-pad.

## Power-Ups

- **Extra Bomb** (Blue) - Increase bomb capacity
- **Larger Blast** (Yellow) - Bigger explosion radius
- **Kick** (Brown) - Kick bombs by walking into them
- **Throw** (Peach) - Throw bombs 3 tiles away
- **Speed** (Cyan) - Move faster �

## Development

### Prerequisites
- Node.js 18+
- npm

### Setup
```bash
npm install
```

### Development
```bash
npm run dev
```

### Production Build
```bash
npm run build
```

### Preview Production Build
```bash
npm run preview
```

## Tech Stack

- **TypeScript** - Type-safe JavaScript
- **Babylon.js** - 3D rendering engine
- **Vite** - Build tool and dev server

## License

MIT
