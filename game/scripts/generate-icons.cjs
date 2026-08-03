// Generate minimal PWA icon PNGs (no dependencies)
// Produces a themed bomb icon with pure pixel operations
// Run: node scripts/generate-icons.cjs

const fs = require('fs')
const zlib = require('zlib')

function createPNG(size) {
  const pixels = Buffer.alloc(size * size * 4)

  const cx = size / 2, cy = size / 2
  const bombR = size * 0.28
  const fuseW = size * 0.03

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)

      // Background
      let r = 26, g = 26, b = 46, a = 255 // #1a1a2e

      // Bomb body (dark sphere with specular highlight)
      if (dist < bombR) {
        const nd = dist / bombR
        const highlight = Math.max(0, 1 - ((dx + bombR * 0.3) ** 2 + (dy + bombR * 0.3) ** 2) / (bombR * bombR * 0.6))
        const base = 0.12 + highlight * 0.35
        r = Math.min(255, Math.floor(base * 255))
        g = Math.min(255, Math.floor(base * 255))
        b = Math.min(255, Math.floor((base + 0.02) * 255))
      }

      // Fuse (line going up-right from top of bomb)
      const fuseStartX = cx + bombR * 0.15
      const fuseStartY = cy - bombR * 0.85
      const fuseEndX = cx + bombR * 0.5
      const fuseEndY = cy - bombR * 1.5
      // Distance from point to line segment
      const lx = fuseEndX - fuseStartX, ly = fuseEndY - fuseStartY
      const len2 = lx * lx + ly * ly
      let t = Math.max(0, Math.min(1, ((x - fuseStartX) * lx + (y - fuseStartY) * ly) / len2))
      const px = fuseStartX + t * lx, py = fuseStartY + t * ly
      const fuseDist = Math.sqrt((x - px) ** 2 + (y - py) ** 2)
      if (fuseDist < fuseW) {
        r = 140; g = 90; b = 40 // brown fuse
      }

      // Spark at fuse tip
      const sparkDist = Math.sqrt((x - fuseEndX) ** 2 + (y - fuseEndY) ** 2)
      if (sparkDist < size * 0.06) {
        const si = 1 - sparkDist / (size * 0.06)
        r = Math.min(255, Math.floor(255 * si + r * (1 - si)))
        g = Math.min(255, Math.floor(180 * si + g * (1 - si)))
        b = Math.min(255, Math.floor(50 * si + b * (1 - si)))
      }

      // Orange glow around bomb (subtle)
      if (dist > bombR && dist < bombR * 1.4) {
        const glow = 1 - (dist - bombR) / (bombR * 0.4)
        r = Math.min(255, r + Math.floor(80 * glow))
        g = Math.min(255, g + Math.floor(25 * glow))
      }

      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = a
    }
  }

  // Encode as PNG
  // Build raw image data with filter byte per row
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // no filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const compressed = zlib.deflateSync(raw)

  function crc32(buf) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0)
    }
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const typeAndData = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeAndData))
    return Buffer.concat([len, typeAndData, crc])
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA color
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [192, 512]) {
  const png = createPNG(size)
  fs.writeFileSync(`public/icon-${size}.png`, png)
  console.log(`Generated icon-${size}.png (${png.length} bytes)`)
}
