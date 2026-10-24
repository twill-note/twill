const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twill-erd-qa-')))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadURL(process.env.TWILL_QA_URL)
    const result = await win.webContents.executeJavaScript(String.raw`(async () => {
      const url = p => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === p)?.name ?? p
      const { useAppStore: store } = await import(url('/src/store.ts'))
      const { api } = await import(url('/src/api.ts'))
      const { hasUnsavedErdTab } = await import(url('/src/plugins/erd-designer/session.ts'))
      const { IS_MAC } = await import(url('/src/shortcuts.ts'))
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
      const assert = (ok, message) => { if (!ok) throw Error(message) }
      const wait = async (fn, message) => { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await pause(100) } throw Error(message) }
      const input = (element, value) => {
        Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const key = (element, key, code = '', modifiers = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers }))
      const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true }
      const table = name => [...document.querySelectorAll('input[placeholder="table_name"]')].find(input => input.value === name)
      const button = title => document.querySelector('button[title="' + title + '"]')
      await wait(() => store.getState().workspaceReady, 'workspace missing')
      assert(store.getState().root.replaceAll('\\', '/').endsWith('/twill-qa-notes'), 'isolated workspace required')
      const stamp = Date.now(), a = 'ERD Alpha ' + stamp + '.erd.json', b = 'ERD Beta ' + stamp + '.erd.json'
      const diagram = name => ({ version: 1, meta: { title: name, dialect: 'mariadb', filenameMode: 'manual' }, relations: [], tables: [{ id: name, name, x: 80, y: 80, width: 280, color: '#3b82f6', columns: [{ id: name + '-id', name: 'id', type: 'INT', isPK: true, isFK: false, nullable: false, unique: false }] }] })
      await api.erdDesigner.save(a, diagram('alpha'), false)
      await api.erdDesigner.save(b, diagram('beta'), false)
      store.getState().openErdDesigner(a)
      await wait(() => table('alpha'), 'first ERD did not load')
      store.getState().openErdDesigner(b)
      await wait(() => table('beta') && !table('alpha'), 'second ERD retained first content')
      store.getState().activateErdTab('erd:' + a)
      input(await wait(() => table('alpha'), 'cached first ERD missing'), 'alpha_edited')
      await wait(() => hasUnsavedErdTab('erd:' + a), 'dirty flag missing')
      store.getState().activateErdTab('erd:' + b)
      await wait(() => table('beta') && !table('alpha_edited'), 'edit leaked to second ERD')
      store.getState().activateErdTab('erd:' + a)
      await wait(() => table('alpha_edited'), 'unsaved edit lost on return')
      assert(hasUnsavedErdTab('erd:' + a), 'dirty edit treated as saved after remount')
      button('저장').click()
      await wait(async () => (await api.erdDesigner.get(a)).diagram.tables[0].name === 'alpha_edited', 'ERD save failed')
      await wait(() => !button('저장').textContent.includes('저장 중'), 'initial save did not settle')

      button('SQL DDL 가져오기').click()
      const sql = await wait(() => document.querySelector('textarea[placeholder^="CREATE TABLE"]'), 'SQL import missing')
      input(sql, 'CREATE TABLE customers (id INT PRIMARY KEY); CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, FOREIGN KEY (customer_id) REFERENCES customers(id));')
      ;[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '테이블 가져오기').click()
      await wait(() => table('customers') && table('orders'), 'DDL tables not imported')
      button('SQL DDL 내보내기').click()
      const exported = await wait(() => document.querySelector('textarea[readonly]'), 'SQL export missing')
      assert(exported.value.includes('alpha_edited') && exported.value.includes('FOREIGN KEY') && exported.value.includes('customers'), 'SQL export lost table or relation')
      exported.parentElement.querySelectorAll('button')[2].click()
      // The file can be saved before its tree refresh finishes. Editing during
      // that interval must restore the tab's dirty flag and retain the new draft.
      const originalTree = api.tree
      let releaseTree
      const treeGate = new Promise(resolve => { releaseTree = resolve })
      api.tree = async () => { await treeGate; return originalTree() }
      button('저장').click()
      await wait(async () => (await api.erdDesigner.get(a)).diagram.relations.length === 1 && !hasUnsavedErdTab('erd:' + a), 'imported relation not saved')
      input(table('alpha_edited'), 'alpha_during_save')
      await wait(() => hasUnsavedErdTab('erd:' + a), 'edit during save lost dirty flag')
      api.tree = originalTree
      releaseTree()
      await wait(() => !button('저장').textContent.includes('저장 중'), 'SQL save did not settle')
      assert(table('alpha_during_save') && hasUnsavedErdTab('erd:' + a), 'save completion lost new edit')

      // A response to A's save must never overwrite B after switching tabs.
      const originalSave = api.erdDesigner.save
      let release, started = false
      const gate = new Promise(resolve => { release = resolve })
      api.erdDesigner.save = async (...args) => { started = true; await gate; return originalSave(...args) }
      input(table('alpha_during_save'), 'alpha_delayed')
      await wait(() => hasUnsavedErdTab('erd:' + a), 'second edit missing')
      button('저장').click(); await wait(() => started, 'delayed save not started')
      store.getState().activateErdTab('erd:' + b)
      await wait(() => table('beta'), 'second ERD missing during save')
      release()
      await wait(async () => (await api.erdDesigner.get(a)).diagram.tables[0].name === 'alpha_delayed', 'background save missing')
      assert(table('beta') && !table('alpha_delayed'), 'background save replaced another document')
      api.erdDesigner.save = originalSave
      store.getState().activateErdTab('erd:' + a)
      await wait(() => table('alpha_delayed') && !hasUnsavedErdTab('erd:' + a), 'saved state not restored')

      const note = '열린 문서 검색 ' + stamp + '.md'
      await api.createEntry(note, 'file')
      store.getState().openFile(note)
      await wait(() => document.querySelector('.bn-editor'), 'note missing')
      key(document.activeElement, 'e', 'KeyE', mod)
      const search = await wait(() => document.querySelector('[aria-label="열린 문서 검색"]'), 'open document picker missing')
      input(search, 'ERD Beta')
      await wait(() => document.querySelectorAll('#open-documents-list [role="option"]').length === 1, 'ERD title search failed')
      key(search, 'Enter')
      await wait(() => table('beta') && !document.querySelector('[aria-label="열린 문서 검색"]'), 'picker did not navigate to existing ERD')
      key(document.body, 'e', 'KeyE', mod)
      const nextSearch = await wait(() => document.querySelector('[aria-label="열린 문서 검색"]'), 'picker did not reopen')
      input(nextSearch, '열린 문서 검색')
      await wait(() => document.querySelectorAll('#open-documents-list [role="option"]').length === 1, 'Korean spaced title search failed')
      document.querySelector('#open-documents-list [role="option"]').click()
      await wait(() => store.getState().currentPath === note, 'picker click failed')
      key(document.body, 'e', 'KeyE', mod)
      const escaped = await wait(() => document.querySelector('[aria-label="열린 문서 검색"]'), 'picker missing before Escape')
      key(escaped, 'Escape')
      assert(store.getState().currentPath === note, 'Escape changed document')

      store.getState().openErdDesigner('missing-' + stamp + '.erd.json')
      await wait(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('찾을 수')), 'ERD load error hidden')
      assert(!document.querySelector('input[placeholder="table_name"]'), 'failed load displayed previous diagram')
      await api.erdDesigner.save('missing-' + stamp + '.erd.json', diagram('recovered'), false)
      document.querySelector('[role="alert"] button').click()
      await wait(() => table('recovered'), 'retry did not load repaired diagram')
      return { erdSwitch: true, cachedSwitch: true, dirtyPreserved: true, save: true, sqlImportExportAndRelation: true, editDuringSavePreserved: true, inFlightSaveIsolation: true, loadError: true, openDocumentShortcut: true, titleFilter: true, clickAndEnter: true, escape: true }
    })().catch(error => ({ error: error.stack }))`)
    if (result.error) throw Error(result.error)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error)
    console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-3500)'))
    fs.writeFileSync(path.join(os.tmpdir(), 'twill-erd-navigation-failed.png'), (await win.webContents.capturePage()).toPNG())
    app.exit(1); return
  }
  app.exit(0)
})
