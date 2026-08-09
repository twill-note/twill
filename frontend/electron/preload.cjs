const { contextBridge, ipcRenderer } = require('electron')

const localStorageLoadChannel = 'desktop:local-storage-load'
const localStorageSaveChannel = 'desktop:local-storage-save'

function localStorageSnapshot() {
  const snapshot = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key === null) continue
    const value = localStorage.getItem(key)
    if (value !== null) snapshot[key] = value
  }
  return snapshot
}

function installLocalStoragePersistence() {
  try {
    const persisted = ipcRenderer.sendSync(localStorageLoadChannel)
    if (persisted && typeof persisted === 'object') {
      for (const [key, value] of Object.entries(persisted)) {
        if (typeof value === 'string' && localStorage.getItem(key) !== value) {
          localStorage.setItem(key, value)
        }
      }
    }
  } catch (error) {
    console.warn('[desktop] 저장된 앱 설정을 불러오지 못했습니다.', error)
  }

  let lastSerialized = ''
  const persist = () => {
    try {
      const snapshot = localStorageSnapshot()
      const serialized = JSON.stringify(snapshot)
      if (serialized === lastSerialized) return
      ipcRenderer.sendSync(localStorageSaveChannel, snapshot)
      lastSerialized = serialized
    } catch (error) {
      console.warn('[desktop] 앱 설정을 저장하지 못했습니다.', error)
    }
  }

  // React 모듈이 실행되기 전에 복원하고, 현재 origin에만 있던 기존 설정도 즉시 흡수한다.
  persist()
  const timer = setInterval(persist, 500)
  window.addEventListener('beforeunload', () => {
    clearInterval(timer)
    persist()
  }, { once: true })
}

installLocalStoragePersistence()

const windowControls = Object.freeze({
  minimize: () => ipcRenderer.invoke('desktop:window-command', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop:window-command', 'toggle-maximize'),
  close: () => ipcRenderer.invoke('desktop:window-command', 'close'),
  isMaximized: () => ipcRenderer.invoke('desktop:window-command', 'is-maximized'),
  beginMove: () => ipcRenderer.send('desktop:window-move-start'),
  endMove: () => ipcRenderer.send('desktop:window-move-end'),
  beginResize: (direction, point) => ipcRenderer.send('desktop:window-resize-start', direction, point),
  updateResize: (point) => ipcRenderer.send('desktop:window-resize-update', point),
  endResize: (point) => ipcRenderer.send('desktop:window-resize-end', point),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized))
    ipcRenderer.on('desktop:maximized-changed', listener)
    return () => ipcRenderer.removeListener('desktop:maximized-changed', listener)
  },
})

function subscribe(channel, callback, map = (_event, value) => value) {
  const listener = (...args) => callback(map(...args))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('noteDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  openQuickMemo: () => ipcRenderer.invoke('desktop:open-quick-memo'),
  openByeoriWindow: (point) => ipcRenderer.invoke('desktop:open-byeori-window', point),
  focusByeoriWindow: () => ipcRenderer.invoke('desktop:focus-byeori-window'),
  isByeoriWindowOpen: () => ipcRenderer.invoke('desktop:is-byeori-window-open'),
  reattachByeoriWindow: () => ipcRenderer.invoke('desktop:reattach-byeori-window'),
  openDocumentInMain: (target) => ipcRenderer.invoke('desktop:open-main-document', target),
  restartApp: () => ipcRenderer.invoke('desktop:restart-app'),
  onByeoriWindowChange: (callback) => subscribe(
    'desktop:byeori-window-changed',
    callback,
    (_event, open) => Boolean(open),
  ),
  onShowByeoriDock: (callback) => subscribe('desktop:show-byeori-dock', callback, () => undefined),
  onOpenMainDocument: (callback) => subscribe('desktop:open-main-document', callback),
  setWindowBackground: (color) => ipcRenderer.send('desktop:set-window-background', color),
  windowControls,
}))
