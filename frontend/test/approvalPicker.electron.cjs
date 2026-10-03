// Requires an isolated twill-qa-notes backend. Exercises the task field and shared picker.
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  let failed = false
  try {
    await win.loadURL(process.env.TWILL_QA_URL || 'http://127.0.0.1:18766')
    console.log(await win.webContents.executeJavaScript(String.raw`(async () => {
      const url = path => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === path)?.name ?? path
      const { api } = await import(url('/src/api.ts'))
      if (!(await api.workspace()).root.endsWith('/twill-qa-notes')) throw Error('isolated workspace required')
      const { default: React } = await import(url('/node_modules/.vite/deps/react.js'))
      const { createElement } = React
      const { default: ReactDOM } = await import(url('/node_modules/.vite/deps/react-dom_client.js'))
      const { createRoot } = ReactDOM
      const { default: DbCell } = await import(url('/src/components/DbCell.tsx'))
      const { setLanguage } = await import(url('/src/i18n.ts'))
      const { setNoteProp } = await import(url('/src/dbmodel.ts'))
      const assert = (ok, message) => { if (!ok) throw Error(message) }
      const wait = async fn => { for (let i=0;i<100;i++) { if (fn()) return fn(); await new Promise(r=>setTimeout(r,50)) } throw Error('Timeout: '+fn) }
      const host = document.body.appendChild(document.createElement('div'))
      host.style.cssText='position:fixed;top:100px;left:100px;z-index:9000;background:white;padding:24px'
      const root = createRoot(host)
      const column = {key:'approval',label:'모드',type:'select',visible:true,options:[]}
      let failSave = false
      let value
      const render = () => root.render(createElement(DbCell,{column,raw:value,onCommit:async next=>{
        if (failSave) throw Error('Simulated save failure')
        await setNoteProp('qa-mode.md','approval',next); value=next; render()
      }}))
      render()
      const trigger = await wait(()=>host.querySelector('button'))
      assert(trigger.textContent.includes('자동 모드'),'task should default to auto')
      trigger.click()
      await wait(()=>document.querySelector('[role="listbox"]'))
      assert(document.querySelectorAll('[role="option"]').length===2,'two fixed choices required')
      assert(document.querySelector('[role="listbox"] [aria-selected="true"]').textContent.includes('자동 모드'),'auto must be preselected')
      document.querySelectorAll('[role="option"]')[1].click()
      await wait(()=>value==='on-request')
      await wait(()=>[...document.querySelectorAll('[role="status"]')].some(item=>item.textContent.includes('저장 완료')))
      assert((await api.getContent('qa-mode.md')).frontmatter.extra.approval==='on-request','task mode was not saved')
      setLanguage('en')
      await wait(()=>trigger.textContent.includes('Approval mode'))
      trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))
      await wait(()=>document.querySelector('[role="listbox"]'))
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
      await wait(()=>!document.querySelector('[role="listbox"]'))
      assert(document.activeElement===trigger,'Escape must restore focus')
      failSave=true
      trigger.click()
      await wait(()=>document.querySelector('[role="listbox"]'))
      document.querySelectorAll('[role="listbox"] [role="option"]')[0].click()
      await wait(()=>[...document.querySelectorAll('[role="alert"]')].some(item=>item.textContent.includes('Save failed')))
      assert(value==='on-request' && trigger.textContent.includes('Approval mode'),'failed save changed selection')
      assert((await api.getContent('qa-mode.md')).frontmatter.extra.approval==='on-request','failed save changed disk')
      root.unmount();host.remove();setLanguage('ko')
      return 'PASS: automatic task default, fixed options, persistence, language switching, keyboard focus, success/error toasts, failed-save rollback'
    })()`))
  } catch (error) { failed=true; console.error(error) }
  finally { app.exit(failed ? 1 : 0) }
})
