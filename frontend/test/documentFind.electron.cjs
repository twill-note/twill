const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  try {
    await win.loadURL(process.env.TWILL_QA_URL || 'http://127.0.0.1:18766')
    console.log(await win.webContents.executeJavaScript(String.raw`(async () => {
      const url = path => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === path)?.name ?? path
      const { useAppStore: store } = await import(url('/src/store.ts'))
      const { api } = await import(url('/src/api.ts'))
      const assert = (ok,label) => { if (!ok) throw Error(label) }
      const wait = async fn => { for(let i=0;i<100;i++) { if(fn()) return fn(); await new Promise(r=>setTimeout(r,100)) } throw Error('UI timeout: '+fn.toString()) }
      assert((await api.workspace()).root.endsWith('/twill-qa-notes'),'isolated workspace required')
      await wait(()=>store.getState().workspaceReady)
      store.getState().openFile('qa-tabs.md')
      const body = await wait(()=>document.querySelector('.bn-editor[contenteditable="true"]'))
      await wait(()=>body.textContent.includes('Testing'))
      const before = body.innerHTML
      body.focus()
      body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))
      const input = await wait(()=>document.querySelector('[aria-label="문서 검색어"]'))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'testing')
      input.dispatchEvent(new Event('input',{bubbles:true}))
      await wait(()=>document.querySelector('[role="search"] [role="status"]')?.textContent==='1 / 1')
      assert(CSS.highlights.size>=2,'missing highlights')
      const setQuery = value => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})) }
      setQuery('t')
      await wait(()=>Number(document.querySelector('[role="search"] [role="status"]').textContent.split(' / ')[1])>1)
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
      await wait(()=>document.querySelector('[role="search"] [role="status"]').textContent.startsWith('2 / '))
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}))
      await wait(()=>document.querySelector('[role="search"] [role="status"]').textContent.startsWith('1 / '))
      setQuery('no-match-xyz')
      await wait(()=>document.querySelector('[role="search"] [role="status"]').textContent==='0 / 0')
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
      await wait(()=>!document.querySelector('[aria-label="문서 검색어"]'))
      assert(CSS.highlights.size===0,'highlight cleanup')
      assert(body.innerHTML===before,'find changed document')
      body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true,cancelable:true}))
      await wait(()=>document.querySelector('[aria-label="문서 검색어"]'))
      const { documentMatches } = await import(url('/src/components/DocumentFind.tsx'))
      const root=document.createElement('div')
      root.innerHTML='<p class="bn-inline-content">한글 <b>키워</b>드 a.b İ END END</p><p class="bn-inline-content">다음 문단</p>'
      assert(documentMatches(root,'키워드')[0]?.toString()==='키워드','inline formatting search')
      assert(documentMatches(root,'a.b').length===1,'literal punctuation')
      assert(documentMatches(root,'end').length===2,'case insensitive repeated matches')
      assert(documentMatches(root,'END 다음').length===0,'paragraph boundary')
      assert(documentMatches(root,'').length===0,'empty query')
      return 'PASS: Ctrl+F, Cmd+F, highlights, Escape, unchanged content, formatted text, Korean, literal search'
    })()`))
  } catch(error) { console.error(error); app.exit(1) }
  finally { win.destroy(); app.quit() }
})
