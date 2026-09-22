import { useEffect, useState } from 'react'
import { api, type WorkspaceScopeEntry } from '../api'
import { useAiStore } from '../aiStore'
import { SYSTEM_AI_TAB, useAppStore } from '../store'

export default function ConversationList() {
  const sessions = useAiStore((s) => s.sessions)
  const activeId = useAiStore((s) => s.activeSessionId)
  const root = useAppStore((s) => s.root)
  const [scopes, setScopes] = useState<WorkspaceScopeEntry[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try {
        const [result] = await Promise.all([api.workspaceSettings.listScopes(), useAiStore.getState().loadSessions()])
        if (!disposed) { setScopes(result.scopes); setError('') }
      } catch { if (!disposed) setError('대화 목록을 불러오지 못했습니다.') }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [root])
  const groups = new Map<string, typeof sessions>()
  for (const session of sessions) {
    const key = session.scopeId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), session])
  }
  return <section aria-label="디렉토리별 대화" className="flex max-h-[40%] min-h-24 shrink-0 flex-col border-t border-[#e3e2e0] px-2 py-2">
    <h2 className="px-1 pb-1 text-[11px] font-semibold text-[#7d7c78]">대화</h2>
    <div className="min-h-0 overflow-y-auto">
      {error && <p role="alert" className="px-1 text-[11px] text-red-500">{error}</p>}
      {[...groups].map(([id, items]) => {
        const scope = scopes.find((scope) => scope.id === id)
        return <details key={id} open className="mb-1">
          <summary className="cursor-pointer truncate px-1 py-1 text-[11px] text-[#9b9a97]" title={scope?.path ?? root ?? ''}>
            {scope?.label ?? items[0].lastScopeLabel ?? (id || '작업 디렉토리')}
          </summary>
          {items.map((session) => <button key={session.id} title={session.title}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-[#efefed] ${session.id === activeId ? 'bg-[#ececea] text-[#37352f]' : 'text-[#7d7c78]'}`}
            onClick={() => { useAiStore.getState().selectSession(session.id); useAppStore.getState().openRightTab(SYSTEM_AI_TAB) }}>
            <span aria-hidden="true">{session.busy ? '◉' : '◌'}</span><span className="truncate">{session.title}</span>
          </button>)}
        </details>
      })}
      {!error && sessions.length === 0 && <p className="px-1 text-[11px] text-[#9b9a97]">아직 대화가 없습니다.</p>}
    </div>
  </section>
}
