import { useState } from 'react'
import { useAiStore, type AiSession } from '../aiStore'
import { SYSTEM_AI_TAB, useAppStore } from '../store'

export default function ProjectAiTasks({ projectId, sessions, error }: { projectId: string; sessions: AiSession[]; error: string }) {
  const activeId = useAiStore((s) => s.activeSessionId)
  const root = useAppStore((s) => s.root)
  const storageKey = `ai-tasks-expanded:${root}:${projectId}`
  const [expanded, setExpanded] = useState(() => localStorage.getItem(storageKey) !== '0')
  return <div className="mt-1" data-project-ai-tasks={projectId}
    onContextMenu={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button type="button" aria-expanded={expanded}
      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] text-[#6e6493] hover:bg-[#ecebea]"
      onClick={() => { localStorage.setItem(storageKey, expanded ? '0' : '1'); setExpanded(!expanded) }}>
      <span className="w-2 text-[9px]" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span aria-hidden="true">✦</span><span>[AI 작업]</span>
      <span className="ml-auto text-[10px] text-[#9b9a97]">{sessions.length}</span>
    </button>
    {expanded && <div className="ml-3 border-l border-[#ded9e8] pl-1">
      {error && <p role="alert" className="px-2 py-1 text-[11px] text-red-500">{error}</p>}
      {sessions.map((session) => <button key={session.id} type="button" title={session.title}
        data-ai-session-id={session.id}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-[#efefed] ${session.id === activeId ? 'bg-[#ececea] text-[#37352f]' : 'text-[#7d7c78]'}`}
        onClick={() => { useAiStore.getState().selectSession(session.id); useAppStore.getState().openRightTab(SYSTEM_AI_TAB) }}>
        <span aria-hidden="true">{session.busy ? '◉' : session.queued ? '◷' : '◌'}</span><span className="truncate">{session.title}</span>
      </button>)}
      {!error && sessions.length === 0 && <p className="px-2 py-1 text-[11px] text-[#9b9a97]">아직 AI 작업이 없습니다.</p>}
    </div>}
  </div>
}
