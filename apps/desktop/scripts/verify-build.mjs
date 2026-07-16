import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requiredFiles = [
  'dist/main.js',
  'dist/preload.js',
  'dist/api/utility.js',
  'resources/web/index.html',
  'resources/ffmpeg/ffmpeg.exe',
  'assets/icon.ico',
]

for (const relative of requiredFiles) {
  const filePath = path.join(desktopDir, relative)
  await access(filePath)
  if ((await stat(filePath)).size === 0) throw new Error(`${relative} is empty`)
}
process.stdout.write('Desktop build verification passed.\n')
