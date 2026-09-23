import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const DEFAULT_DESKTOP_PORT = 52023

export function desktopAppProfile(isPackaged, appDataPath) {
  if (isPackaged) return { name: 'Twill', userDataPath: null }
  return {
    name: 'Twill Development',
    userDataPath: path.join(appDataPath, 'Twill Development'),
  }
}

/**
 * Finder와 Launchpad로 시작한 macOS 앱은 로그인 셸의 PATH를 받지 않는다.
 * Codex CLI를 Homebrew로 설치한 경우(/opt/homebrew/bin) 백엔드가 이를 찾도록
 * 데스크톱 프로세스에 일반적인 사용자 명령 경로를 보충한다.
 */
export function desktopCommandPath(currentPath, platform = process.platform, homeDirectory = '') {
  const delimiter = platform === 'win32' ? ';' : ':'
  const existing = String(currentPath || '').split(delimiter).filter(Boolean)
  if (platform !== 'darwin') return existing.join(delimiter)

  const macosCommandPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(homeDirectory
      ? [
          path.posix.join(homeDirectory, '.local', 'bin'),
          path.posix.join(homeDirectory, '.npm-global', 'bin'),
          path.posix.join(homeDirectory, '.volta', 'bin'),
        ]
      : []),
  ]
  return [...new Set([...existing, ...macosCommandPaths])].join(delimiter)
}

export function isExpectedFrontendHtml(html, expectedHtml = null) {
  if (typeof html !== 'string') return false
  const isTwill = /<title>\s*Twill\s*<\/title>/i.test(html) && /id=["']root["']/i.test(html)
  return isTwill && (expectedHtml === null || html === expectedHtml)
}

function argumentValue(argv, name) {
  const prefix = `${name}=`
  const item = argv.find((value) => value.startsWith(prefix))
  return item ? item.slice(prefix.length) : undefined
}

function parsePort(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback
}

export function normalizeLocalAppUrl(raw) {
  if (!raw) return null
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`데스크톱 UI는 로컬 HTTP 주소만 열 수 있습니다: ${raw}`)
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

/**
 * Vite의 index.html 내용으로 UI 빌드 리비전을 만든다. 엔트리 번들 이름이 바뀌면
 * 리비전도 바뀌므로, 같은 localhost 주소를 계속 쓰는 설치 앱에서도 이전 문서를
 * Chromium HTTP 캐시에서 재사용하지 않게 할 수 있다.
 */
export function frontendRevisionFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return null
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

/** 로컬 렌더러 URL에 빌드별 캐시 버스터를 일관되게 추가한다. */
export function versionedLocalAppUrl(baseUrl, relativePath = '/', revision = null) {
  const normalizedBase = normalizeLocalAppUrl(baseUrl)
  const url = new URL(relativePath, `${normalizedBase}/`)
  if (revision) url.searchParams.set('_twill_ui', revision)
  return url.toString()
}

export function parseDesktopOptions(argv, env = process.env) {
  const rawUrl = argumentValue(argv, '--url') ?? env.NOTE_APP_DESKTOP_URL
  const uiUrl = normalizeLocalAppUrl(rawUrl)
  const explicitlyStartBackend = argv.includes('--start-backend') || env.NOTE_APP_DESKTOP_MANAGE_BACKEND === '1'
  const explicitlySkipBackend = argv.includes('--no-backend') || env.NOTE_APP_DESKTOP_MANAGE_BACKEND === '0'
  return {
    uiUrl,
    manageBackend: explicitlyStartBackend || (!uiUrl && !explicitlySkipBackend),
    backendHost: env.NOTE_APP_HOST || '127.0.0.1',
    backendPort: parsePort(env.NOTE_APP_BACKEND_PORT, DEFAULT_DESKTOP_PORT),
  }
}

export function backendPortCandidates(preferred, count = 20) {
  const first = Number.isInteger(preferred) && preferred > 0 && preferred <= 65535 ? preferred : DEFAULT_DESKTOP_PORT
  const limit = Math.max(1, Math.min(Number.isInteger(count) ? count : 20, 100))
  return Array.from({ length: limit }, (_, index) => first + index)
    .filter((port) => port <= 65535)
}

/** Probe the actual TCP bind, including non-HTTP listeners and Windows exclusions. */
export function canListenOnPort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

export function isPortConflict(log) {
  return /EADDRINUSE|address already in use|only one usage of each socket address|\[(?:Errno|WinError)\s+(?:48|98|10048)\]/i.test(log)
}

export function isSafeExternalUrl(raw) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(raw).protocol)
  } catch {
    return false
  }
}

export function selectWslgOzonePlatform({ isWslg, waylandDisplay, hasDrmRenderNode }) {
  if (!isWslg) return null
  return waylandDisplay && hasDrmRenderNode ? 'wayland' : 'x11'
}

/**
 * macOS는 운영체제의 신호등 버튼을 그대로 쓰고 콘텐츠만 타이틀바 아래까지 확장한다.
 * 다른 플랫폼은 기존 프레임리스 타이틀바와 렌더러 창 제어 버튼을 유지한다.
 */
export function desktopWindowChromeOptions(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      frame: true,
      hasShadow: true,
      titleBarStyle: 'hiddenInset',
    }
  }
  return {
    frame: false,
    hasShadow: false,
    ...(platform === 'win32' ? { thickFrame: true } : {}),
  }
}

export function windowsWorkAreaForDisplay(display, electronDisplays, windowsScreens) {
  if (!display?.bounds || !electronDisplays?.length || !windowsScreens?.length) return null
  const electronOrigin = {
    x: Math.min(...electronDisplays.map((item) => item.bounds.x)),
    y: Math.min(...electronDisplays.map((item) => item.bounds.y)),
  }
  const windowsOrigin = {
    x: Math.min(...windowsScreens.map((item) => item.boundsX)),
    y: Math.min(...windowsScreens.map((item) => item.boundsY)),
  }
  const target = {
    x: display.bounds.x - electronOrigin.x,
    y: display.bounds.y - electronOrigin.y,
  }
  const match = windowsScreens.find((item) => (
    item.boundsX - windowsOrigin.x === target.x
    && item.boundsY - windowsOrigin.y === target.y
    && item.boundsWidth === display.bounds.width
    && item.boundsHeight === display.bounds.height
  ))
  if (!match) return null
  return {
    x: display.bounds.x + match.x - match.boundsX,
    y: display.bounds.y + match.y - match.boundsY,
    width: match.width,
    height: match.height,
  }
}

export function windowPositionFromDrag(startCursor, startBounds, currentCursor) {
  if (![startCursor?.x, startCursor?.y, startBounds?.x, startBounds?.y, currentCursor?.x, currentCursor?.y].every(Number.isFinite)) {
    return null
  }
  return {
    x: Math.round(startBounds.x + currentCursor.x - startCursor.x),
    y: Math.round(startBounds.y + currentCursor.y - startCursor.y),
  }
}

/**
 * 최대화된 창을 타이틀바 드래그로 복원할 때 커서가 같은 가로 지점을 계속 잡도록 한다.
 * 복원 창은 커서가 있는 모니터의 작업 영역 안에 놓아 서로 다른 해상도의 화면 사이에서도
 * 첫 이동 프레임이 튀지 않게 한다.
 */
export function restoredWindowBoundsForDrag(cursor, maximizedBounds, restoreBounds, workArea, titlebarHeight = 36) {
  if (![
    cursor?.x,
    cursor?.y,
    maximizedBounds?.x,
    maximizedBounds?.y,
    maximizedBounds?.width,
    restoreBounds?.width,
    restoreBounds?.height,
    workArea?.x,
    workArea?.y,
    workArea?.width,
    workArea?.height,
    titlebarHeight,
  ].every(Number.isFinite) || maximizedBounds.width <= 0 || workArea.width <= 0 || workArea.height <= 0) return null

  const width = Math.min(Math.max(1, Math.round(restoreBounds.width)), Math.round(workArea.width))
  const height = Math.min(Math.max(1, Math.round(restoreBounds.height)), Math.round(workArea.height))
  const horizontalRatio = Math.min(Math.max(
    (cursor.x - maximizedBounds.x) / maximizedBounds.width,
    0,
  ), 1)
  const titlebarOffset = Math.min(
    Math.max(cursor.y - maximizedBounds.y, 0),
    Math.max(0, titlebarHeight - 1),
  )
  const minimumX = Math.round(workArea.x)
  const maximumX = Math.round(workArea.x + workArea.width - width)
  const minimumY = Math.round(workArea.y)
  const maximumY = Math.round(workArea.y + workArea.height - height)

  return {
    x: Math.min(Math.max(Math.round(cursor.x - width * horizontalRatio), minimumX), maximumX),
    y: Math.min(Math.max(Math.round(cursor.y - titlebarOffset), minimumY), maximumY),
    width,
    height,
  }
}

/**
 * 분리 창을 드롭 지점 가까이에 놓되 현재 모니터의 작업 영역 밖으로 밀려나지 않게 한다.
 * Electron의 screen 좌표와 workArea는 DIP 단위이므로 고해상도 화면에서도 별도 환산이
 * 필요 없다. 작은 화면에서는 요청 크기보다 작업 영역을 우선한다.
 */
export function popoutWindowBounds(anchor, workArea, preferredSize = { width: 560, height: 780 }, margin = 16) {
  if (![
    anchor?.x,
    anchor?.y,
    workArea?.x,
    workArea?.y,
    workArea?.width,
    workArea?.height,
    preferredSize?.width,
    preferredSize?.height,
  ].every(Number.isFinite)) return null

  const safeMargin = Math.max(0, Math.round(margin))
  const availableWidth = Math.max(1, Math.round(workArea.width) - safeMargin * 2)
  const availableHeight = Math.max(1, Math.round(workArea.height) - safeMargin * 2)
  const width = Math.min(Math.max(1, Math.round(preferredSize.width)), availableWidth)
  const height = Math.min(Math.max(1, Math.round(preferredSize.height)), availableHeight)
  const minimumX = Math.round(workArea.x) + safeMargin
  const minimumY = Math.round(workArea.y) + safeMargin
  const maximumX = Math.round(workArea.x + workArea.width) - safeMargin - width
  const maximumY = Math.round(workArea.y + workArea.height) - safeMargin - height

  return {
    x: Math.min(Math.max(Math.round(anchor.x - 72), minimumX), maximumX),
    y: Math.min(Math.max(Math.round(anchor.y - 20), minimumY), maximumY),
    width,
    height,
  }
}

const windowResizeDirections = new Set(['north', 'south', 'east', 'west', 'north-east', 'north-west', 'south-east', 'south-west'])

export function windowBoundsFromResize(startCursor, startBounds, currentCursor, direction, minimumSize) {
  if (!windowResizeDirections.has(direction)) return null
  if (![
    startCursor?.x,
    startCursor?.y,
    startBounds?.x,
    startBounds?.y,
    startBounds?.width,
    startBounds?.height,
    currentCursor?.x,
    currentCursor?.y,
    minimumSize?.width,
    minimumSize?.height,
  ].every(Number.isFinite)) return null

  const deltaX = currentCursor.x - startCursor.x
  const deltaY = currentCursor.y - startCursor.y
  const minimumWidth = Math.max(1, minimumSize.width)
  const minimumHeight = Math.max(1, minimumSize.height)
  const resized = { ...startBounds }

  if (direction.includes('east')) {
    resized.width = Math.max(minimumWidth, startBounds.width + deltaX)
  } else if (direction.includes('west')) {
    resized.width = Math.max(minimumWidth, startBounds.width - deltaX)
    resized.x = startBounds.x + startBounds.width - resized.width
  }

  if (direction.includes('south')) {
    resized.height = Math.max(minimumHeight, startBounds.height + deltaY)
  } else if (direction.includes('north')) {
    resized.height = Math.max(minimumHeight, startBounds.height - deltaY)
    resized.y = startBounds.y + startBounds.height - resized.height
  }

  return Object.fromEntries(Object.entries(resized).map(([key, value]) => [key, Math.round(value)]))
}

export function backendPythonCandidates(projectRoot, platform = process.platform, env = process.env) {
  const backendRoot = path.join(projectRoot, 'backend')
  const configured = env.NOTE_APP_PYTHON
  const local = platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python')
  const fallback = platform === 'win32' ? 'python.exe' : 'python3'
  return [configured, local, fallback].filter(Boolean)
}
