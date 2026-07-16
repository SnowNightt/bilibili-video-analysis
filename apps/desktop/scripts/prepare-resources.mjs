import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(scriptDir, '..')
const resourcesDir = path.join(desktopDir, 'resources')
const assetsDir = path.join(desktopDir, 'assets')
const requireFromApi = createRequire(path.resolve(desktopDir, '../api/package.json'))
const ffmpegPath = requireFromApi('ffmpeg-static')

await rm(resourcesDir, { recursive: true, force: true })
await mkdir(path.join(resourcesDir, 'ffmpeg'), { recursive: true })
await cp(path.resolve(desktopDir, '../web/dist'), path.join(resourcesDir, 'web'), { recursive: true })
await cp(ffmpegPath, path.join(resourcesDir, 'ffmpeg', 'ffmpeg.exe'))

const svg = await readFile(path.join(assetsDir, 'icon.svg'))
const pngPaths = []
for (const size of [16, 32, 48, 64, 128, 256]) {
  const output = path.join(assetsDir, `icon-${size}.png`)
  await sharp(svg).resize(size, size).png().toFile(output)
  pngPaths.push(output)
}
await cp(path.join(assetsDir, 'icon-256.png'), path.join(assetsDir, 'icon.png'))
await writeFile(path.join(assetsDir, 'icon.ico'), await pngToIco(pngPaths))
