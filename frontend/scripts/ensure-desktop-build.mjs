import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = [path.join(frontendRoot, 'dist', 'index.html'), path.join(frontendRoot, 'dist', 'quick-memo.html')]
const inputs = [
  path.join(frontendRoot, 'src'),
  path.join(frontendRoot, 'public'),
  path.join(frontendRoot, 'index.html'),
  path.join(frontendRoot, 'quick-memo.html'),
  path.join(frontendRoot, 'vite.config.ts'),
  path.join(frontendRoot, 'tsconfig.json'),
  path.join(frontendRoot, 'tsconfig.app.json'),
  path.join(frontendRoot, 'tsconfig.node.json'),
  path.join(frontendRoot, 'package.json'),
  path.join(frontendRoot, 'package-lock.json'),
]

function newestMtime(target) {
  if (!fs.existsSync(target)) return 0
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  return fs.readdirSync(target, { withFileTypes: true }).reduce((newest, entry) => {
    const entryPath = path.join(target, entry.name)
    return Math.max(newest, newestMtime(entryPath))
  }, stat.mtimeMs)
}

const outputsExist = outputs.every((target) => fs.existsSync(target))
const oldestOutput = outputsExist ? Math.min(...outputs.map((target) => fs.statSync(target).mtimeMs)) : 0
const newestInput = Math.max(...inputs.map(newestMtime))

if (outputsExist && oldestOutput >= newestInput) {
  console.log('[desktop] 프런트엔드 빌드가 최신 상태라 빌드를 건너뜁니다.')
  process.exit(0)
}

console.log('[desktop] 변경된 프런트엔드를 빌드합니다.')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npmCommand, ['run', 'build'], {
  cwd: frontendRoot,
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
