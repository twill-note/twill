import { useEffect, useRef, useState } from 'react'
import { api, type AiApprovalRequest } from '../api'
import { tr } from '../i18n'
import { useTranslation } from 'react-i18next'
import { setNoteProp } from '../dbmodel'
import { useAiStore } from '../aiStore'
import ApprovalPicker, { approvalMode, type ApprovalMode } from './ApprovalPicker'

export function AiApprovalMode({ sessionId, disabled = false }: { sessionId: string; disabled?: boolean }) {
  const { t } = useTranslation()
  const key = `twill.ai.approval.${sessionId}`
  const taskPath = useAiStore(state => {
    const session = state.sessions.find(item => item.id === sessionId)
    return session?.activeTaskPath || session?.taskPath
  })
  const [mode, setMode] = useState<ApprovalMode>('never')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const saved = localStorage.getItem(key)
        const next = taskPath
          ? (await api.getContent(taskPath)).frontmatter.extra?.approval
          : saved || (await api.workspaceSettings.get()).codex.default_approval
        if (!disposed) setMode(approvalMode(next))
      } catch (reason) { if (!disposed) setError(String(reason)) }
      finally { if (!disposed) setLoading(false) }
    }
    void load()
    const refresh = () => { void load() }
    window.addEventListener('twill:approval-mode-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => { disposed = true; window.removeEventListener('twill:approval-mode-changed', refresh); window.removeEventListener('storage', refresh) }
  }, [key, taskPath, disabled])
  return <div className="flex items-center gap-1">
    <ApprovalPicker label={t('AI 실행 승인 모드')} title={t('다음 실행부터 적용됩니다')} disabled={disabled || loading}
      value={mode} onChange={async next => {
        if (!taskPath) { localStorage.setItem(key, next); setMode(next); return }
        setLoading(true)
        try { await setNoteProp(taskPath, 'approval', next); setMode(next); setError('') }
        finally { setLoading(false) }
      }} />
    {error && <span role="alert" className="text-[11px] text-red-600">{t('모드를 불러오지 못했습니다')}</span>}
  </div>
}

export function AiApprovalDefault() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ApprovalMode>('never')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let disposed = false
    api.workspaceSettings.get().then(settings => { if (!disposed) setMode(approvalMode(settings.codex.default_approval)) })
      .catch(reason => { if (!disposed) setError(String(reason)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])
  const save = async (next: ApprovalMode) => {
    setSaving(true)
    setError('')
    try {
      const settings = await api.workspaceSettings.get()
      await api.workspaceSettings.put({ ...settings, codex: { ...settings.codex, default_approval: next } })
      setMode(next)
    } catch (reason) { setError(String(reason)); throw reason }
    finally { setSaving(false) }
  }
  return <div className="flex items-center gap-1 text-[11px]">
    <span>{t('AI 기본 모드')}</span>
    <ApprovalPicker label={t('AI 기본 승인 모드')} disabled={loading || saving} value={mode} onChange={save} />
    {error && <span role="alert" className="text-red-600">{t('모드 설정을 저장하지 못했습니다')}: {error}</span>}
  </div>
}

export function AiApprovalRequests({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [requests, setRequests] = useState<AiApprovalRequest[]>([])
  const [error, setError] = useState('')
  const [answering, setAnswering] = useState<string | null>(null)
  useEffect(() => {
    setRequests([])
    setError('')
    if (!busy) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await api.aiApprovals(sessionId)
        if (!disposed) { setRequests(result.requests); setError('') }
      } catch (reason) { if (!disposed) setError(String(reason)) }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 1000) }
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [sessionId, busy])
  const requestIds = requests.map(item => item.id).join(',')
  useEffect(() => {
    const card = cardRef.current
    const stream = card?.closest<HTMLElement>('[data-ai-message-scroll]')
    if (card && stream && requestIds && stream.scrollHeight - stream.scrollTop - stream.clientHeight < card.offsetHeight + 80) {
      stream.scrollTop = stream.scrollHeight
    }
  }, [requestIds])
  const answer = async (id: string, decision: 'accept' | 'decline') => {
    setAnswering(id)
    try {
      await api.answerAiApproval(id, decision)
      setRequests(items => items.filter(item => item.id !== id))
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setAnswering(null) }
  }
  if (!busy) return null
  return <div ref={cardRef} className="space-y-2 text-[12px] text-[#37352f]">
    {error && <p role="alert" className="px-3 text-red-600">{tr('승인 요청 조회 실패')}: {error}</p>}
    {requests.map(item => <div key={item.id} className="space-y-2 rounded-lg border border-[#e3e2e0] bg-[#fbfbfa] p-3" role="region" aria-label={tr('실행 승인 요청')}>
      <strong>{tr('실행 승인 요청')}</strong>
      <p>{item.reason || tr('AI가 추가 권한을 요청했습니다.')}</p>
      {item.cwd && <p className="break-all">{item.cwd}</p>}
      {item.command && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-[#f1f1ef] p-2">{item.command}</pre>}
      {item.details && Object.keys(item.details).length > 0 && <details>
        <summary>{tr('요청 범위 상세')}</summary>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(item.details, null, 2)}</pre>
      </details>}
      <div className="mt-2 flex gap-2">
        <button disabled={answering === item.id} onClick={() => void answer(item.id, 'accept')} className="rounded border border-[#e3e2e0] bg-white px-3 py-1 text-[#37352f] hover:bg-[#f1f1ef] disabled:opacity-50">{tr('허용')}</button>
        <button disabled={answering === item.id} onClick={() => void answer(item.id, 'decline')} className="rounded border border-[#e3e2e0] bg-white px-3 py-1 text-[#37352f] hover:bg-[#f1f1ef] disabled:opacity-50">{tr('거절')}</button>
      </div>
    </div>)}
  </div>
}
