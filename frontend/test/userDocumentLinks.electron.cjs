// No model requests: verify mention selection, submission context and rendered navigation.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'twill-links-qa-')))
app.whenReady().then(async () => {
  let failed = false
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadURL(process.env.TWILL_QA_URL || 'http://127.0.0.1:18766')
    const result = await win.webContents.executeJavaScript(String.raw`(async () => {
      const url = p => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === p)?.name ?? p
      const { useAppStore: store } = await import(url('/src/store.ts'))
      const { useAiStore: ai } = await import(url('/src/aiStore.ts'))
      const { api } = await import(url('/src/api.ts'))
      const { notifyAiEngineChanged } = await import(url('/src/aiMaintenance.ts'))
      const pause = ms => new Promise(r => setTimeout(r, ms))
      const assert = (ok, label) => { if (!ok) throw Error(label) }
      const wait = async (fn, label) => { for (let i = 0; i < 100; i++) { if (fn()) return fn(); await pause(100) } throw Error(label) }
      await wait(() => store.getState().workspaceReady, 'workspace missing')
      assert(store.getState().root.endsWith('/twill-qa-notes'), 'isolated workspace required')
      const name = '공백 문서 ' + Date.now() + '.md'
      await api.createEntry(name, 'file')
      await store.getState().refreshTree()
      api.ai.status = async () => ({ engine: 'codex', available: true, logged_in: true })
      api.ai.models = async () => ({ models: [] })
      api.ai.usageLimits = async () => ({ available: false, blocked: false })
      const sends = []
      ai.setState({ sendChat: (id, text, options) => sends.push({ id, text, options }) })
      notifyAiEngineChanged()
      const id = await ai.getState().newChatSession({ title: '문서 참조 QA' })
      store.getState().openAiSession(id)
      const panel = () => document.querySelector('[data-ai-conversation="' + id + '"]')
      const input = await wait(() => panel()?.querySelector('textarea'), 'chat input missing')
      input.focus()
      const draft = '@공백 문서'
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, draft)
      input.setSelectionRange(draft.length, draft.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const pick = await wait(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes(name)), 'spaced mention search missing')
      pick.click()
      await wait(() => input.value === '@' + name + ' ', 'selected path incomplete')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await wait(() => sends.length, 'mention not submitted')
      assert(sends[0].options.mentionPaths[0] === name, 'spaced document context lost')
      ai.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, messages: [
        { role: 'user', content: '@' + name + ' 확인\n\n[원문](twill://open?path=' + encodeURIComponent(name) + ')\n\n[위험](javascript:alert(1))' },
      ] } : session) }))
      const links = await wait(() => { const all = panel()?.querySelectorAll('.chat-user-bubble a[title="문서 열기: ' + name + '"]'); return all?.length === 2 && all }, 'user document links missing')
      assert(!panel().querySelector('a[href^="javascript:"]'), 'unsafe link survived')
      links[0].click()
      await wait(() => store.getState().currentPath === name, 'user mention navigation failed')
      store.getState().closeTab('file:' + name)
      links[1].click()
      await wait(() => store.getState().currentPath === name, 'user Markdown link navigation failed')
      return { spacedSearch: true, mentionContext: true, userMentionLink: true, userMarkdownLink: true, safeNavigation: true }
    })().catch(error => ({ error: error.stack }))`)
    if (result.error) throw Error(result.error)
    console.log(JSON.stringify(result))
  } catch (error) {
    failed = true; console.error(error)
    fs.writeFileSync(path.join(os.tmpdir(), 'twill-user-links-failed.png'), (await win.webContents.capturePage()).toPNG())
  } finally { app.exit(failed ? 1 : 0) }
})
