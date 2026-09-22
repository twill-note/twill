import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import ByeoriPanel from './ByeoriPanel'

let container: HTMLDivElement | undefined
function panelContainer() {
  if (!container) {
    container = document.createElement('div')
    container.className = 'h-full min-h-0'
  }
  return container
}

/** Reparent the same container so drafts survive moves between editor groups and the dock. */
export function AiPanelHost({ onFocus }: { onFocus?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const focus = useRef(onFocus)
  focus.current = onFocus
  useLayoutEffect(() => {
    const target = host.current!
    const element = panelContainer()
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
  }, [])
  return <div ref={host} className="h-full min-h-0" data-ai-panel-host />
}

export default function AiPlacement() {
  const detached = useAppStore((s) => s.byeoriDetached)
  return detached ? null : createPortal(<ByeoriPanel />, panelContainer())
}
