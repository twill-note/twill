// Run against an isolated backend + Vite server; never uses the user's notes.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twill-document-ui-')))
app.whenReady().then(async () => {
  let failed = false
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadURL(process.env.TWILL_QA_URL || 'http://127.0.0.1:18766')
    const result = await win.webContents.executeJavaScript(String.raw`(async () => {
      const moduleUrl = p => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === p)?.name ?? p
      const { useAppStore: store } = await import(moduleUrl('/src/store.ts'))
      const { useAiStore: ai } = await import(moduleUrl('/src/aiStore.ts'))
      const { api } = await import(moduleUrl('/src/api.ts'))
      const assert = (ok, message) => { if (!ok) throw Error(message) }
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
      const wait = async (fn, message) => { for (let i = 0; i < 150; i++) { if (fn()) return fn(); await pause(100) } throw Error(message) }
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const enter = input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await wait(() => store.getState().workspaceReady, 'workspace loading')
      assert(store.getState().root.replaceAll('\\', '/').endsWith('/twill-qa-notes'), 'isolated workspace required')
      const stamp = String(Date.now())
      const original = 'UI-' + stamp
      const renamed = original + '-renamed'
      const sidebar = document.querySelector('#workspace-sidebar')
      // Attachments and ERD rows used to mount additional root inputs, whose
      // autofocus cancelled the real input before the user could enter a name.
      await api.importFiles([
        new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'root-' + stamp + '.svg', { type: 'image/svg+xml' }),
        new File(['{}'], 'root-' + stamp + '.erd.json', { type: 'application/json' }),
      ], '')
      const project = (await api.workspaceSettings.createProjectSection('Project-' + stamp)).section
      await store.getState().refreshSections()
      await store.getState().refreshTree()
      const section = name => [...sidebar.querySelectorAll('button')].find(button => button.querySelector('.truncate')?.textContent === name)?.parentElement
      const rootSection = await wait(() => section('twill-qa-notes'), 'root section missing')
      const projectSection = await wait(() => section(project.name), 'project section missing')
      assert(rootSection.getBoundingClientRect().top < projectSection.getBoundingClientRect().top, 'root must stay above projects')

      // Keep streaming session data while creating a root note through the real UI.
      const sessions = ai.getState().sessions
      const session = { id: 'ui-stream', title: 'Streaming', kind: 'chat', busy: true, queued: false,
        scopeId: null, sectionId: null, updatedAt: 1, messages: [] }
      let chunks = 0
      const stream = setInterval(() => ai.setState({ sessions: [...sessions, { ...session,
        messages: [{ role: 'assistant', content: 'stream '.repeat(++chunks) }] }] }), 16)
      try {
        sidebar.querySelector('[title="루트에 새 노트"]').click()
        const input = await wait(() => sidebar.querySelector('input[placeholder="새 노트 이름"]'), 'root input missing')
        await pause(150)
        assert(input.isConnected && document.activeElement === input, 'root input lost focus to an attachment row')
        assert(sidebar.querySelectorAll('input[placeholder="새 노트 이름"]').length === 1, 'duplicate root creation inputs')
        assert(input.getBoundingClientRect().top < projectSection.getBoundingClientRect().top, 'root input below projects')
        setInput(input, original)
        // Korean IME confirmation must not submit; the following Enter submits once.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
        assert(input.isConnected, 'IME prematurely submitted')
        enter(input)
        await wait(() => store.getState().currentPath === original + '.md', 'root note not created')
        await wait(() => document.querySelector('input[placeholder="제목 없음"]'), 'editor missing')
        assert(!document.querySelector('[role="dialog"]'), 'duplicate creation dialog')
      } finally { clearInterval(stream); ai.setState({ sessions }) }

      sidebar.querySelector('[title="루트에 새 폴더"]').click()
      const folderInput = await wait(() => sidebar.querySelector('input[placeholder="새 폴더 이름"]'), 'root folder input missing')
      await pause(150)
      assert(folderInput.isConnected && document.activeElement === folderInput, 'root folder input lost focus')
      setInput(folderInput, original + '-folder')
      enter(folderInput)
      await wait(() => store.getState().tree.some(node => node.path === original + '-folder' && node.type === 'dir'), 'root folder not created')

      await api.createEntry(original + '/child', 'file')
      await store.getState().refreshTree()
      const title = document.querySelector('input[placeholder="제목 없음"]')
      const body = document.querySelector('.bn-editor[contenteditable="true"]')
      const tabCount = store.getState().openTabs.length
      title.focus()
      setInput(title, renamed)
      await wait(() => store.getState().currentPath === renamed + '.md', 'title did not rename document')
      assert(document.activeElement === title && title.isConnected, 'rename lost title focus')
      assert(document.querySelector('.bn-editor[contenteditable="true"]') === body, 'rename remounted editor')
      assert(store.getState().openTabs.length === tabCount, 'rename created a duplicate tab')
      assert((await api.getContent(renamed + '/child.md')).path === renamed + '/child.md', 'child note not renamed')

      // A pending title save and drag must use the final path, preserving the viewer.
      const finalTitle = renamed + '-pending'
      setInput(title, finalTitle)
      const drag = async (source, target) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.setData('text/note-path', source)
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
      }
      const directory = project.items[0]
      await drag(renamed + '.md', projectSection)
      const moved = directory + '/' + finalTitle + '.md'
      await wait(() => store.getState().currentPath === moved, 'move with pending title failed')
      assert(store.getState().openTabs.length === tabCount, 'move created duplicate viewer')
      assert(document.querySelector('.bn-editor[contenteditable="true"]') === body, 'move remounted editor')
      setInput(title, finalTitle + '-saved')
      const movedAgain = directory + '/' + finalTitle + '-saved.md'
      await wait(() => store.getState().currentPath === movedAgain, 'save after move used stale path')
      await drag(movedAgain, rootSection)
      const atRoot = finalTitle + '-saved.md'
      await wait(() => store.getState().currentPath === atRoot, 'move back to root failed')
      assert((await api.getContent(atRoot)).frontmatter.title === finalTitle + '-saved', 'saved title mismatch')
      assert(store.getState().openTabs.length === tabCount, 'root move duplicated tab')
      assert(!store.getState().openTabs.some(tab => tab.target === original + '.md'), 'stale tab remains')

      // Root context-menu creation must work even when the root is collapsed.
      rootSection.querySelector('button').click()
      rootSection.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }))
      const newNote = await wait(() => [...document.querySelectorAll('button')].find(button => button.textContent === '📄 새 노트'), 'root context menu missing')
      newNote.click()
      const contextInput = await wait(() => sidebar.querySelector('input[placeholder="새 노트 이름"]'), 'collapsed root input missing')
      setInput(contextInput, original + '-context')
      enter(contextInput)
      await wait(() => store.getState().currentPath === original + '-context.md', 'context menu note creation failed')

      const childPath = atRoot.slice(0, -3) + '/child.md'
      store.getState().openFile(childPath)
      const parentId = 'file:' + atRoot, childId = 'file:' + childPath
      store.setState({ openTabs: store.getState().openTabs.filter(tab => [parentId, childId].includes(tab.id)),
        splitLayout: { activePanelId: 'qa-child', root: { kind: 'split', id: 'qa-split', direction: 'horizontal', ratio: 55,
          first: { kind: 'panel', id: 'qa-parent', tabIds: [parentId], activeTabId: parentId },
          second: { kind: 'panel', id: 'qa-child', tabIds: [childId], activeTabId: childId } } } })
      await wait(() => document.querySelectorAll('.bn-editor[contenteditable="true"]').length === 2, 'split editors missing')
      const editors = [...document.querySelectorAll('.bn-editor[contenteditable="true"]')]
      await pause(200)
      await drag(atRoot, projectSection)
      await wait(() => store.getState().currentPath === directory + '/' + childPath, 'child viewer path stale after parent move')
      assert(store.getState().openTabs.length === 2, 'split move changed tab count')
      assert(editors.every(editor => editor.isConnected), 'split move replaced editors')
      assert(store.getState().splitLayout.root.ratio === 55, 'split proportions lost')
      return { rootAboveProjects: true, rootCreationDuringStream: true, streamChunks: chunks,
        titleRenamesFile: true, childNotesPreserved: true, focusPreserved: true,
        pendingSaveThenMove: true, editorPreserved: true, moveBackToRoot: true,
        collapsedRootContextCreation: true, splitParentAndChildMove: true, rootWithAttachments: true, rootFolderCreation: true }
    })()`)
    console.log(JSON.stringify(result))
  } catch (error) {
    failed = true
    console.error(error)
    fs.writeFileSync(path.join(os.tmpdir(), 'twill-document-ui-failed.png'), (await win.webContents.capturePage()).toPNG())
  } finally { app.exit(failed ? 1 : 0) }
})
