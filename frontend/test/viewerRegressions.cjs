// Cross-platform, disposable workspace for real Electron UI regressions.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const frontend = path.join(root, 'frontend')
const python = path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'twill-viewer-qa-'))
const children = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise(resolve => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
const start = (command, args, env, label) => {
  const child = spawn(command, args, { cwd: frontend, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.output = ''
  child.stdout.on('data', chunk => { child.output += chunk })
  child.stderr.on('data', chunk => { child.output += chunk })
  child.on('error', error => { child.output += error.stack })
  child.label = label; children.push(child)
  return child
}
const ready = async (url, child) => {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error(child.output)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return } catch { /* starting */ }
    await pause(200)
  }
  throw Error('Server startup timed out: ' + child.output)
}
;(async () => {
  try {
    const backendPort = await freePort(), frontendPort = await freePort()
    const env = { ...process.env, NOTES_DIR: path.join(temp, 'twill-qa-notes'), NOTE_APP_SKILLBOOK_DIR: path.join(temp, 'skillbook'),
      NOTE_APP_BACKEND_PORT: String(backendPort), TWILL_QA_URL: 'http://127.0.0.1:' + frontendPort }
    const backend = start(python, [path.join(root, 'backend/desktop_main.py'), '--port', String(backendPort)], env, 'backend')
    await ready('http://127.0.0.1:' + backendPort + '/api/workspace', backend)
    const vite = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], env, 'vite')
    await ready(env.TWILL_QA_URL, vite)
    const requested = process.argv.slice(2)
    for (const file of requested.length ? requested : ['documentLifecycle.electron.cjs', 'documentLifecycle.electron.cjs', 'documentLifecycle.electron.cjs', 'userDocumentLinks.electron.cjs', 'imageClipboard.electron.cjs', 'documentInteraction.electron.cjs']) {
      const child = start(require('electron'), [path.join(__dirname, file)], env, file)
      const timer = setTimeout(() => child.kill(), 90000)
      const code = await new Promise(resolve => child.once('exit', resolve))
      clearTimeout(timer)
      process.stdout.write(child.output)
      if (code !== 0) throw Error(file + ' failed: ' + code + '\n' + child.output +
        '\nBackend (exit ' + backend.exitCode + '):\n' + backend.output.slice(-16000) +
        '\nVite (exit ' + vite.exitCode + '):\n' + vite.output.slice(-8000))
    }
  } finally {
    for (const child of children.reverse()) {
      fs.writeFileSync(path.join(temp, child.label + '.log'), child.output)
      if (child.exitCode !== null || !child.pid) continue
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      else child.kill('SIGTERM')
    }
    console.log('Viewer regression logs: ' + temp)
  }
})().catch(error => {
  console.error(error)
  if (process.env.GITHUB_ACTIONS) console.error('::error title=Viewer regressions::' + String(error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'))
  process.exitCode = 1
})
