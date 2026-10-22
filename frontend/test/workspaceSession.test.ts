import test from 'node:test'
import assert from 'node:assert/strict'
import { forgetWorkspaceDocuments, remapDocumentPath, relocateWorkspaceDocuments } from '../src/documentPaths.ts'
import { parseWorkspaceSession, serializeWorkspaceSession, workspaceSessionKey, type WorkspaceSession } from '../src/workspaceSession.ts'

const documentTab = { id:'file:한글.md', kind:'file' as const, target:'한글.md', title:'한글', icon:'📄' }
const aiTab = { id:'ai:one', kind:'ai' as const, target:'one', title:'첫 대화', icon:'✦' }
const state: WorkspaceSession = {
  openTabs:[documentTab,aiTab], dockedAiTabs:[{...aiTab,id:'ai:two',target:'two'}], dockedAiTabId:'ai:two',
  aiTabId:'ai:one', currentPath:'한글.md', view:'ai', dbDir:null, erdTabId:null, erdPath:null, erdDirectory:null, pluginViewId:null,
  rightDockOpen:true,activeRightTab:'system:ai',rightDockWidth:510,sidebarWidth:280,sidebarCollapsed:true,
  splitLayout:{activePanelId:'right',root:{kind:'split',id:'split',direction:'horizontal',ratio:38,
    first:{kind:'panel',id:'left',tabIds:[documentTab.id],activeTabId:documentTab.id},
    second:{kind:'panel',id:'right',tabIds:[aiTab.id],activeTabId:aiTab.id}}},
}
test('moving an open note preserves its split, selection and companion tabs', () => {
  const child = {...documentTab, id:'file:한글/child.md', target:'한글/child.md'}
  const moved = relocateWorkspaceDocuments({...state, openTabs:[documentTab,child,aiTab]}, {from:'한글.md',to:'project/새 제목.md'})
  assert.deepEqual(moved.openTabs.map(tab=>tab.id), ['file:project/새 제목.md','file:project/새 제목/child.md','ai:one'])
  assert.equal(moved.currentPath, 'project/새 제목.md')
  assert.equal(moved.splitLayout?.activePanelId, 'right')
  assert.equal(moved.splitLayout?.root.kind === 'split' && moved.splitLayout.root.first.kind === 'panel' && moved.splitLayout.root.first.activeTabId, 'file:project/새 제목.md')
  assert.equal(remapDocumentPath('한글다른.md',{from:'한글.md',to:'new.md'}),'한글다른.md')
  assert.equal(remapDocumentPath('project/child.md',{from:'project',to:'new'}),'new/child.md')
})
test('workspace session restores titles, selections, split ratio and dock dimensions',()=>{
  assert.deepEqual(parseWorkspaceSession(serializeWorkspaceSession(state)),state)
  assert.notEqual(workspaceSessionKey('/notes/one'),workspaceSessionKey('/notes/two'))
})
test('deleting a note closes its child tabs and preserves an empty pane and unrelated conversations', () => {
  const child = { ...documentTab, id: 'file:한글/child.md', target: '한글/child.md' }
  const sibling = { ...documentTab, id: 'file:한글다른.md', target: '한글다른.md' }
  const source = { ...state, view: 'editor' as const, openTabs: [documentTab, child, sibling, aiTab] }
  const result = { ...source, ...forgetWorkspaceDocuments(source, '한글.md') }
  assert.deepEqual(result.openTabs.map(tab => tab.id), [sibling.id, aiTab.id])
  assert.equal(result.currentPath, null)
  assert.equal(result.splitLayout?.root.kind === 'split' && result.splitLayout.root.first.kind === 'panel' && result.splitLayout.root.first.activeTabId, null)
  const restored = parseWorkspaceSession(serializeWorkspaceSession(result))!
  assert.deepEqual(restored.splitLayout, result.splitLayout)
  assert.equal(restored.currentPath, null)
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
  delete raw.sidebarCollapsed
  raw.splitLayout.root.ratio=900
  raw.splitLayout.root.second.tabIds=[documentTab.id,aiTab.id]
  raw.openTabs.push({...documentTab})
  const restored=parseWorkspaceSession(JSON.stringify(raw))!
  assert.equal(restored.openTabs.length,2)
  assert.equal(restored.sidebarCollapsed,false)
  assert.equal(restored.splitLayout?.root.kind==='split'&&restored.splitLayout.root.ratio,80)
  assert.deepEqual(restored.splitLayout?.root.kind==='split'&&restored.splitLayout.root.second.kind==='panel'&&restored.splitLayout.root.second.tabIds,[aiTab.id])
})
