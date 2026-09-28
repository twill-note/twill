// Verify normal app exit releases Electron, the backend, AI and terminal children.
const assert = require('node:assert/strict')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startAppChildren(origin) {
  const terminalUrl = new URL('/api/terminal/ws', origin)
  terminalUrl.protocol = 'ws:'
  const terminal = new WebSocket(terminalUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Terminal did not connect')), 2000)
    terminal.onopen = () => {
      clearTimeout(timer)
      const command = process.platform === 'win32'
        ? 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 60"\r'
        : 'sleep 60 & sleep 60\r'
      terminal.send(JSON.stringify({ type: 'input', data: command }))
      resolve()
    }
    terminal.onerror = () => { clearTimeout(timer); reject(new Error('Terminal connection failed')) }
  })
  // Starts app-server without sending a model turn or requiring a login.
  void fetch(new URL('/api/ai/models', origin), { signal: AbortSignal.timeout(3000) }).catch(() => {})
  await delay(1000)
  return terminal
}

async function descendants(root) {
  let rows
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000 })
    rows = JSON.parse(stdout).map((row) => [row.ProcessId, row.ParentProcessId])
  } else {
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid='], { timeout: 3000 })
    rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
  }
  const owned = new Set([root])
  let previous = 0
  while (previous !== owned.size) {
    previous = owned.size
    for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid)
  }
  return [...owned]
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

;(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twill-shutdown-'))
  const packaged = process.env.TWILL_QA_DESKTOP_EXECUTABLE
  const executable = packaged || require('electron')
  const child = spawn(executable, [...(packaged ? [] : ['electron/main.mjs']), '--smoke-test', '--fresh-backend'], {
    env: { ...process.env, NOTES_DIR: path.join(directory, 'notes'),
      NOTE_APP_SKILLBOOK_DIR: path.join(directory, 'skillbook'),
      NOTE_APP_SMOKE_USER_DATA: path.join(directory, 'profile'), NOTE_APP_SMOKE_PAUSE_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  let snapshot
  let terminal
  const collect = (chunk) => {
    output += chunk
    const marker = output.match(/NOTE_DESKTOP_SMOKE ([^\n]+)\n/)
    if (!snapshot && marker) {
      const origin = JSON.parse(marker[1]).main.settings.origin
      snapshot = startAppChildren(origin).then(async (socket) => {
        terminal = socket
        return { pids: await descendants(child.pid) }
      }, (error) => ({ error })).catch((error) => ({ error }))
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    fs.writeFileSync(path.join(directory, 'shutdown.log'), output)
    assert.equal(code, 0, output)
    assert.ok(snapshot, 'No desktop smoke result received')
    const { pids, error } = await snapshot
    if (error) throw error
    assert.ok(pids.length > 1, 'No backend or renderer processes observed')
    let remaining = pids.filter(isAlive)
    for (let attempt = 0; remaining.length && attempt < 50; attempt++) {
      await delay(100)
      remaining = pids.filter(isAlive)
    }
    assert.deepEqual(remaining, [], `App processes remain running: ${remaining}`)
    assert.match(output, /Application shutdown complete/, 'Backend did not finish graceful shutdown')
    console.log(JSON.stringify({ platform: process.platform, packaged: Boolean(packaged),
      trackedProcesses: pids.length, remainingProcesses: 0, memoryReleased: true, log: path.join(directory, 'shutdown.log') }))
  } finally {
    clearTimeout(timer)
    terminal?.close()
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
