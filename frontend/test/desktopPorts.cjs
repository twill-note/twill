// Isolated smoke test: npm run test:desktop-ports
// Set TWILL_QA_DESKTOP_EXECUTABLE to test an already packaged app instead.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
const close = (server) => new Promise(resolve => server.listening ? server.close(resolve) : resolve())

async function smoke(expectedPort) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twill-desktop-ports-'))
  const env = { ...process.env, NOTES_DIR: path.join(directory, 'notes'), NOTE_APP_SMOKE_USER_DATA: path.join(directory, 'profile') }
  for (const key of ['NOTE_APP_BACKEND_PORT', 'NOTE_APP_HOST', 'NOTE_APP_DESKTOP_URL', 'NOTE_APP_DESKTOP_MANAGE_BACKEND']) delete env[key]
  const packaged = process.env.TWILL_QA_DESKTOP_EXECUTABLE
  const executable = packaged || require('electron')
  const args = [...(packaged ? [] : ['electron/main.mjs']), '--smoke-test']
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  fs.writeFileSync(path.join(directory, 'smoke.log'), output)
  assert.equal(code, 0, output)
  const line = output.split('\n').find(line => line.startsWith('NOTE_DESKTOP_SMOKE '))
  assert.ok(line, output)
  const result = JSON.parse(line.slice('NOTE_DESKTOP_SMOKE '.length))
  assert.equal(result.main.settings.origin, `http://127.0.0.1:${expectedPort}`)
  assert.equal(result.main.rootMounted, true)
  console.log(JSON.stringify({ port: expectedPort, appMounted: true, log: path.join(directory, 'smoke.log') }))
}

;(async () => {
  await smoke(52023)
  const httpServer = http.createServer((_req, res) => { res.writeHead(503); res.end('Occupied') })
  const tcpServer = net.createServer(socket => socket.destroy())
  try {
    await listen(httpServer, 52023)
    await listen(tcpServer, 52024)
    await smoke(52025)
    assert.ok(httpServer.listening && tcpServer.listening, 'Other services must remain running')
    console.log(JSON.stringify({ httpCollision: true, nonHttpCollision: true, otherServicesPreserved: true }))
  } finally {
    await Promise.all([close(httpServer), close(tcpServer)])
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
