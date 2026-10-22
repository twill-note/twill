const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'twill-interaction-'))
app.setPath('userData', profile)
// Keep the test process alive while replacing the only renderer window.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let win, failed = false
  const { readLocalStorageSnapshot, writeLocalStorageSnapshot } = await import('../electron/local-storage.mjs')
  const snapshot = path.join(profile, 'storage.json')
  ipcMain.on('desktop:local-storage-load', event => { event.returnValue = readLocalStorageSnapshot(snapshot) })
  ipcMain.on('desktop:local-storage-save', (event, value) => { event.returnValue = writeLocalStorageSnapshot(snapshot, value) })
  ipcMain.handle('desktop:window-command', () => false)
  ipcMain.handle('desktop:is-byeori-window-open', () => false)
  const create = () => new BrowserWindow({ show: false, width: 1600, height: 1000,
    webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  const run = async code => {
    const result = await win.webContents.executeJavaScript(`Promise.resolve().then(() => ${code}).then(value => ({ value }), error => ({ error: error.stack }))`)
    if (result.error) throw Error(result.error)
    return result.value
  }
  const setup = String.raw`(async () => {
    const url = p => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === p)?.name ?? p
    const { useAppStore: store } = await import(url('/src/store.ts'))
    const { useAiStore: ai } = await import(url('/src/aiStore.ts'))
    const { api } = await import(url('/src/api.ts'))
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const assert = (ok, message) => { if (!ok) throw Error(message) }
    const wait = async (fn, label) => { window.qaStep = label; for (let i = 0; i < 150; i++) { if (fn()) return fn(); await pause(100) } throw Error(label) }
    const input = (element, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }
    const key = (element, name, modifiers = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }))
    await wait(() => store.getState().workspaceReady, 'workspace loading')
    assert(store.getState().root.replaceAll('\\', '/').endsWith('/twill-qa-notes'), 'isolated workspace required')
    window.qa = { store, ai, api, url, pause, assert, wait, input, key }
  })()`
  try {
    const url = process.env.TWILL_QA_URL || 'http://127.0.0.1:18766'
    win = create(); await win.loadURL(url); await run(setup)
    const progress = setInterval(async () => { try { console.log('Interaction progress:', await run('window.qaStep')) } catch {} }, 10000)
    progress.unref()
    const fixture = await run(String.raw`(async () => {
      const { store, ai, api, url, pause, assert, wait, input, key } = window.qa
      const stamp = Date.now(), note = '찾기-' + stamp + '.md', keep = '유지-' + stamp + '.md', folder = '펼침-' + stamp
      await api.createEntry(folder + '/nested/leaf', 'file')
      await api.createEntry(note, 'file'); await api.createEntry(note.slice(0, -3) + '/child', 'file'); await api.createEntry(keep, 'file')
      const content = await api.getContent(note)
      await api.saveContent(note, content.frontmatter, 'needle 첫 결과\n\n' + Array.from({length: 70}, (_, i) => '긴 문단 ' + i).join('\n\n') + '\n\nneedle 마지막 결과', content.mtime)
      await store.getState().refreshTree()
      const row = path => document.querySelector('#workspace-sidebar').querySelector('[title="' + path + '"], [data-desktop-tooltip="' + path + '"]')
      ;(await wait(() => row(folder), 'folder missing')).click()
      ;(await wait(() => row(folder + '/nested'), 'nested missing')).click()
      await wait(() => row(folder + '/nested/leaf.md'), 'leaf missing')
      store.getState().openFile(keep)
      store.getState().openFile(note.slice(0, -3) + '/child.md')
      store.getState().openFile(note)
      store.getState().togglePinnedNote(note)
      const body = await wait(() => [...document.querySelectorAll('.bn-editor')].find(node => node.textContent.includes('마지막 결과')), 'document missing')
      // Korean web fonts can finish after the initial layout on Windows CI.
      // Measure search scrolling only after that independent layout change.
      await document.fonts.ready
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      body.focus(); key(body, 'f', { ctrlKey: true })
      const search = await wait(() => document.querySelector('[aria-label="문서 검색어"]'), 'document find missing')
      input(search, 'needle')
      const status = () => search.closest('[role="search"]').querySelector('[role="status"]').textContent
      await wait(() => status() === '1 / 2', 'document results incorrect')
      key(search, 'Enter'); await wait(() => status() === '2 / 2', 'next result missing')
      let scroller = body.parentElement
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
      assert(scroller && scroller.scrollTop > 100, 'search did not reveal last result')
      scroller.scrollTop = 100; await pause(200)
      const beforeMutation = { top: scroller.scrollTop, height: scroller.scrollHeight, status: status(), fonts: document.fonts.status }
      const toolbar = document.createElement('span'); toolbar.textContent = 'temporary image toolbar'
      body.parentElement.append(toolbar); await pause(300)
      assert(Math.abs(scroller.scrollTop - beforeMutation.top) < 3 && status() === '2 / 2', 'DOM update reset the selected match or manual scroll: ' + JSON.stringify({ before: beforeMutation, after: { top: scroller.scrollTop, height: scroller.scrollHeight, status: status(), fonts: document.fonts.status } }))
      toolbar.remove(); await pause(200)
      scroller.scrollTop = 600; await pause(100)
      key(search, 'Enter'); await wait(() => status() === '1 / 2', 'wrap navigation failed')
      assert(scroller.scrollTop < 600, 'explicit next did not scroll')
      key(search, 'Escape'); await wait(() => !document.querySelector('[aria-label="문서 검색어"]'), 'find close failed')

      api.ai.status = async () => ({ engine: 'codex', available: true, logged_in: true })
      api.ai.models = async () => ({ models: [] }); api.ai.usageLimits = async () => ({ available: false, blocked: false })
      await ai.getState().loadSessions()
      // This fixture streams local messages; metadata polling must not replace
      // them with the deliberately empty conversation stored by the backend.
      ai.setState({ loadSessions: async () => {} })
      const { notifyAiEngineChanged } = await import(url('/src/aiMaintenance.ts')); notifyAiEngineChanged()
      const id = await ai.getState().newChatSession({ title: '검색 검증' }); store.getState().openAiSession(id)
      ai.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, messages: [
        { role: 'user', content: 'needle 질문' }, { role: 'assistant', content: Array.from({ length: 60 }, (_, i) => '응답 문단 ' + i).join('\n\n') + '\n\nneedle 답변' },
      ] } : session) }))
      const chat = await wait(() => document.querySelector('[data-ai-conversation="' + id + '"]'), 'conversation missing')
      const prompt = await wait(() => chat.querySelector('textarea'), 'prompt missing')
      prompt.focus(); key(prompt, 'f', { metaKey: true })
      const chatSearch = await wait(() => chat.querySelector('[aria-label="대화 검색어"]'), 'chat find missing')
      input(chatSearch, 'needle')
      await wait(() => chatSearch.closest('[role="search"]').querySelector('[role="status"]').textContent === '1 / 2', 'chat matches incorrect')
      const chatScroll = chat.querySelector('[data-ai-message-scroll]')
      chatScroll.scrollTop = 120; await pause(100)
      ai.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, messages: [...session.messages, { role: 'assistant', content: '새 스트리밍 내용' }] } : session) }))
      await pause(400)
      assert(Math.abs(chatScroll.scrollTop - 120) < 3, 'streaming moved search scroll')
      key(chatSearch, 'Escape')

      // Delete through the real menu and confirmation; keep an unrelated tab open.
      store.getState().openFile(note)
      await wait(() => document.querySelector('.bn-editor'), 'document did not reopen')
      row(note).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }))
      ;(await wait(() => [...document.querySelectorAll('button')].find(button => button.textContent === '🗑️ 영구 삭제'), 'delete menu missing')).click()
      ;(await wait(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '영구 삭제'), 'permanent delete confirmation missing')).click()
      await wait(() => store.getState().currentPath === null && !document.querySelector('.bn-editor'), 'deleted editor did not become empty')
      assert(store.getState().openTabs.some(tab => tab.target === keep), 'unrelated tab closed')
      assert(!store.getState().openTabs.some(tab => tab.target === note || tab.target.startsWith(note.slice(0, -3) + '/')), 'child or parent tab remained')
      assert(!store.getState().pinnedNotes.includes(note), 'deleted pin remained')
      await api.getContent(note).then(() => { throw Error('deleted note still readable') }, error => assert(error.status === 404, 'wrong deletion result'))
      await pause(600)
      return { folder, note, keep }
    })()`)
    win.close()
    await new Promise(resolve => setTimeout(resolve, 150))
    win = create()
    const changedOrigin = new URL(url); changedOrigin.hostname = changedOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    await win.loadURL(changedOrigin.href); await run(setup)
    await run(`(async () => {
      const { wait, assert, store } = window.qa
      await wait(() => document.querySelector('#workspace-sidebar [data-desktop-tooltip=' + JSON.stringify(${JSON.stringify(fixture.folder + '/nested/leaf.md')}) + ']'), 'expanded folders not restored across origins')
      assert(store.getState().currentPath === null, 'deleted document restored on restart')
      assert(!document.querySelector('.bn-editor'), 'deleted pane reopened a different document')
    })()`)
    console.log(JSON.stringify({ documentFindScroll: true, chatFind: true, streamingFindScroll: true, permanentDelete: true, deletedEditorBlank: true, childTabsClosed: true, expansionAcrossRestartAndOrigin: true }))
  } catch (error) {
    failed = true; console.error(error)
    if (win && !win.isDestroyed()) {
      fs.writeFileSync(path.join(profile, 'failure.png'), (await win.webContents.capturePage()).toPNG())
      console.error(await run(`JSON.stringify({ titles: [...document.querySelectorAll('#workspace-sidebar [title]')].map(e => e.title), text: document.body.innerText.slice(-1500), path: window.qa?.store.getState().currentPath, tabs: window.qa?.store.getState().openTabs, split: window.qa?.store.getState().splitLayout })`))
    }
  } finally { app.exit(failed ? 1 : 0) }
})
