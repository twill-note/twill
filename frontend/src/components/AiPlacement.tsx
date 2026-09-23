import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import ByeoriPanel from './ByeoriPanel'
import { useAiStore } from '../aiStore'
import { sessionIdFromAiTab } from '../aiTabs'

const containers = new Map<string, HTMLDivElement>()
function panelContainer(tabId: string) {
  let container = containers.get(tabId)
  if (!container) {
    container = document.createElement('div')
    container.className = 'h-full min-h-0'
    containers.set(tabId, container)
  }
  return container
}

/** Reparent the same container so drafts survive moves between editor groups and the dock. */
export function AiPanelHost({ tabId, onFocus }: { tabId: string; onFocus?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const focus = useRef(onFocus)
  focus.current = onFocus
  useLayoutEffect(() => {
    const target = host.current!
    const element = panelContainer(tabId)
    target.appendChild(element)
    const focusPane = () => focus.current?.()
    // Portal events follow AiPlacement's React ancestry. Forward body drops from
    // the physical host so editor group previews and tab drops still receive them.
    const forwardDrag = (event: DragEvent) => {
      if (event.target === target || !event.dataTransfer?.types.includes('text/doc-tab')) return
      event.stopPropagation()
      const forwarded = new DragEvent(event.type, {
        bubbles: true, cancelable: true, dataTransfer: event.dataTransfer,
        clientX: event.clientX, clientY: event.clientY, relatedTarget: event.relatedTarget,
      })
      if (!target.dispatchEvent(forwarded)) event.preventDefault()
    }
    target.addEventListener('mousedown', focusPane)
    target.addEventListener('dragover', forwardDrag)
    target.addEventListener('dragleave', forwardDrag)
    target.addEventListener('drop', forwardDrag)
    return () => {
      target.removeEventListener('mousedown', focusPane)
      target.removeEventListener('dragover', forwardDrag)
      target.removeEventListener('dragleave', forwardDrag)
      target.removeEventListener('drop', forwardDrag)
      if (element.parentElement === target) element.remove()
    }
  }, [tabId])
  return <div ref={host} className="h-full min-h-0" data-ai-panel-host={tabId} />
}

export default function AiPlacement() {
  const detached = useAppStore((s) => s.byeoriDetached)
  const tabs = useAppStore((s) => s.openTabs)
  const dockedId = useAppStore((s) => s.dockedAiTabId)
  const dockedTabs = useAppStore((s) => s.dockedAiTabs)
  const sessions = useAiStore((s) => s.sessions)
  const loaded = useAiStore((s) => s.sessionsLoaded)
  useEffect(() => {
    const open = new Set(tabs.filter((tab) => tab.kind === 'ai').map((tab) => tab.id))
    for (const tab of dockedTabs) open.add(tab.id)
    for (const id of containers.keys()) if (!open.has(id)) containers.delete(id)
  }, [tabs, dockedTabs])
  useEffect(() => {
    if (!loaded) return
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const state = useAppStore.getState()
    for (const tab of state.openTabs) {
      if (tab.kind === 'ai' && tab.target && !byId.has(tab.target)) state.closeTab(tab.id)
    }
    const current = useAppStore.getState()
    const next = current.openTabs.map((tab) => {
      const session = tab.kind === 'ai' ? byId.get(tab.target) : null
      return session && session.title !== tab.title ? { ...tab, title: session.title } : tab
    })
    if (next.some((tab, index) => tab !== current.openTabs[index])) useAppStore.setState({ openTabs: next })
    for (const tab of current.dockedAiTabs) {
      if (tab.target && !byId.has(tab.target)) current.closeDockedAiTab(tab.id)
    }
    const docked = useAppStore.getState().dockedAiTabs
    const nextDocked = docked.map((tab) => {
      const session = byId.get(tab.target)
      return session && session.title !== tab.title ? { ...tab, title: session.title } : tab
    })
    if (nextDocked.some((tab, index) => tab !== docked[index])) useAppStore.setState({ dockedAiTabs: nextDocked })
  }, [sessions, loaded])
  const ids = new Set(tabs.filter((tab) => tab.kind === 'ai').map((tab) => tab.id))
  for (const tab of dockedTabs) ids.add(tab.id)
  return [...ids].map((id) => detached && id === dockedId ? null : <SessionPortal key={id} tabId={id} />)
}

function SessionPortal({ tabId }: { tabId: string }) {
  const container = panelContainer(tabId)
  return createPortal(<ByeoriPanel sessionId={sessionIdFromAiTab(tabId)} />, container)
}
