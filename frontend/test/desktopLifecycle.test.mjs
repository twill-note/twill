import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { desktopRelaunchArgs, stopDesktopBackend } from '../electron/lifecycle.mjs'

function childProcess() {
  return Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null })
}

test('macOS restart waits for backend exit and cleans up its process group', async () => {
  const child = childProcess()
  const calls = []
  child.kill = (signal) => {
    calls.push(signal)
    setTimeout(() => { child.exitCode = 0; calls.push('exit'); child.emit('exit') }, 5)
  }
  await stopDesktopBackend({ child, owned: true, platform: 'darwin', killGroup: (pid, signal) => calls.push([pid, signal]) })
  assert.deepEqual(calls, ['SIGTERM', 'exit', [-123, 'SIGKILL']])
})

test('macOS shutdown kills a stuck backend after the grace period', async () => {
  const child = childProcess()
  child.kill = () => {}
  await stopDesktopBackend({ child, owned: true, platform: 'darwin', timeoutMs: 5, killGroup: () => {
    child.signalCode = 'SIGKILL'
    child.emit('exit')
  } })
  assert.equal(child.signalCode, 'SIGKILL')
})

test('Windows restart waits for taskkill to terminate the backend and Codex tree', async () => {
  const child = childProcess()
  let terminated = false
  await stopDesktopBackend({ child, owned: true, platform: 'win32', runCommand: async (...args) => {
    assert.deepEqual(args, ['taskkill.exe', ['/pid', '123', '/t', '/f'], 10000])
    await new Promise((resolve) => setTimeout(resolve, 5))
    terminated = true
  } })
  assert.equal(terminated, true)
})

test('shutdown failures prevent a successful relaunch and external backends are preserved', async () => {
  const child = childProcess()
  await assert.rejects(stopDesktopBackend({ child, owned: true, platform: 'win32', runCommand: async () => { throw new Error('denied') } }), /denied/)
  await stopDesktopBackend({ child, owned: false, platform: 'win32', runCommand: async () => assert.fail('external backend terminated') })
})

test('relaunch preserves development arguments and forces a fresh managed backend', () => {
  assert.deepEqual(desktopRelaunchArgs(['/Applications/Twill.app/Twill', '--fresh-backend']), ['--fresh-backend'])
  assert.deepEqual(desktopRelaunchArgs(['electron', '/project with spaces/electron/main.mjs', '--url=http://127.0.0.1:5173', '--no-backend']), ['/project with spaces/electron/main.mjs', '--url=http://127.0.0.1:5173', '--no-backend', '--fresh-backend'])
})
