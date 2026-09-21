import { spawn } from 'node:child_process'
import { desktopRelaunchArgs, stopDesktopBackend } from './lifecycle.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron'

import {
  backendPortCandidates,
  backendPythonCandidates,
  desktopAppProfile,
  desktopCommandPath,
  desktopWindowChromeOptions,
  frontendRevisionFromHtml,
  isExpectedFrontendHtml,
  isSafeExternalUrl,
  parseDesktopOptions,
  popoutWindowBounds,
  restoredWindowBoundsForDrag,
  selectWslgOzonePlatform,
  versionedLocalAppUrl,
  windowBoundsFromResize,
  windowPositionFromDrag,
  windowsWorkAreaForDisplay,
} from './runtime.mjs'
import {
  localStorageSnapshotFileName,
  readLocalStorageSnapshot,
  writeLocalStorageSnapshot,
} from './local-storage.mjs'

const isWslg = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME && process.env.DISPLAY)

// macOS의 Finder/Launchpad 앱에는 Homebrew 경로가 보통 빠져 있다. 이 값은 이후
// 시작되는 Python 백엔드와 codex app-server 자식 프로세스까지 그대로 상속된다.
const commandPath = desktopCommandPath(process.env.PATH, process.platform, os.homedir())
if (commandPath) process.env.PATH = commandPath

const desktopProfile = desktopAppProfile(app.isPackaged, app.getPath('appData'))
app.setName(desktopProfile.name)
if (desktopProfile.userDataPath) app.setPath('userData', desktopProfile.userDataPath)

function detectDrmRenderNode() {
  if (process.platform !== 'linux') return false
  try {
    return fs.readdirSync('/dev/dri').some((entry) => entry.startsWith('renderD'))
  } catch {
    return false
  }
}

const hasDrmRenderNode = detectDrmRenderNode()
const wslgOzonePlatform = selectWslgOzonePlatform({
  isWslg,
  waylandDisplay: process.env.WAYLAND_DISPLAY,
  hasDrmRenderNode,
})
const useWslgWayland = wslgOzonePlatform === 'wayland'

// Electron의 Wayland 경로는 DRM render node 없이 실행되면 WSLg에서 창 표면이
// 투명한 채 갱신되지 않는다. 실제 render node가 있을 때만 Wayland를 사용하고,
// /dev/dxg만 제공되는 환경에서는 화면 표시가 안정적인 XWayland로 폴백한다.
if (isWslg) {
  app.commandLine.appendSwitch('ozone-platform', wslgOzonePlatform)
}

const electronDir = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(electronDir, '..')
const projectRoot = path.resolve(process.env.NOTE_APP_PROJECT_ROOT || path.join(frontendRoot, '..'))
const backendRoot = path.join(projectRoot, 'backend')
const packagedBackendName = process.platform === 'win32' ? 'twill-backend.exe' : 'twill-backend'
const packagedBackend = path.join(process.resourcesPath, 'backend', 'twill-backend', packagedBackendName)
const packagedCodexName = process.platform === 'win32' ? 'codex.exe' : 'codex'
const packagedCodex = path.join(process.resourcesPath, 'codex-runtime', 'bin', packagedCodexName)
const frontendDist = path.resolve(process.env.NOTE_APP_FRONTEND_DIST || (
  app.isPackaged ? path.join(process.resourcesPath, 'frontend-dist') : path.join(frontendRoot, 'dist')
))
const appIconPath = path.join(electronDir, 'assets', 'twill-icon.png')
const options = parseDesktopOptions(process.argv.slice(2))
const smokeTest = process.argv.includes('--smoke-test')
const smokeUserData = smokeTest ? process.env.NOTE_APP_SMOKE_USER_DATA?.trim() : ''
if (smokeUserData) app.setPath('userData', path.resolve(smokeUserData))

let appUrl = options.uiUrl
let backendProcess = null
let backendOwned = false
let backendReady = false
let quitting = false
let shutdownComplete = false
let restartRequested = false
let mainWindow = null
let quickMemoWindow = null
let byeoriWindow = null
const normalWindowBounds = new WeakMap()
const manuallyMaximizedWindows = new WeakSet()
const windowMaximizeTransitions = new WeakSet()
const windowMoveSessions = new WeakMap()
const windowResizeSessions = new WeakMap()
const windowMoveSampleMs = 16
const windowMoveAckTimeoutMs = 32
const windowResizeSampleMs = 16
const windowResizeAckTimeoutMs = 32
let windowsScreenInfoPromise = null
let backendLog = ''
let frontendRevision = null

function rendererUrl(relativePath = '/') {
  return versionedLocalAppUrl(appUrl, relativePath, frontendRevision)
}

/**
 * 앱 삭제·재설치로는 Chromium의 사용자 데이터 캐시가 없어지지 않는다. UI 빌드가
 * 달라졌을 때 네트워크 캐시만 비우고 localStorage와 세션 설정은 그대로 보존한다.
 * URL에도 같은 리비전을 붙이므로 캐시 삭제가 실패해도 이전 index.html을 쓰지 않는다.
 */
async function refreshFrontendCacheIfNeeded() {
  if (!frontendRevision) return false
  const markerPath = path.join(app.getPath('userData'), 'frontend-revision')
  let previousRevision = null
  try {
    previousRevision = fs.readFileSync(markerPath, 'utf8').trim() || null
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[desktop] UI 캐시 리비전을 읽지 못했습니다.', error)
  }
  if (previousRevision === frontendRevision) return false

  try {
    await session.defaultSession.clearCache()
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, `${frontendRevision}\n`, { mode: 0o600 })
    console.log(`[desktop] UI 캐시를 새 빌드로 갱신했습니다: ${previousRevision || 'none'} -> ${frontendRevision}`)
    return true
  } catch (error) {
    console.warn('[desktop] 이전 UI 네트워크 캐시를 비우지 못했습니다. 리비전 URL로 계속합니다.', error)
    return false
  }
}

function appendBackendLog(chunk) {
  const text = chunk.toString()
  backendLog = (backendLog + text).slice(-12_000)
  process.stderr.write(`[backend] ${text}`)
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

async function endpointResponds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

async function probeNoteFrontend(baseUrl, expectedHtml = null) {
  try {
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) })
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) return false
    const html = await response.text()
    return isExpectedFrontendHtml(html, expectedHtml)
  } catch {
    return false
  }
}

async function waitForBackend(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (backendProcess?.exitCode !== null) {
      throw new Error(`백엔드가 시작 중 종료되었습니다.\n\n${backendLog.trim()}`)
    }
    if (await probe(`${baseUrl}/api/workspace`)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`백엔드 시작 시간이 초과되었습니다.\n\n${backendLog.trim()}`)
}

function resolvePython() {
  for (const candidate of backendPythonCandidates(projectRoot)) {
    if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) return candidate
  }
  throw new Error('백엔드 Python을 찾을 수 없습니다. 먼저 setup 스크립트를 실행하세요.')
}

async function startOrReuseBackend() {
  const frontendIndex = path.join(frontendDist, 'index.html')
  if (!fs.existsSync(frontendIndex)) {
    throw new Error('프런트엔드 빌드가 없습니다. npm run build 후 다시 실행하세요.')
  }
  const expectedFrontendHtml = fs.readFileSync(frontendIndex, 'utf8')
  frontendRevision = frontendRevisionFromHtml(expectedFrontendHtml)
  let selected = null
  for (const port of backendPortCandidates(options.backendPort)) {
    const candidate = `http://${options.backendHost}:${port}`
    if (await probe(`${candidate}/api/workspace`)) {
      if (!process.argv.includes('--fresh-backend') && await probeNoteFrontend(candidate, expectedFrontendHtml)) {
        console.log(`[desktop] 실행 중인 백엔드를 재사용합니다: ${candidate}`)
        return candidate
      }
      console.warn(`[desktop] 현재 빌드와 다른 화면을 제공하는 기존 백엔드를 건너뜁니다: ${candidate}`)
      continue
    }
    if (await endpointResponds(candidate)) continue
    selected = { baseUrl: candidate, port }
    break
  }
  if (!selected) throw new Error('사용 가능한 로컬 백엔드 포트를 찾지 못했습니다.')
  const { baseUrl, port } = selected

  const command = app.isPackaged ? packagedBackend : resolvePython()
  const commandArgs = app.isPackaged
    ? ['--host', options.backendHost, '--port', String(port)]
    : ['-m', 'uvicorn', 'app.main:app', '--host', options.backendHost, '--port', String(port)]
  if (app.isPackaged && !fs.existsSync(command)) {
    throw new Error(`패키지에 백엔드 실행 파일이 없습니다: ${command}`)
  }
  backendProcess = spawn(
    command,
    commandArgs,
    {
      cwd: app.isPackaged ? path.dirname(packagedBackend) : backendRoot,
      env: {
        ...process.env,
        ...(app.isPackaged && !process.env.NOTES_DIR ? { NOTES_DIR: path.join(app.getPath('documents'), 'Twill') } : {}),
        ...(app.isPackaged && fs.existsSync(packagedCodex) ? { TWILL_BUNDLED_CODEX_BINARY: packagedCodex } : {}),
        TWILL_CODEX_MANAGED_DIR: path.join(app.getPath('userData'), 'codex-runtime'),
        NOTE_APP_FRONTEND_DIST: frontendDist,
        NOTE_APP_DESKTOP: '1',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  )
  backendOwned = true
  backendProcess.stdout.on('data', appendBackendLog)
  backendProcess.stderr.on('data', appendBackendLog)
  backendProcess.once('error', (error) => appendBackendLog(error.stack || error.message))
  backendProcess.once('exit', (code, signal) => {
    if (!quitting && backendReady) {
      dialog.showErrorBox(
        'Twill 백엔드 종료',
        `백엔드가 예기치 않게 종료되었습니다 (${signal || code}).\n\n${backendLog.trim()}`,
      )
      app.quit()
    }
  })

  await waitForBackend(baseUrl)
  backendReady = true
  return baseUrl
}

async function stopBackend() {
  await stopDesktopBackend({
    child: backendProcess, owned: backendOwned, platform: process.platform,
    runCommand: readProcessOutput, killGroup: (pid, signal) => process.kill(pid, signal),
  })
}

function readProcessOutput(command, args, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`${command} 실행 시간이 초과되었습니다.`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-64_000) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_000) })
    child.once('error', (error) => {
      finish(reject, error)
    })
    child.once('exit', (code) => {
      if (code === 0) finish(resolve, stdout)
      else finish(reject, new Error(stderr.trim() || `${command} 종료 코드: ${code}`))
    })
  })
}

async function loadWindowsScreenInfo() {
  if (!isWslg || useWslgWayland) return []
  if (!windowsScreenInfoPromise) {
    const powershell = fs.existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
      ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
      : 'powershell.exe'
    const script = 'Add-Type -AssemblyName System.Windows.Forms; @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height; boundsX = $_.Bounds.X; boundsY = $_.Bounds.Y; boundsWidth = $_.Bounds.Width; boundsHeight = $_.Bounds.Height } }) | ConvertTo-Json -Compress'
    windowsScreenInfoPromise = readProcessOutput(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
    ).then((output) => {
      const parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim())
      const screens = Array.isArray(parsed) ? parsed : [parsed]
      return screens.filter((item) => [
        item.x,
        item.y,
        item.width,
        item.height,
        item.boundsX,
        item.boundsY,
        item.boundsWidth,
        item.boundsHeight,
      ].every(Number.isFinite))
    }).catch((error) => {
      console.warn('[desktop] Windows 작업 영역을 읽지 못했습니다.', error.message)
      return []
    })
  }
  return windowsScreenInfoPromise
}

async function workAreaForWindow(window) {
  const display = screen.getDisplayMatching(window.getBounds())
  if (!isWslg || useWslgWayland) return display.workArea
  const windowsScreens = await loadWindowsScreenInfo()
  return windowsWorkAreaForDisplay(display, screen.getAllDisplays(), windowsScreens) ?? display.workArea
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function localStorageSnapshotPath() {
  return path.join(app.getPath('userData'), localStorageSnapshotFileName)
}

function installLocalStoragePersistence() {
  ipcMain.on('desktop:local-storage-load', (event) => {
    event.returnValue = readLocalStorageSnapshot(localStorageSnapshotPath())
  })
  ipcMain.on('desktop:local-storage-save', (event, snapshot) => {
    try {
      writeLocalStorageSnapshot(localStorageSnapshotPath(), snapshot)
      event.returnValue = true
    } catch (error) {
      console.warn('[desktop] 앱 설정 파일을 저장하지 못했습니다.', error)
      event.returnValue = false
    }
  })
}

function readWindowBounds() {
  try {
    const bounds = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'))
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea
    const visible = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
    return visible ? bounds : null
  } catch {
    return null
  }
}

function centeredDefaultBounds(display) {
  const area = display.workArea
  const width = Math.min(1440, Math.max(Math.min(1000, area.width), Math.floor(area.width * 0.9)))
  // WSLg는 Windows 작업 표시줄을 workArea에서 제외하지 않으므로 세로 여유를 조금 더 둔다.
  const heightRatio = isWslg ? 0.88 : 0.9
  const height = Math.min(920, Math.max(Math.min(680, area.height), Math.floor(area.height * heightRatio)))
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  }
}

function clampBoundsToDisplay(bounds, display) {
  const area = display.workArea
  const width = Math.min(Math.max(bounds.width, Math.min(1000, area.width)), area.width)
  const height = Math.min(Math.max(bounds.height, Math.min(680, area.height)), area.height)
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

function initialWindowBounds() {
  const smokeDisplayX = Number.parseInt(process.env.NOTE_APP_SMOKE_DISPLAY_X || '', 10)
  const currentDisplay = Number.isFinite(smokeDisplayX)
    ? screen.getDisplayNearestPoint({ x: smokeDisplayX, y: 1 })
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const savedBounds = readWindowBounds()
  // WSLg의 일반 창 좌표는 모니터별 로컬 좌표로 돌아와 저장 좌표의 디스플레이 판별이 틀릴 수 있다.
  // 매 실행 시 커서가 있는 모니터에 안전한 기본 크기로 여는 편이 예측 가능하다.
  if (isWslg || !savedBounds || screen.getDisplayMatching(savedBounds).id !== currentDisplay.id) {
    return { bounds: centeredDefaultBounds(currentDisplay), display: currentDisplay }
  }
  return { bounds: clampBoundsToDisplay(savedBounds, currentDisplay), display: currentDisplay }
}

function isWindowMaximized(window) {
  return manuallyMaximizedWindows.has(window) || window.isMaximized()
}

function notifyWindowMaximized(window) {
  if (!window.isDestroyed()) window.webContents.send('desktop:maximized-changed', isWindowMaximized(window))
}

function saveWindowBounds(window) {
  if (smokeTest || !window || window.isDestroyed() || isWindowMaximized(window) || window.isFullScreen()) return
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(window.getBounds()))
  } catch (error) {
    console.warn('창 위치를 저장하지 못했습니다.', error)
  }
}

function installNavigationPolicy(window) {
  const localOrigin = new URL(appUrl).origin
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false
    try {
      sameOrigin = new URL(url).origin === localOrigin
    } catch {
      // 잘못된 URL은 아래에서 차단한다.
    }
    if (!sameOrigin) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })
}

function commonWindowOptions() {
  return {
    backgroundColor: '#282a36',
    icon: appIconPath,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(electronDir, 'preload.cjs'),
    },
  }
}

function attachWindowStateEvents(window) {
  window.on('maximize', () => notifyWindowMaximized(window))
  window.on('unmaximize', () => notifyWindowMaximized(window))
  window.on('blur', () => {
    stopWindowMove(window)
    stopWindowResize(window)
  })
}

async function toggleWindowMaximize(window) {
  if (windowMaximizeTransitions.has(window)) return false
  stopWindowMove(window)
  stopWindowResize(window)
  windowMaximizeTransitions.add(window)
  try {
    if (manuallyMaximizedWindows.has(window)) {
      const restoreBounds = normalWindowBounds.get(window)
      manuallyMaximizedWindows.delete(window)
      window.setResizable(true)
      if (restoreBounds) window.setBounds(restoreBounds)
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (restoreBounds && !window.isDestroyed()) window.setBounds(restoreBounds)
      notifyWindowMaximized(window)
      return true
    }

    if (isWslg && !useWslgWayland) {
      const restoreBounds = window.getBounds()
      const workArea = await workAreaForWindow(window)
      if (window.isDestroyed()) return false
      normalWindowBounds.set(window, restoreBounds)
      manuallyMaximizedWindows.add(window)
      window.setResizable(false)
      window.setBounds(workArea)
      // XWayland는 resizable 힌트를 반영하는 비동기 configure 과정에서 직전 좌표를
      // 다시 적용할 수 있다. 힌트가 안정된 뒤 목표 작업 영역을 한 번 더 확정한다.
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (!window.isDestroyed()) window.setBounds(workArea)
      notifyWindowMaximized(window)
      return true
    }

    if (window.isMaximized()) {
      window.unmaximize()
      const restoreBounds = normalWindowBounds.get(window)
      if (restoreBounds && !useWslgWayland) {
        setTimeout(() => {
          if (!window.isDestroyed() && !window.isMaximized()) window.setBounds(restoreBounds)
        }, 100)
      }
    } else {
      normalWindowBounds.set(window, window.getBounds())
      window.maximize()
    }
    return true
  } finally {
    windowMaximizeTransitions.delete(window)
  }
}

function clearMoveAcknowledgement(session) {
  if (!session.ackTimer) return
  clearTimeout(session.ackTimer)
  session.ackTimer = null
}

function clearQueuedWindowMove(session) {
  if (!session.applyImmediate) return
  clearImmediate(session.applyImmediate)
  session.applyImmediate = null
}

function queueWindowMove(window, session) {
  if (session.applyImmediate || window.isDestroyed()) return
  session.applyImmediate = setImmediate(() => {
    session.applyImmediate = null
    applyWindowMove(window, session)
  })
  session.applyImmediate.unref()
}

function applyWindowMove(window, session, force = false) {
  if (window.isDestroyed() || (session.awaitingMove && !force)) return
  const position = windowPositionFromDrag(session.cursor, session.bounds, screen.getCursorScreenPoint())
  if (!position || (position.x === session.lastPosition.x && position.y === session.lastPosition.y)) return

  session.lastPosition = position
  if (!force) {
    session.awaitingMove = true
    clearMoveAcknowledgement(session)
    session.ackTimer = setTimeout(() => {
      session.ackTimer = null
      session.awaitingMove = false
      queueWindowMove(window, session)
    }, windowMoveAckTimeoutMs)
    session.ackTimer.unref()
  }
  window.setPosition(position.x, position.y, false)
}

function stopWindowMove(window, applyFinalPosition = false) {
  const session = windowMoveSessions.get(window)
  if (!session) return
  if (applyFinalPosition && !window.isDestroyed()) {
    session.awaitingMove = false
    applyWindowMove(window, session, true)
  }
  clearInterval(session.sampleTimer)
  clearMoveAcknowledgement(session)
  clearQueuedWindowMove(session)
  window.removeListener('move', session.onMoved)
  windowMoveSessions.delete(window)
}

function beginWindowMove(event) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return
  stopWindowResize(window)
  stopWindowMove(window)

  const cursor = screen.getCursorScreenPoint()
  let bounds = window.getBounds()
  if (isWindowMaximized(window)) {
    const display = screen.getDisplayNearestPoint(cursor)
    const restoreBounds = normalWindowBounds.get(window) ?? centeredDefaultBounds(display)
    const restoredBounds = restoredWindowBoundsForDrag(
      cursor,
      bounds,
      restoreBounds,
      display.workArea,
    )
    if (!restoredBounds) return

    if (manuallyMaximizedWindows.has(window)) {
      manuallyMaximizedWindows.delete(window)
      window.setResizable(true)
    } else if (window.isMaximized()) {
      window.unmaximize()
    }
    window.setBounds(restoredBounds)
    normalWindowBounds.set(window, restoredBounds)
    bounds = restoredBounds
    notifyWindowMaximized(window)
  }

  const session = {
    cursor,
    bounds,
    lastPosition: { x: bounds.x, y: bounds.y },
    awaitingMove: false,
    ackTimer: null,
    applyImmediate: null,
    sampleTimer: null,
    onMoved: null,
  }
  session.onMoved = () => {
    if (windowMoveSessions.get(window) !== session) return
    clearMoveAcknowledgement(session)
    session.awaitingMove = false
    queueWindowMove(window, session)
  }
  session.sampleTimer = setInterval(() => applyWindowMove(window, session), windowMoveSampleMs)
  session.sampleTimer.unref()
  window.on('move', session.onMoved)
  windowMoveSessions.set(window, session)
}

function endWindowMove(event) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window) stopWindowMove(window, true)
}

function clearResizeAcknowledgement(session) {
  if (!session.ackTimer) return
  clearTimeout(session.ackTimer)
  session.ackTimer = null
}

function clearQueuedWindowResize(session) {
  if (!session.applyImmediate) return
  clearImmediate(session.applyImmediate)
  session.applyImmediate = null
}

function queueWindowResize(window, session) {
  if (session.applyImmediate || window.isDestroyed()) return
  session.applyImmediate = setImmediate(() => {
    session.applyImmediate = null
    applyWindowResize(window, session)
  })
  session.applyImmediate.unref()
}

function applyWindowResize(window, session, force = false) {
  if (window.isDestroyed() || (session.awaitingResize && !force)) return
  const hasFreshRendererPoint = session.currentCursor && Date.now() - session.cursorUpdatedAt < 100
  const bounds = windowBoundsFromResize(
    hasFreshRendererPoint ? session.cursor : session.physicalCursor,
    session.bounds,
    hasFreshRendererPoint ? session.currentCursor : screen.getCursorScreenPoint(),
    session.direction,
    session.minimumSize,
  )
  if (!bounds || Object.keys(bounds).every((key) => bounds[key] === session.lastBounds[key])) return

  session.lastBounds = bounds
  if (!force) {
    session.awaitingResize = true
    clearResizeAcknowledgement(session)
    session.ackTimer = setTimeout(() => {
      session.ackTimer = null
      session.awaitingResize = false
      queueWindowResize(window, session)
    }, windowResizeAckTimeoutMs)
    session.ackTimer.unref()
  }
  window.setBounds(bounds, false)
}

function stopWindowResize(window, applyFinalBounds = false) {
  const session = windowResizeSessions.get(window)
  if (!session) return
  if (applyFinalBounds && !window.isDestroyed()) {
    session.awaitingResize = false
    applyWindowResize(window, session, true)
  }
  clearInterval(session.sampleTimer)
  clearResizeAcknowledgement(session)
  clearQueuedWindowResize(session)
  window.removeListener('resize', session.onConfigured)
  window.removeListener('move', session.onConfigured)
  windowResizeSessions.delete(window)
}

function validScreenPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : null
}

function beginWindowResize(event, direction, rendererPoint) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || isWindowMaximized(window) || !window.isResizable()) return
  const minimum = window.getMinimumSize()
  const bounds = window.getBounds()
  const cursor = validScreenPoint(rendererPoint)
  const physicalCursor = screen.getCursorScreenPoint()
  const session = {
    cursor: cursor ?? physicalCursor,
    currentCursor: cursor,
    cursorUpdatedAt: cursor ? Date.now() : 0,
    physicalCursor,
    bounds,
    direction,
    minimumSize: { width: minimum[0], height: minimum[1] },
    lastBounds: bounds,
    awaitingResize: false,
    ackTimer: null,
    applyImmediate: null,
    sampleTimer: null,
    onConfigured: null,
  }
  // runtime helper가 유효하지 않은 방향을 거부하도록 같은 검증 경로를 사용한다.
  if (!windowBoundsFromResize(session.cursor, bounds, session.cursor, direction, session.minimumSize)) return

  stopWindowMove(window)
  stopWindowResize(window)
  session.onConfigured = () => {
    if (windowResizeSessions.get(window) !== session) return
    clearResizeAcknowledgement(session)
    session.awaitingResize = false
    queueWindowResize(window, session)
  }
  session.sampleTimer = setInterval(() => applyWindowResize(window, session), windowResizeSampleMs)
  session.sampleTimer.unref()
  window.on('resize', session.onConfigured)
  window.on('move', session.onConfigured)
  windowResizeSessions.set(window, session)
}

function updateWindowResize(event, rendererPoint) {
  const window = BrowserWindow.fromWebContents(event.sender)
  const session = window && windowResizeSessions.get(window)
  const point = validScreenPoint(rendererPoint)
  if (!window || !session || !point) return
  session.currentCursor = point
  session.cursorUpdatedAt = Date.now()
  queueWindowResize(window, session)
}

function endWindowResize(event, rendererPoint) {
  const window = BrowserWindow.fromWebContents(event.sender)
  const session = window && windowResizeSessions.get(window)
  const point = validScreenPoint(rendererPoint)
  if (session && point) {
    session.currentCursor = point
    session.cursorUpdatedAt = Date.now()
  }
  if (window) stopWindowResize(window, true)
}

async function waitForDocumentFonts(window) {
  try {
    await window.webContents.executeJavaScript(`document.fonts
      ? Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2500))]).then(() => true)
      : true`)
  } catch {
    // 폰트 준비 API를 지원하지 않는 환경에서도 창은 정상적으로 표시한다.
  }
}

function waitForWindowEvent(window, eventName, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      window.removeListener(eventName, finish)
      resolve()
    }, timeoutMs)
    window.once(eventName, finish)
  })
}

async function placeWslgWindowOnCursorDisplay(window) {
  if (!useWslgWayland) return
  const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const currentDisplay = screen.getDisplayMatching(window.getBounds())
  if (currentDisplay.id === targetDisplay.id) return

  // Wayland는 setBounds/setPosition을 허용하지 않는다. 최대화는 활성 모니터를 따르므로,
  // 표시 직후 최대화→복원해 최초 창을 커서가 있는 모니터에 정착시킨다.
  const maximized = waitForWindowEvent(window, 'maximize')
  window.maximize()
  await maximized
  await new Promise((resolve) => setTimeout(resolve, 150))
  const restored = waitForWindowEvent(window, 'unmaximize')
  window.unmaximize()
  await restored
  await new Promise((resolve) => setTimeout(resolve, 250))
}

async function createMainWindow() {
  const initial = initialWindowBounds()
  if (isWslg && !useWslgWayland) void loadWindowsScreenInfo()
  mainWindow = new BrowserWindow({
    ...commonWindowOptions(),
    ...initial.bounds,
    minWidth: Math.min(1000, initial.display.workArea.width),
    minHeight: Math.min(680, initial.display.workArea.height),
    ...desktopWindowChromeOptions(),
    resizable: true,
    title: 'Twill',
  })
  installNavigationPolicy(mainWindow)
  attachWindowStateEvents(mainWindow)
  mainWindow.on('close', () => {
    stopWindowMove(mainWindow)
    stopWindowResize(mainWindow)
    saveWindowBounds(mainWindow)
  })
  mainWindow.on('closed', () => { mainWindow = null })
  const smokeNote = smokeTest ? process.env.NOTE_APP_SMOKE_NOTE : ''
  const initialUrlObject = new URL(rendererUrl('/'))
  if (smokeNote) initialUrlObject.hash = encodeURIComponent(smokeNote)
  const initialUrl = initialUrlObject.toString()
  await mainWindow.loadURL(initialUrl)
  await waitForDocumentFonts(mainWindow)
  if (!smokeTest || process.env.NOTE_APP_SMOKE_SHOW === '1') {
    mainWindow.show()
    if (useWslgWayland) await placeWslgWindowOnCursorDisplay(mainWindow)
    else if (isWslg) mainWindow.setBounds(initial.bounds)
  }
}

function isByeoriWindowOpen() {
  return Boolean(byeoriWindow && !byeoriWindow.isDestroyed())
}

function notifyByeoriWindowChanged(open) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('desktop:byeori-window-changed', open)
    }
  }
}

function focusByeoriWindow() {
  if (!isByeoriWindowOpen()) return false
  if (byeoriWindow.isMinimized()) byeoriWindow.restore()
  byeoriWindow.show()
  byeoriWindow.focus()
  return true
}

async function openByeoriWindow(_event, rendererPoint) {
  if (focusByeoriWindow()) return true

  const anchor = validScreenPoint(rendererPoint) ?? screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(anchor)
  const bounds = popoutWindowBounds(anchor, display.workArea)
  if (!bounds) throw new Error('Twill AI 분리 창의 위치를 계산하지 못했습니다.')

  byeoriWindow = new BrowserWindow({
    ...commonWindowOptions(),
    ...bounds,
    minWidth: Math.min(420, bounds.width),
    minHeight: Math.min(520, bounds.height),
    ...desktopWindowChromeOptions(),
    resizable: true,
    title: 'Twill AI · Twill',
  })
  const createdWindow = byeoriWindow
  installNavigationPolicy(createdWindow)
  attachWindowStateEvents(createdWindow)
  createdWindow.on('close', () => {
    stopWindowMove(createdWindow)
    stopWindowResize(createdWindow)
  })
  createdWindow.on('closed', () => {
    if (byeoriWindow === createdWindow) byeoriWindow = null
    notifyByeoriWindowChanged(false)
  })

  try {
    await createdWindow.loadURL(rendererUrl('/?window=byeori'))
    await waitForDocumentFonts(createdWindow)
    createdWindow.show()
    if (useWslgWayland) await placeWslgWindowOnCursorDisplay(createdWindow)
    else if (isWslg) createdWindow.setBounds(bounds)
    notifyByeoriWindowChanged(true)
    return true
  } catch (error) {
    if (!createdWindow.isDestroyed()) createdWindow.destroy()
    throw error
  }
}

async function ensureMainWindowVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) await createMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

async function reattachByeoriWindow() {
  const target = await ensureMainWindowVisible()
  if (!target) return false
  target.webContents.send('desktop:show-byeori-dock')
  const detached = byeoriWindow
  if (detached && !detached.isDestroyed()) {
    const closeDetached = setImmediate(() => {
      if (!detached.isDestroyed()) detached.close()
    })
    closeDetached.unref()
  }
  return true
}

async function openDocumentInMain(_event, target) {
  const kind = target?.kind
  const documentPath = typeof target?.path === 'string' ? target.path.trim() : ''
  if (!['note', 'erd'].includes(kind) || !documentPath || documentPath.length > 4096) return false
  const window = await ensureMainWindowVisible()
  if (!window) return false
  window.webContents.send('desktop:open-main-document', { kind, path: documentPath })
  return true
}

async function openQuickMemo() {
  if (quickMemoWindow && !quickMemoWindow.isDestroyed()) {
    quickMemoWindow.show()
    quickMemoWindow.focus()
    return
  }
  quickMemoWindow = new BrowserWindow({
    ...commonWindowOptions(),
    backgroundColor: '#eef1ff',
    width: 480,
    height: 390,
    minWidth: 420,
    minHeight: 320,
    resizable: true,
    title: '빠른 메모',
  })
  installNavigationPolicy(quickMemoWindow)
  quickMemoWindow.once('ready-to-show', () => {
    if (!smokeTest) quickMemoWindow?.show()
  })
  quickMemoWindow.on('closed', () => { quickMemoWindow = null })
  await quickMemoWindow.loadURL(rendererUrl('/quick-memo.html'))
}

async function runSmokeTest() {
  let singleActivationResult = null
  if (process.env.NOTE_APP_SMOKE_NOTE) {
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
      const target = decodeURIComponent(window.location.hash.slice(1))
      const parts = target.split('/')
      for (let index = 0; index < parts.length; index += 1) {
        const path = parts.slice(0, index + 1).join('/')
        const deadline = Date.now() + 5000
        let row
        while (!row && Date.now() < deadline) {
          row = Array.from(document.querySelectorAll('[title], [data-desktop-tooltip]'))
            .find((element) => (element.getAttribute('title') || element.getAttribute('data-desktop-tooltip')) === path)
          if (!row) await sleep(100)
        }
        row?.click()
        await sleep(120)
      }
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const editor = document.querySelector('.bn-default-styles')
        if ((editor?.textContent || '').trim()) break
        await sleep(100)
      }
      return true
    })()`)
  }
  if (process.env.NOTE_APP_SMOKE_OPEN_DDL_EXPORT === '1') {
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
      const deadline = Date.now() + 10000
      let button
      while (!button && Date.now() < deadline) {
        button = Array.from(document.querySelectorAll('button'))
          .find((element) => (element.textContent || '').includes('DDL 내보내기'))
        if (!button) await sleep(100)
      }
      button?.click()
      while (Date.now() < deadline) {
        const title = Array.from(document.querySelectorAll('h3'))
          .find((element) => (element.textContent || '').includes('MariaDB SQL DDL 내보내기'))
        if (title) return true
        await sleep(100)
      }
      return false
    })()`)
  }
  if (process.env.NOTE_APP_SMOKE_TEST_SINGLE_ACTIVATION === '1') {
    const target = await mainWindow.webContents.executeJavaScript(`(() => {
      window.__twillSingleActivationClicks = []
      document.addEventListener('click', (event) => {
        window.__twillSingleActivationClicks.push({
          detail: event.detail,
          testId: event.target?.closest?.('[data-testid]')?.getAttribute('data-testid') || null,
        })
      }, { capture: true })
      const button = document.querySelector('[data-testid="workspace-settings-button"]')
      const rect = button?.getBoundingClientRect()
      return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
    })()`)
    if (target) {
      const sendClick = (clickCount) => {
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...target })
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount })
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount })
      }
      sendClick(1)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const afterSingle = await mainWindow.webContents.executeJavaScript(`({
        open: Boolean(document.querySelector('[data-testid="workspace-settings-dialog"]')),
        clicks: window.__twillSingleActivationClicks.slice(),
      })`)
      sendClick(2)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const afterRapidRepeat = await mainWindow.webContents.executeJavaScript(`({
        open: Boolean(document.querySelector('[data-testid="workspace-settings-dialog"]')),
        clicks: window.__twillSingleActivationClicks.slice(),
      })`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 80 })
      mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 8, y: 80, button: 'left', clickCount: 1 })
      mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 8, y: 80, button: 'left', clickCount: 1 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const afterIntentionalDismiss = await mainWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('[data-testid="workspace-settings-dialog"]'))`,
      )
      singleActivationResult = { target, afterSingle, afterRapidRepeat, openAfterIntentionalDismiss: afterIntentionalDismiss }
    } else {
      singleActivationResult = { error: 'settings button not found' }
    }
  }
  const displayBefore = screen.getDisplayMatching(mainWindow.getBounds())
  const cursorPoint = screen.getCursorScreenPoint()
  const expectedWorkArea = await workAreaForWindow(mainWindow)
  const windowControlsResult = {
    before: { maximized: isWindowMaximized(mainWindow), bounds: mainWindow.getBounds() },
    nativeBackground: mainWindow.getBackgroundColor(),
    rendering: {
      ozonePlatform: wslgOzonePlatform ?? 'system-default',
      hasDrmRenderNode,
    },
    display: { id: displayBefore.id, bounds: displayBefore.bounds, workArea: displayBefore.workArea, scaleFactor: displayBefore.scaleFactor },
    cursorPoint,
    expectedWorkArea,
    cursorDisplay: screen.getDisplayNearestPoint(cursorPoint),
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
    })),
  }
  await mainWindow.webContents.executeJavaScript(`document.querySelector('.desktop-titlebar__drag-area')
    ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const toggledBounds = mainWindow.getBounds()
  const toggledDisplay = screen.getDisplayMatching(toggledBounds)
  windowControlsResult.toggled = {
    maximized: isWindowMaximized(mainWindow),
    bounds: toggledBounds,
    display: { id: toggledDisplay.id, bounds: toggledDisplay.bounds, workArea: toggledDisplay.workArea },
    contentBounds: mainWindow.getContentBounds(),
    renderer: await mainWindow.webContents.executeJavaScript(`({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      resizeHandleCount: document.querySelectorAll('[data-desktop-resize-handle]').length,
      controls: Array.from(document.querySelectorAll('.desktop-titlebar__control')).map((control) => {
        const rect = control.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          label: control.getAttribute('aria-label'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          hitLabel: hit?.closest('.desktop-titlebar__control')?.getAttribute('aria-label') || null,
        }
      }),
    })`),
  }
  const holdMaximizedMs = Math.min(Math.max(Number.parseInt(process.env.NOTE_APP_SMOKE_HOLD_MAXIMIZED_MS || '0', 10) || 0, 0), 30_000)
  if (holdMaximizedMs) await new Promise((resolve) => setTimeout(resolve, holdMaximizedMs))
  await mainWindow.webContents.executeJavaScript(`document.querySelector('.desktop-titlebar__drag-area')
    ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  windowControlsResult.restored = { maximized: isWindowMaximized(mainWindow), bounds: mainWindow.getBounds() }
  if (process.env.NOTE_APP_SMOKE_TEST_RESIZE === '1') {
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const deadline = Date.now() + 2000
      const ready = () => {
        if (document.querySelectorAll('[data-desktop-resize-handle]').length === 8 || Date.now() >= deadline) resolve()
        else requestAnimationFrame(ready)
      }
      ready()
    })`)
    const beforeResize = mainWindow.getBounds()
    const start = { x: beforeResize.width - 2, y: beforeResize.height - 2 }
    const target = { x: start.x - 120, y: start.y - 80 }
    const cursorChanges = []
    const recordCursor = (_event, type) => cursorChanges.push(type)
    mainWindow.webContents.on('cursor-changed', recordCursor)
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__noteResizeSmokeEvents = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) {
        document.addEventListener(type, (event) => window.__noteResizeSmokeEvents.push({
          type,
          target: event.target?.getAttribute?.('data-desktop-resize-handle') || null,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
        }), { capture: true })
      }
    })()`)
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...start })
    await new Promise((resolve) => setTimeout(resolve, 150))
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 })
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...target, button: 'left' })
    await new Promise((resolve) => setTimeout(resolve, 40))
    mainWindow.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const inputEvents = await mainWindow.webContents.executeJavaScript('window.__noteResizeSmokeEvents')
    mainWindow.webContents.removeListener('cursor-changed', recordCursor)
    windowControlsResult.resize = { before: beforeResize, after: mainWindow.getBounds(), cursorChanges, inputEvents }
    mainWindow.setBounds(beforeResize)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (process.env.NOTE_APP_SMOKE_SET_SETTINGS === '1') {
    await mainWindow.webContents.executeJavaScript(`(() => {
      localStorage.setItem('app-theme', 'nord')
      localStorage.setItem('editor-width', 'wide')
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 650))
  }
  const mainResult = await mainWindow.webContents.executeJavaScript(`(async () => {
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    const workspace = await fetch('/api/workspace').then((response) => response.json())
    return {
      title: document.title,
      rootMounted: Boolean(document.getElementById('root')?.firstElementChild),
      desktopBridge: window.noteDesktop?.isDesktop === true,
      workspaceRoot: workspace.root,
      titleBar: (() => {
        const element = document.querySelector('.desktop-titlebar')
        const style = element ? getComputedStyle(element) : null
        const dragArea = document.querySelector('.desktop-titlebar__drag-area')
        const dragStyle = dragArea ? getComputedStyle(dragArea) : null
        const title = document.querySelector('.desktop-titlebar__title')
        const titleRect = title?.getBoundingClientRect()
        return {
          mounted: Boolean(element),
          menuButtonMounted: Boolean(document.querySelector('[aria-label="애플리케이션 메뉴 열기"]')),
          titleCenterOffset: titleRect ? Math.round((titleRect.left + titleRect.width / 2 - window.innerWidth / 2) * 100) / 100 : null,
          appRegion: style?.getPropertyValue('app-region') || null,
          webkitAppRegion: style?.getPropertyValue('-webkit-app-region') || null,
          dragAreaAppRegion: dragStyle?.getPropertyValue('app-region') || null,
          dragAreaWebkitAppRegion: dragStyle?.getPropertyValue('-webkit-app-region') || null,
          background: style?.backgroundColor || null,
          controls: Array.from(document.querySelectorAll('.desktop-titlebar__control')).map((control) => {
            const rect = control.getBoundingClientRect()
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            return {
              label: control.getAttribute('aria-label'),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              hitLabel: hit?.closest('.desktop-titlebar__control')?.getAttribute('aria-label') || null,
            }
          }),
        }
      })(),
      theme: document.documentElement.dataset.theme || 'notion',
      settings: {
        origin: window.location.origin,
        theme: localStorage.getItem('app-theme'),
        editorWidth: localStorage.getItem('editor-width'),
      },
      resizeHandles: (() => {
        const handles = Array.from(document.querySelectorAll('[data-desktop-resize-handle]'))
        const directionAt = (x, y) => document.elementFromPoint(x, y)
          ?.getAttribute('data-desktop-resize-handle') || null
        return {
          count: handles.length,
          directions: handles.map((handle) => handle.getAttribute('data-desktop-resize-handle')).sort(),
          cursors: Object.fromEntries(handles.map((handle) => [
            handle.getAttribute('data-desktop-resize-handle'),
            getComputedStyle(handle).cursor,
          ])),
          hitTest: {
            north: directionAt(window.innerWidth / 2, 1),
            south: directionAt(window.innerWidth / 2, window.innerHeight - 2),
            east: directionAt(window.innerWidth - 2, window.innerHeight / 2),
            west: directionAt(1, window.innerHeight / 2),
            northEast: directionAt(window.innerWidth - 2, 1),
            northWest: directionAt(1, 1),
            southEast: directionAt(window.innerWidth - 2, window.innerHeight - 2),
            southWest: directionAt(1, window.innerHeight - 2),
          },
        }
      })(),
      layout: {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.clientWidth,
        html: (() => { const rect = document.documentElement.getBoundingClientRect(); return { x: rect.x, width: rect.width } })(),
        body: (() => { const rect = document.body.getBoundingClientRect(); return { x: rect.x, width: rect.width } })(),
        root: (() => { const rect = document.getElementById('root').getBoundingClientRect(); return { x: rect.x, width: rect.width } })(),
      },
      editor: (() => {
        const root = document.querySelector('.bn-default-styles')
        const content = document.querySelector('.bn-inline-content')
        return {
          mounted: Boolean(root),
          rootFont: root ? getComputedStyle(root).fontFamily : null,
          contentFont: content ? getComputedStyle(content).fontFamily : null,
          containsKorean: /[가-힣]/.test(root?.textContent || ''),
        }
      })(),
      mermaid: await (async () => {
        const preview = document.querySelector('.mermaid-preview')
        if (!preview) return { mounted: false }
        const deadline = Date.now() + 10000
        let diagram = preview.querySelector('svg')
        while (!diagram && Date.now() < deadline) {
          await sleep(100)
          diagram = preview.querySelector('svg')
        }
        if (!diagram) return { mounted: true, rendered: false }
        const koreanNodes = Array.from(diagram.querySelectorAll('text, tspan, foreignObject *'))
          .filter((node) => /[가-힣]/.test(node.textContent || ''))
        return {
          mounted: true,
          rendered: true,
          containsKorean: /[가-힣]/.test(diagram.textContent || ''),
          markupHasNotoSansKr: diagram.outerHTML.includes('Noto Sans KR'),
          koreanFonts: Array.from(new Set(koreanNodes.map((node) => getComputedStyle(node).fontFamily))),
        }
      })(),
      sqlDdl: (() => {
        const title = Array.from(document.querySelectorAll('h3'))
          .find((element) => (element.textContent || '').includes('MariaDB SQL DDL 내보내기'))
        const dialog = title?.closest('.fixed')
        const textarea = dialog?.querySelector('textarea')
        return {
          mounted: Boolean(dialog),
          containsKorean: /[가-힣]/.test(dialog?.textContent || ''),
          contentContainsKorean: /[가-힣]/.test(textarea?.value || ''),
          contentLength: textarea?.value.length || 0,
          font: textarea ? getComputedStyle(textarea).fontFamily : null,
        }
      })(),
      tooltip: await (async () => {
        const target = document.querySelector('.desktop-titlebar__control[data-desktop-tooltip]')
        if (!target) return { migrated: false, nativeTitleCount: document.querySelectorAll('[title]').length }
        target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
        await sleep(700)
        const popup = document.querySelector('.desktop-tooltip')
        const style = popup ? getComputedStyle(popup) : null
        target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
        return {
          migrated: true,
          targetCount: document.querySelectorAll('[data-desktop-tooltip]').length,
          nativeTitleCount: document.querySelectorAll('[title]').length,
          visible: Boolean(popup),
          text: popup?.textContent || null,
          font: style?.fontFamily || null,
        }
      })(),
      fonts: {
        status: document.fonts.status,
        korean: document.fonts.check('400 14px "Noto Sans KR"', '한글'),
        emoji: document.fonts.check('400 14px "Noto Sans KR"', '📝'),
        mono: (() => {
          const probe = document.createElement('textarea')
          probe.className = 'font-mono'
          document.body.appendChild(probe)
          const family = getComputedStyle(probe).fontFamily
          probe.remove()
          return family
        })(),
        faces: Array.from(document.fonts)
          .filter((font) => font.family.includes('Noto'))
          .map((font) => ({ family: font.family, weight: font.weight, status: font.status })),
        resources: performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('noto-'))
          .map((entry) => ({ name: entry.name.split('/').pop(), size: entry.transferSize })),
      },
      navigationMs: Math.round(performance.getEntriesByType('navigation')[0]?.duration || 0),
      singleActivation: ${JSON.stringify(singleActivationResult)},
    }
  })()`)
  const screenshotPath = process.env.NOTE_APP_SMOKE_SCREENSHOT
  if (screenshotPath) {
    const screenshot = await mainWindow.webContents.capturePage()
    fs.writeFileSync(path.resolve(screenshotPath), screenshot.toPNG())
  }
  await openQuickMemo()
  const quickMemoResult = await quickMemoWindow.webContents.executeJavaScript(`({
    title: document.title,
    rootMounted: Boolean(document.getElementById('root')?.firstElementChild),
    desktopBridge: window.noteDesktop?.isDesktop === true,
  })`)
  let byeoriResult = null
  if (process.env.NOTE_APP_SMOKE_OPEN_BYEORI === '1') {
    await openByeoriWindow(null, cursorPoint)
    byeoriResult = await byeoriWindow.webContents.executeJavaScript(`({
      title: document.title,
      mode: new URLSearchParams(window.location.search).get('window'),
      rootMounted: Boolean(document.getElementById('root')?.firstElementChild),
      desktopBridge: window.noteDesktop?.isDesktop === true,
      titleBar: document.querySelector('.desktop-titlebar__title')?.textContent?.trim() || null,
      hasWindowApi: ['focusByeoriWindow', 'reattachByeoriWindow', 'openDocumentInMain']
        .every((name) => typeof window.noteDesktop?.[name] === 'function'),
    })`)
    byeoriResult.bounds = byeoriWindow.getBounds()
    byeoriResult.minimumSize = byeoriWindow.getMinimumSize()
  }
  const windowBounds = mainWindow.getBounds()
  const contentBounds = mainWindow.getContentBounds()
  const nativeFrame = {
    window: windowBounds,
    content: contentBounds,
    insets: {
      left: contentBounds.x - windowBounds.x,
      top: contentBounds.y - windowBounds.y,
      right: windowBounds.x + windowBounds.width - contentBounds.x - contentBounds.width,
      bottom: windowBounds.y + windowBounds.height - contentBounds.y - contentBounds.height,
    },
  }
  console.log(`NOTE_DESKTOP_SMOKE ${JSON.stringify({ main: mainResult, quickMemo: quickMemoResult, byeori: byeoriResult, windowControls: windowControlsResult, nativeFrame, screenshotPath })}`)
  const pauseMs = Math.min(Math.max(Number.parseInt(process.env.NOTE_APP_SMOKE_PAUSE_MS || '0', 10) || 0, 0), 30_000)
  if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs))
  app.quit()
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '파일',
      submenu: [
        { label: '빠른 메모', accelerator: 'CmdOrCtrl+Shift+M', click: () => void openQuickMemo() },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId('local.note.desktop')
      if (process.platform === 'darwin' && app.dock && fs.existsSync(appIconPath)) {
        app.dock.setIcon(appIconPath)
      }
      if (options.manageBackend) {
        const backendUrl = await startOrReuseBackend()
        const expectedFrontendHtml = fs.readFileSync(path.join(frontendDist, 'index.html'), 'utf8')
        if (!await probeNoteFrontend(backendUrl, expectedFrontendHtml)) {
          throw new Error(`백엔드가 현재 빌드된 Twill 화면을 제공하지 않습니다: ${backendUrl}`)
        }
        // FastAPI가 API와 빌드 UI를 함께 제공하므로 고정 origin을 사용한다.
        // 매 실행마다 달라지는 Vite preview 포트는 localStorage를 초기화된 것처럼 보이게 했다.
        appUrl = backendUrl
      }
      if (!appUrl) throw new Error('Electron이 열 로컬 앱 주소를 결정하지 못했습니다.')
      await refreshFrontendCacheIfNeeded()
      installLocalStoragePersistence()
      ipcMain.handle('desktop:window-command', async (event, command) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || window.isDestroyed()) return false
        switch (command) {
          case 'minimize':
            stopWindowMove(window)
            window.minimize()
            break
          case 'toggle-maximize':
            return toggleWindowMaximize(window)
          case 'close':
            window.close()
            break
          case 'is-maximized':
            return isWindowMaximized(window)
          default:
            return false
        }
        return true
      })
      ipcMain.on('desktop:window-move-start', beginWindowMove)
      ipcMain.on('desktop:window-move-end', endWindowMove)
      ipcMain.on('desktop:window-resize-start', beginWindowResize)
      ipcMain.on('desktop:window-resize-update', updateWindowResize)
      ipcMain.on('desktop:window-resize-end', endWindowResize)
      ipcMain.on('desktop:set-window-background', (event, color) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || window.isDestroyed() || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return
        window.setBackgroundColor(color)
      })
      ipcMain.handle('desktop:restart', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || window.isDestroyed() || new URL(event.senderFrame.url).origin !== new URL(appUrl).origin) {
          throw new Error('앱 창에서만 다시 시작할 수 있습니다.')
        }
        if (restartRequested) return
        // The API refuses while AI work or an update is active, including work
        // started from a detached window.
        const response = await fetch(new URL('/api/ai/restart-engine', appUrl), { method: 'POST' })
        if (!response.ok) {
          const body = await response.json()
          throw new Error(body.detail || 'AI 엔진을 다시 시작할 수 없습니다.')
        }
        restartRequested = true
        app.quit()
      })
      ipcMain.handle('desktop:open-quick-memo', async () => openQuickMemo())
      ipcMain.handle('desktop:open-byeori-window', openByeoriWindow)
      ipcMain.handle('desktop:focus-byeori-window', async () => focusByeoriWindow())
      ipcMain.handle('desktop:is-byeori-window-open', async () => isByeoriWindowOpen())
      ipcMain.handle('desktop:reattach-byeori-window', async () => reattachByeoriWindow())
      ipcMain.handle('desktop:open-main-document', openDocumentInMain)
      ipcMain.handle('desktop:select-project-directory', async (event, request = {}) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window || window.isDestroyed()) return { canceled: true, path: null }
        const requestedTitle = typeof request?.title === 'string' ? request.title.trim() : ''
        const requestedPath = typeof request?.defaultPath === 'string' ? request.defaultPath.trim() : ''
        const defaultPath = requestedPath && path.isAbsolute(requestedPath) && fs.existsSync(requestedPath)
          ? requestedPath
          : undefined
        const result = await dialog.showOpenDialog(window, {
          title: requestedTitle.slice(0, 100) || '프로젝트 폴더 선택',
          defaultPath,
          properties: ['openDirectory'],
        })
        const selectedPath = result.filePaths[0]
        return {
          canceled: result.canceled || !selectedPath,
          path: selectedPath ? path.resolve(selectedPath) : null,
        }
      })
      installMenu()
      await createMainWindow()
      if (smokeTest) await runSmokeTest()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[desktop] 시작 실패: ${message}`)
      dialog.showErrorBox('Twill 시작 실패', message)
      app.quit()
    }
  })
}

app.on('activate', () => {
  if (!mainWindow && appUrl) void createMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void stopBackend().then(() => {
    shutdownComplete = true
    if (restartRequested) {
      app.relaunch({ args: desktopRelaunchArgs(process.argv) })
    }
    app.quit()
  }).catch((error) => {
    quitting = false
    restartRequested = false
    dialog.showErrorBox('Twill 종료 실패', `백엔드를 종료하지 못했습니다. 다시 시도해 주세요.\n${error.message}`)
  })
})
