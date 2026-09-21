import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import test from 'node:test'
import path from 'node:path'

import {
  backendPortCandidates,
  backendPythonCandidates,
  desktopAppProfile,
  desktopCommandPath,
  desktopWindowChromeOptions,
  frontendRevisionFromHtml,
  isExpectedFrontendHtml,
  isSafeExternalUrl,
  normalizeLocalAppUrl,
  parseDesktopOptions,
  popoutWindowBounds,
  restoredWindowBoundsForDrag,
  selectWslgOzonePlatform,
  versionedLocalAppUrl,
  windowBoundsFromResize,
  windowPositionFromDrag,
  windowsWorkAreaForDisplay,
} from '../electron/runtime.mjs'
import {
  normalizeLocalStorageSnapshot,
  readLocalStorageSnapshot,
  writeLocalStorageSnapshot,
} from '../electron/local-storage.mjs'
import { npmRunCommand } from '../scripts/npm-command.mjs'

test('Windows npm 스크립트는 cmd.exe를 통해 실행한다', () => {
  assert.deepEqual(npmRunCommand('build', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd run build'],
  })
  assert.deepEqual(npmRunCommand('build', 'linux', {}), {
    command: 'npm',
    args: ['run', 'build'],
  })
  assert.throws(() => npmRunCommand('build & whoami', 'win32', {}), TypeError)
})

test('데스크톱 개발 URL은 백엔드를 중복 실행하지 않는다', () => {
  const options = parseDesktopOptions(['--url=http://127.0.0.1:5173', '--no-backend'], {})
  assert.equal(options.uiUrl, 'http://127.0.0.1:5173')
  assert.equal(options.manageBackend, false)
})

test('기본 데스크톱 모드는 로컬 백엔드를 직접 관리한다', () => {
  const options = parseDesktopOptions([], {})
  assert.equal(options.manageBackend, true)
  assert.equal(options.backendHost, '127.0.0.1')
  assert.equal(options.backendPort, 8000)
})

test('개발 Electron은 설치 앱과 별도 프로필을 사용한다', () => {
  assert.deepEqual(desktopAppProfile(false, '/Users/test/Library/Application Support'), {
    name: 'Twill Development',
    userDataPath: path.join('/Users/test/Library/Application Support', 'Twill Development'),
  })
  assert.deepEqual(desktopAppProfile(true, '/Users/test/Library/Application Support'), {
    name: 'Twill',
    userDataPath: null,
  })
})

test('macOS 데스크톱 앱은 Finder PATH에 없는 Codex 설치 경로를 보충한다', () => {
  const commandPath = desktopCommandPath('/usr/bin:/bin', 'darwin', '/Users/test')
  assert.deepEqual(commandPath.split(':'), [
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Users/test/.local/bin',
    '/Users/test/.npm-global/bin',
    '/Users/test/.volta/bin',
  ])
  assert.equal(desktopCommandPath('/usr/bin:/bin', 'linux', '/Users/test'), '/usr/bin:/bin')
})

test('실행 중인 백엔드는 현재 프런트엔드 빌드와 일치할 때만 재사용한다', () => {
  const current = '<!doctype html><title>Twill</title><div id="root"></div><script src="app-new.js"></script>'
  const stale = '<!doctype html><title>Twill</title><div id="root"></div><script src="app-old.js"></script>'
  assert.equal(isExpectedFrontendHtml(current, current), true)
  assert.equal(isExpectedFrontendHtml(stale, current), false)
  assert.equal(isExpectedFrontendHtml('<title>Other</title><div id="root"></div>', null), false)
})

test('프런트엔드 내용이 바뀌면 데스크톱 UI 리비전도 바뀐다', () => {
  const first = frontendRevisionFromHtml('<script src="app-old.js"></script>')
  const same = frontendRevisionFromHtml('<script src="app-old.js"></script>')
  const next = frontendRevisionFromHtml('<script src="app-new.js"></script>')
  assert.equal(first, same)
  assert.notEqual(first, next)
  assert.equal(frontendRevisionFromHtml(''), null)
})

test('데스크톱 렌더러 URL은 기존 쿼리를 보존하며 UI 리비전을 추가한다', () => {
  assert.equal(
    versionedLocalAppUrl('http://127.0.0.1:8000', '/?window=byeori', 'abc123'),
    'http://127.0.0.1:8000/?window=byeori&_twill_ui=abc123',
  )
  assert.equal(
    versionedLocalAppUrl('http://127.0.0.1:8000', '/quick-memo.html', 'abc123'),
    'http://127.0.0.1:8000/quick-memo.html?_twill_ui=abc123',
  )
})

test('백엔드 포트 환경변수를 반영한다', () => {
  const options = parseDesktopOptions([], {
    NOTE_APP_BACKEND_PORT: '18000',
  })
  assert.equal(options.backendPort, 18000)
})

test('기본 포트가 점유되면 이어지는 로컬 포트를 후보로 사용한다', () => {
  assert.deepEqual(backendPortCandidates(8000, 4), [8000, 8001, 8002, 8003])
  assert.deepEqual(backendPortCandidates(65534, 4), [65534, 65535])
})

test('Electron 설정 스냅샷은 문자열 localStorage 값만 안전하게 보존한다', () => {
  const normalized = normalizeLocalStorageSnapshot({
    'app-theme': 'nord',
    'editor-width': 'wide',
    invalid: 123,
  })
  assert.deepEqual({ ...normalized }, {
    'app-theme': 'nord',
    'editor-width': 'wide',
  })
})

test('Electron 설정 스냅샷을 버전 문서로 저장하고 다시 읽는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'note-local-storage-'))
  const filePath = path.join(directory, 'desktop-local-storage.json')
  try {
    writeLocalStorageSnapshot(filePath, {
      'app-theme': 'nord',
      'editor-width': 'wide',
    })
    assert.deepEqual({ ...readLocalStorageSnapshot(filePath) }, {
      'app-theme': 'nord',
      'editor-width': 'wide',
    })
    // Windows does not expose POSIX mode bits and reports the file as 0666
    // even though the snapshot remains inside the per-user app-data folder.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('원격 UI는 preload 권한 경계 안으로 열 수 없다', () => {
  assert.throws(() => normalizeLocalAppUrl('https://example.com/app'))
  assert.equal(normalizeLocalAppUrl('http://localhost:5173/'), 'http://localhost:5173')
})

test('외부 창은 안전한 웹 및 메일 링크만 허용한다', () => {
  assert.equal(isSafeExternalUrl('https://example.com/login'), true)
  assert.equal(isSafeExternalUrl('mailto:user@example.com'), true)
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
})

test('플랫폼별 프로젝트 가상환경을 시스템 Python보다 우선한다', () => {
  const linux = backendPythonCandidates('/project/note', 'linux', {})
  const windows = backendPythonCandidates('C:\\note', 'win32', {})
  assert.equal(linux[0], path.join('/project/note', 'backend', '.venv', 'bin', 'python'))
  assert.equal(windows[0], path.join('C:\\note', 'backend', '.venv', 'Scripts', 'python.exe'))
})

test('WSLg는 DRM render node가 있을 때만 네이티브 Wayland를 사용한다', () => {
  assert.equal(selectWslgOzonePlatform({
    isWslg: true,
    waylandDisplay: 'wayland-0',
    hasDrmRenderNode: true,
  }), 'wayland')
  assert.equal(selectWslgOzonePlatform({
    isWslg: true,
    waylandDisplay: 'wayland-0',
    hasDrmRenderNode: false,
  }), 'x11')
  assert.equal(selectWslgOzonePlatform({
    isWslg: false,
    waylandDisplay: undefined,
    hasDrmRenderNode: false,
  }), null)
})

test('macOS는 네이티브 신호등 타이틀바를 사용하고 Windows는 프레임리스 제어를 유지한다', () => {
  assert.deepEqual(desktopWindowChromeOptions('darwin'), {
    frame: true,
    hasShadow: true,
    titleBarStyle: 'hiddenInset',
  })
  assert.deepEqual(desktopWindowChromeOptions('win32'), {
    frame: false,
    hasShadow: false,
    thickFrame: true,
  })
})

test('Windows 작업 영역을 WSLg 가상 데스크톱 원점에 맞춰 변환한다', () => {
  const electronDisplays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 } },
    { id: 2, bounds: { x: 1600, y: 0, width: 1920, height: 1080 } },
    { id: 3, bounds: { x: 3520, y: 0, width: 1920, height: 1080 } },
  ]
  const windowsScreens = [
    { x: -1600, y: 0, width: 1600, height: 852, boundsX: -1600, boundsY: 0, boundsWidth: 1600, boundsHeight: 900 },
    { x: 0, y: 0, width: 1920, height: 1032, boundsX: 0, boundsY: 0, boundsWidth: 1920, boundsHeight: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1032, boundsX: 1920, boundsY: 0, boundsWidth: 1920, boundsHeight: 1080 },
  ]
  assert.deepEqual(windowsWorkAreaForDisplay(electronDisplays[2], electronDisplays, windowsScreens), {
    x: 3520,
    y: 0,
    width: 1920,
    height: 1032,
  })
  assert.deepEqual(windowsWorkAreaForDisplay(electronDisplays[0], electronDisplays, windowsScreens), {
    x: 0,
    y: 0,
    width: 1600,
    height: 852,
  })
})

test('드래그 시작 위치와 현재 커서의 차이만 창 위치에 반영한다', () => {
  assert.deepEqual(windowPositionFromDrag(
    { x: 2140, y: 320 },
    { x: 1840, y: 80, width: 1440, height: 920 },
    { x: 2325, y: 475 },
  ), { x: 2025, y: 235 })
  assert.equal(windowPositionFromDrag(null, { x: 0, y: 0 }, { x: 1, y: 1 }), null)
})

test('최대화 창 드래그는 커서의 가로 비율을 유지하며 현재 모니터에서 복원한다', () => {
  assert.deepEqual(restoredWindowBoundsForDrag(
    { x: 1440, y: 18 },
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 180, y: 80, width: 1200, height: 800 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  ), { x: 540, y: 0, width: 1200, height: 800 })

  assert.deepEqual(restoredWindowBoundsForDrag(
    { x: 2010, y: 20 },
    { x: 1920, y: 0, width: 1280, height: 720 },
    { x: 0, y: 0, width: 1440, height: 920 },
    { x: 1920, y: 0, width: 1280, height: 680 },
  ), { x: 1920, y: 0, width: 1280, height: 680 })

  assert.equal(restoredWindowBoundsForDrag(null, {}, {}, {}), null)
})

test('벼리 분리 창은 드롭 지점 가까이에서 모니터 작업 영역 안에 배치된다', () => {
  const workArea = { x: 1920, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(popoutWindowBounds(
    { x: 2460, y: 180 },
    workArea,
  ), { x: 2388, y: 160, width: 560, height: 780 })

  assert.deepEqual(popoutWindowBounds(
    { x: 3835, y: 1035 },
    workArea,
  ), { x: 3264, y: 244, width: 560, height: 780 })

  assert.deepEqual(popoutWindowBounds(
    { x: 120, y: 80 },
    { x: 0, y: 0, width: 420, height: 500 },
  ), { x: 16, y: 16, width: 388, height: 468 })
  assert.equal(popoutWindowBounds(null, workArea), null)
})

test('프레임리스 창의 각 가장자리와 모서리를 커서 이동량만큼 조절한다', () => {
  const cursor = { x: 500, y: 300 }
  const bounds = { x: 100, y: 80, width: 1200, height: 800 }
  const minimum = { width: 1000, height: 680 }

  assert.deepEqual(windowBoundsFromResize(cursor, bounds, { x: 620, y: 390 }, 'south-east', minimum), {
    x: 100,
    y: 80,
    width: 1320,
    height: 890,
  })
  assert.deepEqual(windowBoundsFromResize(cursor, bounds, { x: 380, y: 210 }, 'north-west', minimum), {
    x: -20,
    y: -10,
    width: 1320,
    height: 890,
  })
  assert.deepEqual(windowBoundsFromResize(cursor, bounds, { x: 900, y: 700 }, 'north-west', minimum), {
    x: 300,
    y: 200,
    width: 1000,
    height: 680,
  })
  assert.equal(windowBoundsFromResize(cursor, bounds, cursor, 'invalid', minimum), null)
})
