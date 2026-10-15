import type { DocTab } from './store'
import type { PaneNode, WorkspaceSession } from './workspaceSession'

export type DocumentRelocation = { from: string; to: string }
export const DOCUMENT_RELOCATED = 'twill:document-relocated'

/** Markdown moves include the companion directory used for child notes. */
export function remapDocumentPath(path: string, { from, to }: DocumentRelocation): string {
  if (path === from) return to
  const prefix = from.endsWith('.md') ? from.slice(0, -3) : from
  const replacement = from.endsWith('.md') ? to.slice(0, -3) : to
  return path.startsWith(prefix + '/') ? replacement + path.slice(prefix.length) : path
}

export function relocateWorkspaceDocuments(state: WorkspaceSession, move: DocumentRelocation) {
  const path = (value: string | null) => value === null ? null : remapDocumentPath(value, move)
  const ids = new Map<string, string>()
  const openTabs = state.openTabs.map((tab): DocTab => {
    if (!['file', 'db', 'erd'].includes(tab.kind)) return tab
    const target = remapDocumentPath(tab.target, move)
    const erdPath = path(tab.erdPath ?? null)
    const erdDirectory = path(tab.erdDirectory ?? null)
    if (target === tab.target && erdPath === (tab.erdPath ?? null) && erdDirectory === (tab.erdDirectory ?? null)) return tab
    // ERD sessions use stable IDs; ordinary document and DB IDs encode their path.
    const id = tab.kind === 'erd' ? tab.id : `${tab.kind}:${target}`
    ids.set(tab.id, id)
    return { ...tab, id, target, title: target.split('/').pop()!.replace(/(?:\.erd\.json|\.md)$/, ''),
      ...(tab.kind === 'erd' ? { erdPath, erdDirectory } : {}) }
  })
  const id = (value: string | null) => value === null ? null : ids.get(value) ?? value
  const pane = (node: PaneNode): PaneNode => node.kind === 'panel'
    ? { ...node, tabIds: node.tabIds.map(value => id(value)!), activeTabId: id(node.activeTabId) }
    : { ...node, first: pane(node.first), second: pane(node.second) }
  return { openTabs, currentPath: path(state.currentPath), dbDir: path(state.dbDir),
    erdPath: path(state.erdPath), erdDirectory: path(state.erdDirectory),
    splitLayout: state.splitLayout ? { ...state.splitLayout, root: pane(state.splitLayout.root) } : null }
}

const editors = new Set<{ path: () => string; save: () => Promise<unknown> }>()
export function registerDocumentSave(path: () => string, save: () => Promise<unknown>) {
  const entry = { path, save }
  editors.add(entry)
  return () => { editors.delete(entry) }
}
export async function saveDocumentsBeforeMove(from: string) {
  let current = from
  const relocate = (event: Event) => {
    current = remapDocumentPath(current, (event as CustomEvent<DocumentRelocation>).detail)
  }
  window.addEventListener(DOCUMENT_RELOCATED, relocate)
  try {
    for (const editor of editors) {
      if (remapDocumentPath(editor.path(), { from: current, to: '__moving__.md' }) !== editor.path()) {
        if (await editor.save() === false) throw new Error('문서를 저장하지 못해 이동하지 않았습니다.')
      }
    }
    return current
  } finally {
    window.removeEventListener(DOCUMENT_RELOCATED, relocate)
  }
}
