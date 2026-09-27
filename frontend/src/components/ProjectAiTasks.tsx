import { useState } from 'react'
import { useAiStore, type AiSession } from '../aiStore'
import { SYSTEM_AI_TAB, useAppStore } from '../store'
import { dialog } from '../dialog'
import { tr } from '../i18n'

export default function ProjectAiTasks({ projectId, sessions, error }: { projectId: string; sessions: AiSession[]; error: string }) {
  const activeId = useAiStore((s) => s.activeSessionId)
  const root = useAppStore((s) => s.root)
  const storageKey = `ai-tasks-expanded:${root}:${projectId}`
  const [expanded, setExpanded] = useState(() => localStorage.getItem(storageKey) !== '0')
  const [menu, setMenu] = useState<{ session: AiSession; x: number; y: number } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const deleteSession = async (session: AiSession) => {
    setMenu(null)
    const confirmed = await dialog.confirm(`“${session.title}” 대화를 삭제할까요?`, {
      detail: `${session.busy || session.queued ? '진행 중이거나 대기 중인 AI 작업도 중단됩니다. ' : ''}대화 기록은 복구할 수 없습니다. 연결된 문서와 태스크 카드는 유지됩니다.`,
      danger: true, confirmLabel: '대화 삭제',
    })
    if (!confirmed) return
    setDeleting(session.id)
    setDeleteError('')
    try { await useAiStore.getState().closeSession(session.id) }
    catch (error) { setDeleteError(`삭제하지 못했습니다: ${(error as Error).message}`) }
    finally { setDeleting(null) }
  }
  return <div className="mt-1" data-project-ai-tasks={projectId}
    onContextMenu={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setMenu(null) }}>
    <button type="button" aria-expanded={expanded}
      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] text-[#6e6493] hover:bg-[#ecebea]"
      onClick={() => { localStorage.setItem(storageKey, expanded ? '0' : '1'); setExpanded(!expanded) }}>
      <span className="w-2 text-[9px]" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span aria-hidden="true">✦</span><span>{tr("[AI 작업]")}</span>
      <span className="ml-auto text-[10px] text-[#9b9a97]">{sessions.length}</span>
    </button>
    {expanded && <div className="ml-3 border-l border-[#ded9e8] pl-1">
      {(error || deleteError) && <p role="alert" className="px-2 py-1 text-[11px] text-red-500">{deleteError || error}</p>}
      {sessions.map((session) => <div key={session.id} className="group flex min-w-0 items-center"
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ session, x: event.clientX, y: event.clientY }) }}>
        <button type="button" title={session.title}
        data-ai-session-id={session.id}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-[#efefed] ${session.id === activeId ? 'bg-[#ececea] text-[#37352f]' : 'text-[#7d7c78]'}`}
        onClick={() => { useAiStore.getState().selectSession(session.id); useAppStore.getState().openRightTab(SYSTEM_AI_TAB) }}>
        <span aria-hidden="true">{session.busy ? '◉' : session.queued ? '◷' : '◌'}</span><span className="truncate">{session.title}</span>
      </button>
      <button type="button" aria-label={`${session.title} 메뉴`} title={tr("AI 작업 메뉴")} disabled={deleting === session.id}
        className="shrink-0 rounded px-1.5 text-[#9b9a97] opacity-0 hover:bg-[#efefed] group-hover:opacity-100 focus:opacity-100"
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ session, x: rect.left, y: rect.bottom }) }}>⋯</button>
      </div>)}
      {!error && sessions.length === 0 && <p className="px-2 py-1 text-[11px] text-[#9b9a97]">{tr("아직 AI 작업이 없습니다.")}</p>}
    </div>}
    {menu && <>
      <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null) }} />
      <div role="menu" className="fixed z-50 w-40 rounded-md border border-[#e3e2e0] bg-white p-1 shadow-lg"
        style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 48) }}>
        <button role="menuitem" className="w-full rounded px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-[#fdf2f2]"
          onClick={() => void deleteSession(menu.session)}>{tr("대화 삭제")}</button>
      </div>
    </>}
  </div>
}
