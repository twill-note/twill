import { useEffect, useState } from 'react'
import { api, type AiApprovalRequest } from '../api'
import { tr } from '../i18n'

export function AiApprovalMode({ sessionId, disabled = false }: { sessionId: string; disabled?: boolean }) {
  const key = `twill.ai.approval.${sessionId}`
  const [mode, setMode] = useState(() => localStorage.getItem(key) || '')
  useEffect(() => setMode(localStorage.getItem(key) || ''), [key])
  return <select aria-label={tr('AI 실행 승인 모드')} title={tr('다음 실행부터 적용됩니다')} disabled={disabled}
    className="max-w-36 rounded border border-[#e3e2e0] bg-transparent px-1 py-0.5 text-[11px]"
    value={mode} onChange={(event) => {
      const next = event.target.value
      if (next) localStorage.setItem(key, next)
      else localStorage.removeItem(key)
      setMode(next)
    }}>
    <option value="">{tr('기본 승인 모드')}</option>
    <option value="on-request">{tr('필요 시 승인 요청')}</option>
    <option value="never">{tr('승인 없이 실행')}</option>
  </select>
}

export function AiApprovalDefault() {
  const [mode, setMode] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let disposed = false
    api.workspaceSettings.get().then(settings => { if (!disposed) setMode(settings.codex.default_approval || 'on-request') })
      .catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true }
  }, [])
  const save = async (next: 'on-request' | 'never') => {
    setSaving(true)
    setError('')
    try {
      const settings = await api.workspaceSettings.get()
      await api.workspaceSettings.put({ ...settings, codex: { ...settings.codex, default_approval: next } })
      setMode(next)
    } catch (reason) { setError(String(reason)) }
    finally { setSaving(false) }
  }
  return <div className="flex items-center gap-1 text-[11px]">
    <label>{tr('AI 기본 모드')} <select aria-label={tr('AI 기본 승인 모드')} disabled={mode === null || saving}
      className="rounded border border-[#e3e2e0] bg-transparent p-1" value={mode || 'on-request'}
      onChange={event => void save(event.target.value as 'on-request' | 'never')}>
      <option value="on-request">{tr('필요 시 승인 요청')}</option>
      <option value="never">{tr('승인 없이 실행')}</option>
    </select></label>
    {error && <span role="alert" className="text-red-600">{error}</span>}
  </div>
}

export function AiApprovalRequests({ sessionId, busy }: { sessionId: string; busy: boolean }) {
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
  return <div className="shrink-0 text-[12px]">
    {error && <p role="alert" className="px-3 text-red-600">{tr('승인 요청 조회 실패')}: {error}</p>}
    {requests.map(item => <div key={item.id} className="border-b border-amber-200 bg-amber-50 p-3" role="region" aria-label={tr('실행 승인 요청')}>
      <strong>{tr('실행 승인 요청')}</strong>
      <p>{item.reason || tr('AI가 추가 권한을 요청했습니다.')}</p>
      {item.cwd && <p className="break-all">{item.cwd}</p>}
      {item.command && <pre className="max-h-32 overflow-auto whitespace-pre-wrap">{item.command}</pre>}
      <div className="mt-2 flex gap-2">
        <button disabled={answering === item.id} onClick={() => void answer(item.id, 'accept')} className="rounded border px-3 py-1">{tr('허용')}</button>
        <button disabled={answering === item.id} onClick={() => void answer(item.id, 'decline')} className="rounded border px-3 py-1">{tr('거절')}</button>
      </div>
    </div>)}
  </div>
}
