import type { DocTab } from './store'
import type { ViewMode } from './types'

export type PanelNode = { kind: 'panel'; id: string; tabIds: string[]; activeTabId: string | null }
export type SplitNode = { kind: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; first: PaneNode; second: PaneNode }
export type PaneNode = PanelNode | SplitNode
export type SplitLayout = { root: PaneNode; activePanelId: string }

export type WorkspaceSession = {
  openTabs: DocTab[]
  dockedAiTabs: DocTab[]
  dockedAiTabId: string | null
  aiTabId: string | null
  currentPath: string | null
  view: ViewMode
  dbDir: string | null
  erdTabId: string | null
  erdPath: string | null
  erdDirectory: string | null
  pluginViewId: string | null
  rightDockOpen: boolean
  activeRightTab: string
  rightDockWidth: number
  sidebarWidth: number
  splitLayout: SplitLayout | null
}

export const workspaceSessionKey = (root: string) => `twill:workspace-session:v1:${encodeURIComponent(root)}`
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const views = new Set(['editor', 'ai', 'erd', 'database', 'calendar', 'todos', 'skillbook', 'plugin'])

function validTab(value: unknown): value is DocTab {
  if (!value || typeof value !== 'object') return false
  const tab = value as DocTab
  return ['file','erd','db','view','ai'].includes(tab.kind) &&
    ['id','target','title','icon'].every((key) => typeof tab[key as keyof DocTab] === 'string') &&
    (tab.kind !== 'erd' || (typeof tab.erdPath === 'string' && tab.erdPath.length > 0))
}

function restorePane(value: unknown, validIds: Set<string>, seen: Set<string>, nodes: Set<string>, depth = 0): PaneNode | null {
  if (!value || typeof value !== 'object' || depth > 12) return null
  const node = value as PaneNode
  if (typeof node.id !== 'string' || nodes.has(node.id)) return null
  nodes.add(node.id)
  if (node.kind === 'panel' && Array.isArray(node.tabIds)) {
    const tabIds = node.tabIds.filter((id) => {
      if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    return tabIds.length ? { kind: 'panel', id: node.id, tabIds, activeTabId: tabIds.includes(node.activeTabId ?? '') ? node.activeTabId : tabIds[0] } : null
  }
  if (node.kind !== 'split' || !['horizontal','vertical'].includes(node.direction)) return null
  const first = restorePane(node.first, validIds, seen, nodes, depth + 1)
  const second = restorePane(node.second, validIds, seen, nodes, depth + 1)
  if (!first) return second
  if (!second) return first
  return { kind: 'split', id: node.id, direction: node.direction, ratio: Number.isFinite(node.ratio) ? Math.max(20, Math.min(80, node.ratio)) : 50, first, second }
}

export function parseWorkspaceSession(raw: string | null): WorkspaceSession | null {
  try {
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.openTabs) || !Array.isArray(data.dockedAiTabs)) return null
    const seen = new Set<string>()
    const uniqueTabs = (tabs: unknown[]) => tabs.filter(validTab).filter((tab) => {
      if (seen.has(tab.id)) return false
      seen.add(tab.id)
      return true
    })
    const openTabs = uniqueTabs(data.openTabs)
    const dockedAiTabs = uniqueTabs(data.dockedAiTabs.filter((tab: DocTab | null) => tab?.kind === 'ai'))
    const editorIds = new Set(openTabs.filter((tab) => ['file','erd','ai'].includes(tab.kind)).map((tab) => tab.id))
    const pane = restorePane(data.splitLayout?.root, editorIds, new Set(), new Set())
    const panels: PanelNode[] = []
    const collect = (node: PaneNode) => { if (node.kind === 'panel') panels.push(node); else { collect(node.first); collect(node.second) } }
    if (pane) collect(pane)
    const splitLayout = pane ? { root: pane, activePanelId: panels.find((panel) => panel.id === data.splitLayout.activePanelId)?.id ?? panels[0].id } : null
    const path = openTabs.find((tab) => tab.kind === 'file' && tab.target === data.currentPath)?.target ?? null
    const erd = openTabs.find((tab) => tab.kind === 'erd' && tab.id === data.erdTabId)
    const ai = openTabs.find((tab) => tab.kind === 'ai' && tab.id === data.aiTabId)
    let view: ViewMode = views.has(data.view) ? data.view : 'editor'
    if ((view === 'ai' && !ai) || (view === 'erd' && !erd)) view = 'editor'
    return { openTabs, dockedAiTabs, splitLayout,
      dockedAiTabId: dockedAiTabs.find((tab) => tab.id === data.dockedAiTabId)?.id ?? dockedAiTabs[0]?.id ?? null,
      aiTabId: ai?.id ?? null, currentPath: path, view,
      dbDir: nullableString(data.dbDir) ? data.dbDir : null,
      erdTabId: erd?.id ?? null, erdPath: erd?.erdPath ?? null, erdDirectory: erd?.erdDirectory ?? null,
      pluginViewId: nullableString(data.pluginViewId) ? data.pluginViewId : null,
      rightDockOpen: data.rightDockOpen === true,
      activeRightTab: typeof data.activeRightTab === 'string' ? data.activeRightTab : 'system:ai',
      rightDockWidth: Number.isFinite(data.rightDockWidth) ? Math.max(320, data.rightDockWidth) : 480,
      sidebarWidth: Number.isFinite(data.sidebarWidth) ? Math.max(200, data.sidebarWidth) : 256,
    }
  } catch { return null }
}

export function serializeWorkspaceSession(state: WorkspaceSession): string {
  const { openTabs, dockedAiTabs, dockedAiTabId, aiTabId, currentPath, view, dbDir, erdTabId, erdPath, erdDirectory, pluginViewId, rightDockOpen, activeRightTab, rightDockWidth, sidebarWidth, splitLayout } = state
  return JSON.stringify({ version: 1, openTabs: openTabs.filter(validTab), dockedAiTabs, dockedAiTabId, aiTabId, currentPath, view, dbDir, erdTabId, erdPath, erdDirectory, pluginViewId, rightDockOpen, activeRightTab, rightDockWidth, sidebarWidth, splitLayout })
}
