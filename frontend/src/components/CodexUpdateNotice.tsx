import { useEffect, useState } from 'react'
import { aiMaintenanceRequest, notifyAiEngineChanged, type CodexUpdate } from '../aiMaintenance'
import { tr } from '../i18n'

export default function CodexUpdateNotice({ manual = false }: { manual?: boolean }) {
  const [update, setUpdate] = useState<CodexUpdate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [checked, setChecked] = useState(false)

  const check = async () => {
    setBusy(true)
    setError(null)
    setDismissed(false)
    setCompleted(false)
    try {
      setUpdate(await aiMaintenanceRequest<CodexUpdate>('updates?force=true'))
      setChecked(true)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (manual) return
    // The backend coalesces startup checks, including React StrictMode mounts.
    let cancelled = false
    aiMaintenanceRequest<CodexUpdate>('updates').then((value) => {
      if (!cancelled) setUpdate(value)
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => {
      cancelled = true
    }
  }, [manual])

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      setUpdate(await aiMaintenanceRequest<CodexUpdate>('updates', 'POST'))
      setCompleted(true)
      notifyAiEngineChanged()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!manual && (dismissed || (!busy && !error && !completed && !checked && !update?.update_available))) return null
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 border-b border-[#e9e9e7] bg-[#f7f7f5] px-4 py-2 text-[12px] text-[#37352f]">
      <span className="min-w-0 flex-1 break-words">
        {busy ? tr("Codex 버전 확인 및 업데이트 중… 완료될 때까지 앱을 열어 두세요.")
          : error ? error
            : completed ? `Codex ${update?.current_version} 업데이트 완료. 모델 목록을 새로 불러옵니다.`
              : update?.update_available ? `Codex 업데이트가 있습니다: ${update?.current_version} → ${update?.latest_version}. 업데이트 후 사용 가능한 모델 목록을 새로 불러옵니다.`
                : checked ? (update?.installed ? `Codex ${update.current_version} · 최신 버전입니다.` : tr("Codex CLI가 설치되어 있지 않습니다."))
                  : tr("Codex CLI 업데이트")}
      </span>
      {(error || manual) && <button className="rounded border px-2 py-1" disabled={busy} onClick={() => void check()}>{error ? tr("다시 확인") : tr("업데이트 확인")}</button>}
      {update?.update_available && <button className="rounded bg-[#37352f] px-2 py-1 text-white disabled:opacity-50" disabled={busy || update.busy} onClick={() => void install()}>{tr("지금 업데이트")}</button>}
      {!busy && !manual && <button className="rounded px-2 py-1" onClick={() => setDismissed(true)}>{completed ? tr("닫기") : tr("나중에")}</button>}
    </div>
  )
}
