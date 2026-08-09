import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { BrowseResult } from '../types'

export default function FolderPicker({ onClose }: { onClose: () => void }) {
  const { root, recent, openWorkspace } = useAppStore()
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const navigate = async (path?: string) => {
    setError(null)
    try {
      const r = await api.browse(path)
      setBrowse(r)
      setPathInput(r.path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    navigate(root ?? undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const open = async (path: string) => {
    setOpening(true)
    setError(null)
    try {
      await openWorkspace(path)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[#efefed] px-4 py-3">
          <h3 className="text-[15px] font-semibold text-[#37352f]">📂 폴더 열기</h3>
          <p className="mt-0.5 text-[12px] text-[#9b9a97]">선택한 폴더를 저장소로 설정합니다</p>
        </div>

        <div className="flex gap-1.5 border-b border-[#efefed] px-4 py-2">
          <input
            className="min-w-0 flex-1 rounded border border-[#e3e2e0] px-2 py-1 text-[13px] outline-none focus:border-blue-400"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(pathInput)}
            placeholder="/home/user/notes"
          />
          <button className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] hover:bg-[#f1f1ef]" onClick={() => navigate(pathInput)}>
            이동
          </button>
          <button
            className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] hover:bg-[#f1f1ef]"
            onClick={() => browse && navigate(browse.home)}
            title="홈 디렉토리"
          >
            🏠
          </button>
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto px-2 py-1.5">
          {browse?.parent && (
            <button
              className="block w-full rounded px-2 py-1 text-left text-[13px] text-[#787774] hover:bg-[#f1f1ef]"
              onClick={() => navigate(browse.parent!)}
            >
              ⬆️ ..
            </button>
          )}
          {browse?.dirs.map((d) => (
            <button
              key={d.path}
              className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => navigate(d.path)}
              onDoubleClick={() => open(d.path)}
              title={d.path}
            >
              📁 {d.name}
            </button>
          ))}
          {browse && browse.dirs.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-[#9b9a97]">하위 폴더가 없습니다</p>
          )}
        </div>

        {recent.length > 0 && (
          <div className="border-t border-[#efefed] px-4 py-2">
            <p className="mb-1 text-[11px] font-medium text-[#9b9a97]">최근 워크스페이스</p>
            {recent.slice(0, 4).map((p) => (
              <button
                key={p}
                className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-[#f1f1ef] ${
                  p === root ? 'font-medium text-[#37352f]' : 'text-[#5f5e5b]'
                }`}
                onClick={() => open(p)}
                title={p}
              >
                🕘 {p} {p === root && '(현재)'}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-[#efefed] px-4 py-3">
          {error ? <span className="truncate text-[12px] text-red-500">{error}</span> : <span />}
          <div className="flex shrink-0 gap-2">
            <button className="rounded border border-[#e3e2e0] px-3 py-1.5 text-[13px] hover:bg-[#f1f1ef]" onClick={onClose}>
              취소
            </button>
            <button
              className="rounded bg-[#37352f] px-3 py-1.5 text-[13px] text-white hover:bg-[#565452] disabled:opacity-50"
              disabled={!browse || opening || browse.path === root}
              onClick={() => browse && open(browse.path)}
            >
              {opening ? '여는 중…' : '이 폴더 열기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
