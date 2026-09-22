// Requires an isolated dev backend: NOTES_DIR=/tmp/twill-qa-notes, with qa-tabs.md.
// No AI requests are sent; only test conversation metadata uses the fixture backend.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  let failed = false
  try {
    await win.loadURL(process.env.TWILL_QA_URL || 'http://127.0.0.1:5178')
    const result = await win.webContents.executeJavaScript(String.raw`(async () => {
      const url = path => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === path)?.name ?? path
      const { useAppStore: app, SYSTEM_AI_TAB } = await import(url('/src/store.ts'))
      const { useAiStore: ai } = await import(url('/src/aiStore.ts'))
      const { api } = await import(url('/src/api.ts'))
      const { aiBus } = await import(url('/src/aiBus.ts'))
      const { notifyAiEngineChanged } = await import(url('/src/aiMaintenance.ts'))
      const workspace = await api.workspace()
      if (!workspace.root.endsWith('/twill-qa-notes')) throw new Error('Use an isolated twill-qa-notes workspace')
      const pause = () => new Promise(r => setTimeout(r, 250))
      const assert = (value, label) => { if (!value) throw new Error(label) }
      const waitFor = async (fn, label) => { for (let i=0;i<40;i++) { if (fn()) return fn(); await pause() } throw new Error(label) }
      api.ai.status = async () => ({ engine: 'codex', available: true, logged_in: true })
      api.ai.models = async () => ({ models: [] })
      api.ai.usageLimits = async () => ({ available: false, blocked: false })
      const sends = [], cancellations = []
      ai.setState({ sendChat: (id, text, options) => sends.push({ id, text, options }), cancel: id => cancellations.push(id) })
      notifyAiEngineChanged()
      app.setState({ openTabs: [], currentPath: null, view: 'editor', aiTabId: null, dockedAiTabId: SYSTEM_AI_TAB })
      const a = await ai.getState().newChatSession({ title: '첫 번째 AI 대화 — 긴 제목도 탭에서는 짧게 표시' })
      const b = await ai.getState().newChatSession({ title: '두 번째 AI 대화' })
      const c = await ai.getState().newChatSession({ title: '선택 문맥 수신 대화' })
      assert(a && b && c, 'fixture conversations failed')
      const fixtureIds = [a,b,c]
      const tab = id => document.querySelector('[data-document-tab-id="ai:'+id+'"]')
      const panel = id => document.querySelector('[data-ai-conversation="'+id+'"]')
      const input = id => panel(id)?.querySelector('textarea')
      const setDraft = (id, value) => {
        const element=input(id)
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element,value)
        element.dispatchEvent(new Event('input', { bubbles:true }))
      }
      const drag = async (source, target, zone) => {
        const dt = new DataTransfer()
        source.dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:dt }))
        const rect = target.getBoundingClientRect()
        const clientX=zone==='left'?rect.left+10:zone==='right'?rect.right-10:rect.left+rect.width/2
        const clientY=rect.top+rect.height/2
        target.dispatchEvent(new DragEvent('dragover', { bubbles:true,cancelable:true,dataTransfer:dt,clientX,clientY }))
        await pause()
        target.dispatchEvent(new DragEvent('drop', { bubbles:true,cancelable:true,dataTransfer:dt,clientX,clientY }))
        await pause()
      }
      try {
        app.getState().openFile('qa-tabs.md'); await pause()
        app.getState().openAiSession(a)
        await waitFor(() => input(a), 'first composer missing')
        setDraft(a,'A 전용 한글 초안'); await pause()
        app.getState().openAiSession(b)
        await waitFor(() => input(b), 'second composer missing')
        setDraft(b,'B 전용 한글 초안'); await pause()
        assert(input(a).value==='A 전용 한글 초안','opening B changed A draft')
        const firstInput=input(a), secondInput=input(b)
        await drag(tab(b),tab(a).closest('section'),'right')
        assert(panel(a).getBoundingClientRect().width>0 && panel(b).getBoundingClientRect().width>0,'two conversations are not visible together')
        assert(firstInput===input(a)&&secondInput===input(b),'splitting remounted a composer')
        assert(tab(a).textContent.includes('첫 번째')&&tab(b).textContent.includes('두 번째'),'titles missing from tabs')
        api.uploadAsset=async()=>'/assets/qa-attachment.txt'
        const files=new DataTransfer()
        files.items.add(new File(['A attachment'],'A전용첨부.txt',{type:'text/plain'}))
        panel(a).querySelector('input[type="file"]').files=files.files
        panel(a).querySelector('input[type="file"]').dispatchEvent(new Event('change',{bubbles:true}))
        await waitFor(()=>panel(a).textContent.includes('A전용첨부.txt'),'attachment missing')
        assert(!panel(b).textContent.includes('A전용첨부.txt'),'attachment leaked to B')
        // Stream updates target one pinned conversation regardless of the globally selected session.
        const reload=ai.getState().loadSessions
        ai.setState({loadSessions:async()=>{}})
        ai.setState(state=>({ sessions:state.sessions.map(s=>s.id===a?{...s,messages:[{role:'assistant',content:'A 전용 응답\n\n'.repeat(80)}]}:s.id===b?{...s,messages:[{role:'assistant',content:'B 전용 응답'}]}:s) }))
        await pause()
        assert(panel(a).textContent.includes('A 전용 응답')&&!panel(a).textContent.includes('B 전용 응답'),'A messages mixed')
        assert(panel(b).textContent.includes('B 전용 응답')&&!panel(b).textContent.includes('A 전용 응답'),'B messages mixed')
        const scrollA=panel(a).querySelector('[data-ai-message-scroll]')
        scrollA.scrollTop=50;scrollA.dispatchEvent(new Event('scroll',{bubbles:true}));await pause()
        ai.setState(state=>({sessions:state.sessions.map(s=>s.id===b?{...s,messages:[...s.messages,{role:'assistant',content:'B 추가 응답'}]}:s)}));await pause()
        assert(Math.abs(scrollA.scrollTop-50)<2,'B streaming moved A scroll')
        input(a).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await pause()
        assert(sends.at(-1)?.id===a&&sends.at(-1)?.text==='A 전용 한글 초안','A sent to wrong session')
        assert(sends.at(-1).options.files[0].name==='A전용첨부.txt','A attachment sent to wrong session')
        assert(input(b).value==='B 전용 한글 초안','sending A cleared B')
        ai.setState(state=>({sessions:state.sessions.map(s=>s.id===a||s.id===b?{...s,busy:true,runStartedAt:Date.now()}:s)}));await pause()
        ;[...panel(a).querySelectorAll('button')].find(button=>button.textContent==='중단').click();await pause()
        assert(cancellations.length===1&&cancellations[0]===a,'cancel reached the other conversation')
        ai.setState(state=>({loadSessions:reload,sessions:state.sessions.map(s=>s.id===a||s.id===b?{...s,busy:false}:s)}))
        setDraft(a,'A 유지 초안');await pause()
        // Context insertion emitted before the destination pane mounts must reach only that pane.
        ai.setState({activeSessionId:c});app.getState().openRightTab(SYSTEM_AI_TAB)
        aiBus.emit({type:'insertContext',text:'선택 문맥',prompt:'C에만 넣을 질문',documentPath:'qa-tabs.md',includeDocument:true})
        await waitFor(()=>input(c)?.value==='C에만 넣을 질문','queued context was lost')
        assert(input(a).value==='A 유지 초안'&&input(b).value==='B 전용 한글 초안','context leaked into other tabs')
        app.getState().openAiSession(b);await pause()
        const before=new Set(ai.getState().sessions.map(s=>s.id))
        panel(b).querySelector('[title="새 대화"]').click()
        const created=await waitFor(()=>ai.getState().sessions.find(s=>!before.has(s.id)),'+ did not create conversation')
        fixtureIds.push(created.id)
        await waitFor(()=>tab(created.id)&&input(created.id),'+ did not create document tab')
        assert(input(created.id).value===''&&input(b).value==='B 전용 한글 초안','new conversation inherited or erased draft')
        // Focus A by clicking its body, so the next new tab goes to A's group.
        app.getState().openAiSession(a);await pause()
        const aPane=tab(a).closest('section')
        await ai.getState().renameSession(a,'첫 번째 제목 변경')
        await waitFor(()=>tab(a).textContent.includes('제목 변경'),'rename did not update tab')
        await drag(tab(b),document.querySelector('[aria-label="우측 도구"]'),'center')
        assert(app.getState().dockedAiTabId==='ai:'+b&&input(b)===secondInput,'docking changed B composer')
        assert(input(a).value==='A 유지 초안','docking B changed A')
        await drag(tab(a),document.querySelector('[aria-label="우측 도구"]'),'center')
        await waitFor(()=>tab(b),'replacing dock lost previous conversation tab')
        assert(input(b)===secondInput,'replacing dock discarded B draft')
        const dockHeader=document.querySelector('#right-tool-panel [draggable="true"]')
        await drag(dockHeader,tab(b).closest('section'),'left')
        assert(input(a)===firstInput&&input(b)===secondInput,'moving from dock remounted composer')
        app.getState().closeTab('ai:'+b);await pause()
        assert(ai.getState().sessions.some(s=>s.id===b)&&cancellations.length===1,'closing tab deleted or cancelled conversation')
        app.getState().openAiSession(b);await waitFor(()=>input(b),'closed conversation cannot reopen')
        await ai.getState().closeSession(c);await pause()
        assert(!tab(c)&&!panel(c),'deleted conversation tab remains')
        // Fullscreen tools retain conversation tabs and return to the right session.
        app.getState().setView('calendar');await pause()
        const back=[...document.querySelectorAll('main > div:first-child button')].find(e=>e.textContent.includes('두 번째'))
        assert(back,'calendar lost conversation tabs');back.click();await pause()
        assert(app.getState().aiTabId==='ai:'+b,'calendar returned to wrong session')
        const {runAllTasks}=await import(url('/src/components/TaskRunButton.tsx'))
        ai.setState({runTask:async()=>a,startRunOrderPlan:async()=>b})
        await runAllTasks([{path:'qa-task.md',title:'QA task',props:{}}]);await pause()
        assert(app.getState().aiTabId==='ai:'+a,'task action opened the wrong conversation')
        await runAllTasks([{path:'qa-1.md',props:{}},{path:'qa-2.md',props:{}}]);await pause()
        assert(app.getState().aiTabId==='ai:'+b,'batch plan did not open its conversation')
        return {independentMessages:true,independentDrafts:true,independentScroll:true,attachments:true,sendRouting:true,cancelRouting:true,contextRouting:true,newConversationTab:true,splitAndDock:true,renameSync:true,closeWithoutDelete:true,deleteCleanup:true,boardReturn:true,taskEntry:true}
      } finally { window.__twillQaSessions=fixtureIds }
    })()`)
    console.log(JSON.stringify(result))
    fs.writeFileSync('/tmp/twill-multichat.png',(await win.webContents.capturePage()).toPNG())
  } catch(error) {
    failed=true
    console.error(error)
    fs.writeFileSync('/tmp/twill-multichat-failed.png',(await win.webContents.capturePage()).toPNG())
  } finally {
    await win.webContents.executeJavaScript(`(async()=>{
      const url=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/aiStore.ts')?.name
      if(!url)return
      const {useAiStore}=await import(url)
      for(const id of window.__twillQaSessions??[])await useAiStore.getState().closeSession(id)
    })()`).catch(()=>{})
    app.exit(failed?1:0)
  }
})
