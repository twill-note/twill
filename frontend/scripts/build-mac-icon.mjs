import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(scriptDir, '..')
const source = path.join(frontendRoot, 'electron', 'assets', 'twill-icon.png')
const output = path.join(frontendRoot, 'electron', 'assets', 'twill-icon.icns')

// electron-builder의 PNG → ICNS 변환기는 일부 작은 macOS 아이콘 레이어를 깨뜨린다.
// 각 PNG를 직접 만든 뒤 표준 ICNS 청크로 조합하면 Finder의 목록/검색 아이콘까지 안정적이다.
const layers = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 512],
  ['ic14', 1024],
]

function icnsChunk(type, contents) {
  const chunk = Buffer.alloc(8 + contents.length)
  chunk.write(type, 0, 4, 'ascii')
  chunk.writeUInt32BE(chunk.length, 4)
  contents.copy(chunk, 8)
  return chunk
}

if (process.platform !== 'darwin') {
  throw new Error('macOS 아이콘은 macOS에서만 생성할 수 있습니다.')
}
if (!fs.existsSync(source)) {
  throw new Error(`아이콘 원본을 찾을 수 없습니다: ${source}`)
}

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twill-mac-icon-'))
try {
  const chunks = layers.map(([type, pixels]) => {
    const resized = path.join(temporaryDir, `${type}.png`)
    execFileSync('sips', [
      '-s', 'format', 'png',
      '--resampleHeightWidth', String(pixels), String(pixels),
      source,
      '--out', resized,
    ], { stdio: 'ignore' })
    return icnsChunk(type, fs.readFileSync(resized))
  })
  const file = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(header.length + file.length, 4)
  fs.writeFileSync(output, Buffer.concat([header, file]))
  console.log(`[icon] Generated ${path.relative(frontendRoot, output)}`)
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true })
}
