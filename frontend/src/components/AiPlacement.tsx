import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SYSTEM_AI_TAB, useAppStore } from '../store'
import ByeoriPanel from './ByeoriPanel'

/** Move the same portal container so drafts, uploads and scroll state survive docking. */
export default function AiPlacement() {
  const location = useAppStore((s) => s.aiLocation)
  const detached = useAppStore((s) => s.byeoriDetached)
  const moveAi = useAppStore((s) => s.moveAi)
  const [container] = useState(() => {
    const element = document.createElement('div')
    element.className = 'flex h-full min-h-0 flex-col'
    return element
  })
  useLayoutEffect(() => {
    const host = document.getElementById(location === 'editor' ? 'ai-editor-host' : 'ai-dock-host')
    host?.appendChild(container)
    return () => { container.remove() }
  }, [container, location, detached])
  if (detached) return null
  return createPortal(<>
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-[#e9e9e7] px-3 text-[11px]"
      draggable onDragStart={(event) => {
        event.dataTransfer.setData('application/x-note-right-tab', SYSTEM_AI_TAB)
        event.dataTransfer.effectAllowed = 'move'
      }}>
      <span className="cursor-grab" title="드래그하여 편집 영역 또는 오른쪽 패널로 이동">⠿ Twill AI</span>
      <select aria-label="AI 채팅 위치" value={location} onChange={(event) => moveAi(event.target.value as 'editor' | 'right')}
        className="rounded border border-[#e3e2e0] bg-transparent px-1 py-0.5">
        <option value="editor">편집 영역</option><option value="right">오른쪽 패널</option>
      </select>
    </div>
    <div className="min-h-0 flex-1"><ByeoriPanel /></div>
  </>, container)
}
