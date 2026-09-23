// Run save and restore in separate Electron processes against /tmp/twill-qa-notes.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs')
const phase=process.env.TWILL_QA_PHASE||'save'
app.setPath('userData','/tmp/twill-workspace-flow-profile')
app.whenReady().then(async()=>{
 let failed=false
 const win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}})
 try {
  await win.loadURL(process.env.TWILL_QA_URL||'http://127.0.0.1:5178')
  const prior=phase==='restore'?JSON.parse(fs.readFileSync('/tmp/twill-workspace-flow.json','utf8')):null
  await win.webContents.executeJavaScript(`window.__qaPhase=${JSON.stringify(phase)};window.__qaPrior=${JSON.stringify(prior)}`)
  const result=await win.webContents.executeJavaScript(String.raw`(async()=>{
   const url=p=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname===p)?.name??p
   const {useAppStore:app,SYSTEM_AI_TAB}=await import(url('/src/store.ts'))
   const {useAiStore:ai}=await import(url('/src/aiStore.ts'))
   const {api}=await import(url('/src/api.ts'))
   const {serializeWorkspaceSession,parseWorkspaceSession,workspaceSessionKey}=await import(url('/src/workspaceSession.ts'))
   const pause=()=>new Promise(r=>setTimeout(r,250))
   const assert=(v,m)=>{if(!v)throw new Error(m)}
   const wait=async(fn,m)=>{for(let i=0;i<60;i++){if(fn())return fn();await pause()}throw new Error(m)}
   await wait(()=>app.getState().workspaceReady,'workspace loading')
   assert(app.getState().root.endsWith('/twill-qa-notes'),'isolated workspace required')
   api.ai.status=async()=>({engine:'codex',available:true,logged_in:true})
   api.ai.models=async()=>({models:[]})
   api.ai.usageLimits=async()=>({available:false,blocked:false})
   const {notifyAiEngineChanged}=await import(url('/src/aiMaintenance.ts'))
   notifyAiEngineChanged()
   const panel=id=>document.querySelector('[data-ai-conversation="'+id+'"]')
   const tab=id=>document.querySelector('[data-document-tab-id="'+id+'"]')
   const dock=id=>document.querySelector('[data-ai-dock-tab-id="ai:'+id+'"]')
   const drag=async(source,target,zone)=>{
    const dt=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}))
    const rect=target.getBoundingClientRect()
    const x=zone==='right'?rect.right-10:rect.left+rect.width/2,y=zone==='bottom'?rect.bottom-10:rect.top+rect.height/2
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:x,clientY:y}));await pause()
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:x,clientY:y}));await pause()
   }
   if(window.__qaPhase==='save'){
    app.setState({openTabs:[],splitLayout:null,dockedAiTabs:[],dockedAiTabId:null,view:'editor',currentPath:null,aiTabId:null})
    const a=await ai.getState().newChatSession({title:'복원 확인 대화 A'})
    const b=await ai.getState().newChatSession({title:'복원 확인 대화 B'})
    ai.setState({activeSessionId:a});app.getState().openRightTab(SYSTEM_AI_TAB)
    await wait(()=>panel(a)?.querySelector('textarea'),'initial dock')
    assert(app.getState().openTabs.length===0&&app.getState().dockedAiTabId==='ai:'+a,'AI opened in editor by default')
    app.getState().openAiSession(b);await wait(()=>panel(b)?.querySelector('textarea'),'second dock')
    assert(dock(a)&&dock(b)&&app.getState().openTabs.length===0,'second AI displaced first into editor')
    const before=new Set(ai.getState().sessions.map(s=>s.id))
    panel(b).querySelector('[title="새 대화"]').click()
    const c=await wait(()=>ai.getState().sessions.find(s=>!before.has(s.id)),'new chat')
    await wait(()=>dock(c.id),'new conversation dock tab')
    assert(app.getState().openTabs.length===0,'+ opened editor tab')
    // Real markdown link in an AI answer opens the document on the left.
    const reload=ai.getState().loadSessions
    ai.setState({loadSessions:async()=>{}})
    const answer=(id,path)=>ai.setState(s=>({sessions:s.sessions.map(x=>x.id===id?{...x,messages:[{role:'assistant',content:'[문서 보기]('+path+')'}]}:x)}))
    answer(c.id,'qa-tabs.md')
    const link=await wait(()=>panel(c.id)?.querySelector('a[title="문서 열기: qa-tabs.md"]'),'markdown link')
    link.click();await wait(()=>tab('file:qa-tabs.md'),'linked note')
    assert(document.querySelector('main').contains(tab('file:qa-tabs.md')),'link opened outside document area')
    assert(document.querySelector('#right-tool-panel').contains(panel(c.id)),'link moved AI')
    await api.createEntry('qa-session-restore.md','file').catch(()=>{})
    // Manual move is the only path putting AI into an editor group.
    await drag(dock(a),tab('file:qa-tabs.md').closest('section'),'right')
    await wait(()=>tab('ai:'+a),'manual AI split')
    answer(a,'qa-session-restore.md')
    const otherLink=await wait(()=>panel(a)?.querySelector('a[title="문서 열기: qa-session-restore.md"]'),'second markdown link')
    // Focus AI's body as a real click would do.
    otherLink.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));otherLink.click()
    await wait(()=>tab('file:qa-session-restore.md'),'second document')
    assert(tab('file:qa-session-restore.md').closest('section')!==tab('ai:'+a).closest('section'),'AI link replaced chat in its group')
    assert(tab('file:qa-session-restore.md').getBoundingClientRect().left<tab('ai:'+a).getBoundingClientRect().left,'new document must open left of AI')
    await drag(tab('file:qa-session-restore.md'),tab('file:qa-tabs.md').closest('section'),'bottom')
    ai.setState({loadSessions:reload})
    app.setState(s=>({rightDockWidth:520,sidebarWidth:280,splitLayout:{...s.splitLayout,root:{...s.splitLayout.root,ratio:62}}}))
    app.getState().openFile('qa-session-restore.md');await pause()
    const expected=serializeWorkspaceSession(app.getState())
    assert(localStorage.getItem(workspaceSessionKey(app.getState().root))===expected,'latest layout not saved')
    return {phase:'save',ids:[a,b,c.id],expected,defaultDock:true,newChatDock:true,documentLinksLeft:true,manualSplit:true}
   }
   const {ids,expected}=window.__qaPrior
   assert(serializeWorkspaceSession(app.getState())===serializeWorkspaceSession(parseWorkspaceSession(expected)),'relaunch did not restore exact layout, tabs and selected documents')
   assert(tab('ai:'+ids[0])&&dock(ids[1])&&dock(ids[2]),'AI placements not restored')
   assert(tab('file:qa-tabs.md')&&tab('file:qa-session-restore.md'),'documents not restored')
   assert(app.getState().rightDockWidth===520&&app.getState().sidebarWidth===280,'pane widths lost')
   // Delete through the real sidebar menu; cancel keeps the conversation intact.
   await wait(()=>document.querySelector('[data-ai-session-id="'+ids[1]+'"]'),'sidebar conversation')
   const showDelete=async()=>{
    const row=document.querySelector('[data-ai-session-id="'+ids[1]+'"]')
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:300}))
    await pause();[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='대화 삭제').click();await pause()
   }
   await showDelete()
   ;[...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent==='취소').click();await pause()
   assert(ai.getState().sessions.some(s=>s.id===ids[1]),'cancel deleted conversation')
   await showDelete()
   ;[...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent==='대화 삭제').click()
   await wait(()=>!ai.getState().sessions.some(s=>s.id===ids[1]),'sidebar deletion')
   assert(!dock(ids[1])&&!document.querySelector('[data-ai-session-id="'+ids[1]+'"]'),'deleted conversation still open')
   assert(tab('file:qa-tabs.md')&&tab('ai:'+ids[0]),'deletion removed unrelated tabs')
   for(const id of ids.filter(id=>id!==ids[1]))await ai.getState().closeSession(id)
   return {phase:'restore',exactLayout:true,documents:true,aiTabs:true,widths:true,sidebarDelete:true,cancelDelete:true}
  })()`)
  console.log(JSON.stringify(result))
  if(phase==='save')fs.writeFileSync('/tmp/twill-workspace-flow.json',JSON.stringify(result))
  fs.writeFileSync('/tmp/twill-workspace-flow-'+phase+'.png',(await win.webContents.capturePage()).toPNG())
 }catch(error){failed=true;console.error(error);fs.writeFileSync('/tmp/twill-workspace-flow-failed.png',(await win.webContents.capturePage()).toPNG())}
 finally{app.exit(failed?1:0)}
})
