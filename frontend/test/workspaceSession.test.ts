import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspaceSession, serializeWorkspaceSession, workspaceSessionKey, type WorkspaceSession } from '../src/workspaceSession.ts'

const documentTab = { id:'file:한글.md', kind:'file' as const, target:'한글.md', title:'한글', icon:'📄' }
const aiTab = { id:'ai:one', kind:'ai' as const, target:'one', title:'첫 대화', icon:'✦' }
const state: WorkspaceSession = {
  openTabs:[documentTab,aiTab], dockedAiTabs:[{...aiTab,id:'ai:two',target:'two'}], dockedAiTabId:'ai:two',
  aiTabId:'ai:one', currentPath:'한글.md', view:'ai', dbDir:null, erdTabId:null, erdPath:null, erdDirectory:null, pluginViewId:null,
  rightDockOpen:true,activeRightTab:'system:ai',rightDockWidth:510,sidebarWidth:280,
  splitLayout:{activePanelId:'right',root:{kind:'split',id:'split',direction:'horizontal',ratio:38,
    first:{kind:'panel',id:'left',tabIds:[documentTab.id],activeTabId:documentTab.id},
    second:{kind:'panel',id:'right',tabIds:[aiTab.id],activeTabId:aiTab.id}}},
}
test('workspace session restores titles, selections, split ratio and dock dimensions',()=>{
  assert.deepEqual(parseWorkspaceSession(serializeWorkspaceSession(state)),state)
  assert.notEqual(workspaceSessionKey('/notes/one'),workspaceSessionKey('/notes/two'))
})
test('unsaved ERD tabs are not restored as empty documents; their empty split is removed',()=>{
  const unsaved={id:'erd:unsaved',kind:'erd' as const,target:'unsaved',title:'미저장 ERD',icon:'',erdPath:null}
  const saved=serializeWorkspaceSession({...state,openTabs:[documentTab,unsaved],view:'erd',erdTabId:unsaved.id,
    splitLayout:{activePanelId:'missing',root:{kind:'split',id:'split',direction:'vertical',ratio:45,
      first:{kind:'panel',id:'left',tabIds:[documentTab.id],activeTabId:documentTab.id},
      second:{kind:'panel',id:'right',tabIds:[unsaved.id],activeTabId:unsaved.id}}}})
  const restored=parseWorkspaceSession(saved)!
  assert.deepEqual(restored.openTabs,[documentTab])
  assert.equal(restored.view,'editor')
  assert.equal(restored.splitLayout?.root.kind,'panel')
  assert.equal(restored.splitLayout?.activePanelId,'left')
})
test('corrupt, foreign-version and duplicated layout entries do not break startup',()=>{
  assert.equal(parseWorkspaceSession('{bad'),null)
  assert.equal(parseWorkspaceSession('{"version":99}'),null)
  const raw=JSON.parse(serializeWorkspaceSession(state))
  raw.splitLayout.root.ratio=900
  raw.splitLayout.root.second.tabIds=[documentTab.id,aiTab.id]
  raw.openTabs.push({...documentTab})
  const restored=parseWorkspaceSession(JSON.stringify(raw))!
  assert.equal(restored.openTabs.length,2)
  assert.equal(restored.splitLayout?.root.kind==='split'&&restored.splitLayout.root.ratio,80)
  assert.deepEqual(restored.splitLayout?.root.kind==='split'&&restored.splitLayout.root.second.kind==='panel'&&restored.splitLayout.root.second.tabIds,[aiTab.id])
})
