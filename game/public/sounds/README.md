# Sound Files

Sound effects are generated programmatically. To regenerate them, run:
```bash
node scripts/generate-sounds.js
```

## Included Sounds:
- `bomb-place.wav` - When placing a bomb (high-pitched beep)
- `explosion.wav` - Bomb explosion (bass boom with crackle)
- `powerup.wav` - Collecting power-up (magical arpeggio)
- `victory.wav` - Winning the game (triumphant fanfare)
- `defeat.wav` - Losing the game (sad descending tones)
- `game-start.wav` - Ready-Set-Go countdown complete
- `death.wav` - Player/enemy hit (descending wah-wah)
- `menu-select.wav` - Menu hover sound (soft blip)
- `menu-click.wav` - Menu button click (button press)
- `kick.wav` - Kicking a bomb (whoosh)
- `throw.wav` - Throwing a bomb (arc whoosh)
- `countdown-tick.wav` - Countdown timer tick
- `walk.wav` - Movement/footstep (soft thud)
- `bgm.wav` - Background music (8-second chiptune loop)

## Customization:
You can replace any .wav file with your own sounds. The generated sounds are
simple synthesized effects. For better audio quality, consider using sounds from:
- https://freesound.org
- https://opengameart.org/art-search?keys=bomb
- https://kenney.nl/assets (Game Audio packs)
- https://mixkit.co/free-sound-effects/

## Tips:
- Keep files small (under 100KB for SFX)
- Use MP3 or OGG format
- Normalize volume levels
- Background music should loop seamlessly
