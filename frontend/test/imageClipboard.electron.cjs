// Uses the real preload, clipboard IPC and both production document viewers.
// Run against an isolated backend + Vite server whose workspace is twill-qa-notes.
const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twill-image-qa-')))
app.whenReady().then(async () => {
  let failed = false
  const savedClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)])
  const url = process.env.TWILL_QA_URL || 'http://127.0.0.1:18766'
  const { registerImageClipboard } = await import('../electron/image-clipboard.mjs')
  registerImageClipboard(url)
  ipcMain.on('desktop:local-storage-load', event => { event.returnValue = {} })
  ipcMain.on('desktop:local-storage-save', event => { event.returnValue = true })
  ipcMain.handle('desktop:window-command', () => false)
  ipcMain.handle('desktop:is-byeori-window-open', () => false)
  const win = new BrowserWindow({ show: false, width: 1400, height: 1100,
    webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  const run = async code => {
    const result = await win.webContents.executeJavaScript(`Promise.resolve().then(() => ${code}).then(value => ({ value }), error => ({ error: error.stack || String(error) }))`)
    if (result.error) throw Error(result.error)
    return result.value
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(100) } throw Error(label) }
  try {
    await win.loadURL(url)
    await run(String.raw`(async () => {
      const url = p => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === p)?.name ?? p
      const { useAppStore: store } = await import(url('/src/store.ts'))
      const { api } = await import(url('/src/api.ts'))
      const react = await import(url('/node_modules/.vite/deps/react.js'))
      const { createElement } = react.default ?? react
      const reactDom = await import(url('/node_modules/.vite/deps/react-dom_client.js'))
      const { createRoot } = reactDom.default ?? reactDom
      const { default: TaskCardPopup } = await import(url('/src/components/TaskCardPopup.tsx'))
      for (let i = 0; !store.getState().workspaceReady && i < 100; i++) await new Promise(r => setTimeout(r, 100))
      if (!store.getState().root.replaceAll('\\', '/').endsWith('/twill-qa-notes')) throw Error('isolated workspace required')
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 6
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 6)
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const pngUrl = await api.uploadAsset(new File([png], 'copy.png', { type: 'image/png' }))
      const svgUrl = await api.uploadAsset(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#00ff00"/></svg>'], 'copy.svg', { type: 'image/svg+xml' }))
      const name = '이미지 복사 ' + Date.now() + '.md'
      await api.createEntry(name, 'file')
      const content = await api.getContent(name)
      await api.saveContent(name, content.frontmatter, '![png](' + pngUrl + ')\n\n![svg](' + svgUrl + ')\n\n일반 텍스트 복사', content.mtime)
      await store.getState().refreshTree()
      store.getState().openFile(name)
      window.qaTaskPopup = () => {
        const host = document.createElement('div'); document.body.append(host)
        const root = createRoot(host)
        root.render(createElement(TaskCardPopup, { row: { path: name, title: name, date: null, tags: [], icon: '', props: {}, updated_at: 0 },
          config: { columns: [] }, onClose: () => root.unmount(), onCellChange: () => {}, onRowUpdated: () => {} }))
      }
    })()`)
    for (const viewer of ['document', 'task']) {
      if (viewer === 'task') await run('window.qaTaskPopup()')
      const prefix = viewer === 'task' ? '.note-body-editor ' : ''
      await wait(() => run(`document.querySelectorAll('${prefix}.bn-editor img').length === 2`), viewer + ' images missing')
      for (const [index, size, color] of [[0, { width: 8, height: 6 }, [0, 0, 255]], [1, { width: 16, height: 12 }, [0, 255, 0]]]) {
        clipboard.clear()
        const point = await run(`(() => {
          const img = document.querySelectorAll('${prefix}.bn-editor img')[${index}]
          img.scrollIntoView({ block: 'center' })
          const r = img.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
        })()`)
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        await pause(100)
        // Chromium's native copy command follows the same DOM copy event as Cmd/Ctrl+C.
        win.webContents.copy()
        await wait(() => !clipboard.readImage().isEmpty(), viewer + ' image ' + index + ' not copied')
        const copied = clipboard.readImage()
        assert.deepEqual(copied.getSize(), size)
        assert.deepEqual([...copied.toBitmap().subarray(0, 3)], color)
        await run(`(() => {
          const receiver = document.createElement('div'); receiver.id = 'qa-paste'; receiver.contentEditable = 'true'
          document.body.append(receiver); receiver.focus(); window.qaPasted = null
          receiver.addEventListener('paste', e => { e.preventDefault(); window.qaPasted = [...e.clipboardData.files].map(f => ({ type: f.type, size: f.size })) })
        })()`)
        win.webContents.paste()
        await wait(() => run(`window.qaPasted?.some(file => file.type === 'image/png' && file.size > 0)`), viewer + ' image paste missing')
        await run(`document.getElementById('qa-paste').remove()`)
      }
      // Copying text must still use BlockNote's text/HTML behavior.
      await run(`(() => {
        const editor = document.querySelector('${prefix}.bn-editor')
        const paragraph = [...editor.querySelectorAll('[data-content-type="paragraph"]')].find(p => p.textContent.includes('일반 텍스트'))
        editor.focus(); const range = document.createRange(); range.selectNodeContents(paragraph)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      })()`)
      await pause(100)
      win.webContents.copy()
      await wait(() => clipboard.readText().includes('일반 텍스트 복사'), viewer + ' text copy broken')
    }
    // Reject invalid clipboard payloads without destroying existing clipboard data.
    await run(`window.noteDesktop.copyImage('data:image/png;base64,invalid').then(() => { throw Error('accepted invalid image') }, () => true)`)
    assert(clipboard.readText().includes('일반 텍스트 복사'))
    console.log(JSON.stringify({ markdownPng: true, markdownSvg: true, taskPng: true, taskSvg: true, nativeImagePixels: true, pasteImageFile: true, textCopy: true, invalidPayloadRejected: true }))
  } catch (error) {
    failed = true; console.error(error)
    fs.writeFileSync(path.join(os.tmpdir(), 'twill-image-copy-failed.png'), (await win.webContents.capturePage()).toPNG())
    console.error(await run(`JSON.stringify({selected:[...document.querySelectorAll('.ProseMirror-selectednode')].map(e=>e.outerHTML.slice(0,700)),focus:document.activeElement?.outerHTML.slice(0,300),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>e.textContent)})`))
  } finally {
    clipboard.clear()
    for (const [format, data] of savedClipboard) clipboard.writeBuffer(format, data)
    app.exit(failed ? 1 : 0)
  }
})
