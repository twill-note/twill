import { useEffect, useState } from 'react'
import { installPlugin, uninstallPlugin } from '../plugins/manager'
import { useAppStore } from '../store'
import { tr } from '../i18n'

/**
 * 플러그인 설치/삭제 목록 — 설정(⚙) 팝업의 "플러그인" 섹션에 임베드된다.
 * (과거에는 사이드바 🧩 버튼의 독립 모달이었으나 설정으로 이관.)
 */
export default function PluginsSection() {
  const plugins = useAppStore((s) => s.plugins)
  const refreshPlugins = useAppStore((s) => s.refreshPlugins)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshPlugins().catch(() => {})
  }, [refreshPlugins])

  const toggle = async (id: string, installed: boolean) => {
    setBusy(id)
    setError(null)
    try {
      if (installed) await uninstallPlugin(id)
      else await installPlugin(id)
      await refreshPlugins()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-md border border-[#e9e9e7]">
      {plugins.length === 0 && (
        <p className="px-3 py-5 text-center text-[13px] text-[#9b9a97]">{tr("사용 가능한 플러그인이 없습니다")}</p>
      )}
      {plugins.map((p) => (
        <div key={p.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-[#f7f7f5]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {p.ui.rightPanel?.icon && <span className="text-[15px]">{p.ui.rightPanel.icon}</span>}
              <span className="text-[13px] font-medium text-[#37352f]">{p.name}</span>
              <span className="text-[11px] text-[#9b9a97]">v{p.version}</span>
              {p.installed && (
                <span className="rounded bg-[#e7f5ef] px-1.5 py-0.5 text-[10px] font-medium text-[#0f7a48]">

                  {tr("설치됨")}
                </span>
              )}
            </div>
            {p.description && <p className="mt-1 text-[12px] text-[#5f5e5b]">{p.description}</p>}
            {p.permissions.length > 0 && (
              <p className="mt-1 text-[11px] text-[#9b9a97]">{tr("권한:")} {p.permissions.join(', ')}</p>
            )}
          </div>
          <button
            className={`shrink-0 rounded-md px-3 py-1 text-[12px] font-medium ${
              p.installed
                ? 'border border-[#e3e2e0] bg-white text-[#5f5e5b] hover:bg-[#efefed]'
                : 'bg-[#37352f] text-white hover:bg-[#2b2925]'
            } ${busy === p.id ? 'opacity-60' : ''}`}
            disabled={busy === p.id}
            onClick={() => toggle(p.id, p.installed)}
          >
            {busy === p.id ? '⏳' : p.installed ? tr("삭제") : tr("설치")}
          </button>
        </div>
      ))}
      {error && <div className="border-t border-[#e9e9e7] px-3 py-2 text-[12px] text-[#c92a2a]">{error}</div>}
    </div>
  )
}
