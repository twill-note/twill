import { useEffect, useLayoutEffect, useState, type SetStateAction } from 'react'
import { DOCUMENT_DELETED, DOCUMENT_RELOCATED, documentIsWithin, remapDocumentPath, type DocumentRelocation } from './documentPaths'

const key = (root: string) => `twill:tree-expansion:v1:${encodeURIComponent(root)}`
function read(root: string | null) {
  try {
    const value = root ? JSON.parse(localStorage.getItem(key(root)) ?? 'null') : null
    return { root, expanded: new Set<string>(Array.isArray(value?.expanded) ? value.expanded.filter((path: unknown) => typeof path === 'string') : []),
      rootExpanded: typeof value?.rootExpanded === 'boolean' ? value.rootExpanded : localStorage.getItem('filetree.root-expanded') !== '0' }
  } catch { return { root, expanded: new Set<string>(), rootExpanded: true } }
}

/** Persist per workspace; never write the previous workspace's state into a new one. */
export function useTreeExpansion(root: string | null) {
  const [state, setState] = useState(() => read(root))
  useLayoutEffect(() => {
    if (state.root !== root) setState(read(root))
  }, [root, state.root])
  useEffect(() => {
    if (!root || state.root !== root) return
    try { localStorage.setItem(key(root), JSON.stringify({ expanded: [...state.expanded], rootExpanded: state.rootExpanded })) } catch { /* Storage may be unavailable in a browser profile. */ }
  }, [root, state])
  useEffect(() => {
    const move = (event: Event) => setState(previous => ({ ...previous, expanded: new Set([...previous.expanded].map(path => remapDocumentPath(path, (event as CustomEvent<DocumentRelocation>).detail))) }))
    const remove = (event: Event) => setState(previous => ({ ...previous, expanded: new Set([...previous.expanded].filter(path => !documentIsWithin(path, (event as CustomEvent<string>).detail))) }))
    window.addEventListener(DOCUMENT_RELOCATED, move)
    window.addEventListener(DOCUMENT_DELETED, remove)
    return () => { window.removeEventListener(DOCUMENT_RELOCATED, move); window.removeEventListener(DOCUMENT_DELETED, remove) }
  }, [])
  const setExpanded = (action: SetStateAction<Set<string>>) => setState(previous => {
    const current = previous.root === root ? previous : read(root)
    return { ...current, expanded: typeof action === 'function' ? action(current.expanded) : action }
  })
  const setRootExpanded = (rootExpanded: boolean) => setState(previous => ({ ...(previous.root === root ? previous : read(root)), rootExpanded }))
  return { expanded: state.expanded, setExpanded, rootExpanded: state.rootExpanded, setRootExpanded }
}
