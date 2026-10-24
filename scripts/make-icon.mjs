// Builds the macOS app icon from Galaxy.png: an inset, rounded tile on a
// transparent 1024 canvas, then an .icns via iconutil.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'Galaxy.png')
const buildDir = join(root, 'build')
const resourcesDir = join(root, 'resources')

const CANVAS = 1024
const TILE = 824
const RADIUS = 186
const INSET = (CANVAS - TILE) / 2

const mask = Buffer.from(
  `<svg width="${TILE}" height="${TILE}"><rect width="${TILE}" height="${TILE}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`
)

mkdirSync(buildDir, { recursive: true })
mkdirSync(resourcesDir, { recursive: true })

const tile = await sharp(source)
  .resize(TILE, TILE, { kernel: 'lanczos3', fit: 'cover' })
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer()

const iconPng = join(buildDir, 'icon.png')
await sharp({
  create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
})
  .composite([{ input: tile, left: INSET, top: INSET }])
  .png()
  .toFile(iconPng)

await sharp(iconPng).resize(512, 512).toFile(join(resourcesDir, 'icon.png'))

// In-app mark: full-bleed rounded tile without the dock inset.
const markMask = Buffer.from(`<svg width="256" height="256"><rect width="256" height="256" rx="58" ry="58"/></svg>`)
await sharp(source)
  .resize(256, 256, { kernel: 'lanczos3' })
  .composite([{ input: markMask, blend: 'dest-in' }])
  .png()
  .toFile(join(root, 'src/renderer/src/assets/mark.png'))

if (process.platform === 'darwin') {
  const iconset = join(buildDir, 'icon.iconset')
  if (existsSync(iconset)) rmSync(iconset, { recursive: true })
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(iconPng).resize(size, size).toFile(join(iconset, `icon_${size}x${size}.png`))
    await sharp(iconPng)
      .resize(size * 2, size * 2)
      .toFile(join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
  rmSync(iconset, { recursive: true })
}

console.log('icon written to build/ and resources/')
