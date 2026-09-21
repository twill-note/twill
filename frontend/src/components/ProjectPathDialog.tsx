import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { dialog } from '../dialog'
import type { BrowseResult } from '../types'

type ProjectPathDialogProps = {
  projectName: string
  initialPath?: string | null
  creation?: boolean
  onClose: () => void
  onSelect: (path: string) => Promise<void>
}

/** 프로젝트 문서 저장소를 먼저 만든 뒤 선택적으로 코드·분석 폴더를 연결한다. */
export default function ProjectPathDialog({
  projectName,
  initialPath,
  creation = false,
  onClose,
  onSelect,
}: ProjectPathDialogProps) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [input, setInput] = useState(initialPath ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nativePickerStartedRef = useRef(false)
  const nativePicker = window.noteDesktop?.selectProjectDirectory

  const navigate = async (path?: string) => {
    setError(null)
    try {
      const next = await api.browse(path)
      setBrowse(next)
      setInput(next.path)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  useEffect(() => {
    if (nativePicker) {
      // 개발 StrictMode가 effect를 두 번 실행해도 운영체제 선택 창은 한 번만 연다.
      if (nativePickerStartedRef.current) return
      nativePickerStartedRef.current = true
      setSaving(true)
      void nativePicker({
        title: `${projectName} 프로젝트 폴더 선택`,
        defaultPath: initialPath || undefined,
      })
        .then(async (result) => {
          if (result.canceled || !result.path) {
            onClose()
            return
          }
          try {
            await onSelect(result.path)
          } catch (reason) {
            await dialog.alert(`프로젝트 경로를 연결하지 못했습니다.\n${(reason as Error).message}`)
            onClose()
          }
        })
        .catch(async (reason) => {
          await dialog.alert(`폴더 선택기를 열지 못했습니다.\n${(reason as Error).message}`)
          onClose()
        })
      return
    }
    void navigate(initialPath || undefined)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
    // 최초 표시 때만 탐색 위치를 정한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = async () => {
    const path = input.trim()
    if (!path || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSelect(path)
    } catch (reason) {
      setError((reason as Error).message)
      setSaving(false)
    }
  }

  // 데스크톱에서는 Electron의 OS 네이티브 폴더 선택 창만 표시한다. 아래 커스텀
  // 탐색기는 브라우저 개발 환경과 향후 재사용을 위해 그대로 보존한다.
  if (nativePicker) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/20 pt-[12vh]"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-path-title"
        className="flex max-h-[72vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[#efefed] px-4 py-3">
          <h3 id="project-path-title" className="text-[15px] font-semibold text-[#37352f]">
            프로젝트 경로 지정
          </h3>
          <p className="mt-1 text-[12px] text-[#787774]">
            <span className="font-medium text-[#37352f]">{projectName}</span>에서 AI가 확인하고 수정할 코드·분석 폴더를 선택하세요.
          </p>
          {creation && (
            <p className="mt-1 text-[11px] text-[#9b9a97]">
              프로젝트와 독립 문서 저장소는 이미 생성되었습니다. 경로는 나중에 지정해도 됩니다.
            </p>
          )}
        </div>

        <div className="flex gap-1.5 border-b border-[#efefed] px-4 py-2">
          <button
            type="button"
            className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] text-[#787774] hover:bg-[#f1f1ef] disabled:opacity-40"
            onClick={() => browse?.parent && void navigate(browse.parent)}
            disabled={!browse?.parent}
            aria-label="상위 폴더"
            title="상위 폴더"
          >
            ↑
          </button>
          <input
            ref={inputRef}
            className="min-w-0 flex-1 rounded border border-[#e3e2e0] px-2 py-1 font-mono text-[12px] outline-none focus:border-[#8a8886]"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void navigate(input)
            }}
            placeholder="코드·분석 폴더 경로"
            aria-label="프로젝트 경로"
          />
          <button
            type="button"
            className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
            onClick={() => void navigate(input)}
          >
            이동
          </button>
          <button
            type="button"
            className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] hover:bg-[#f1f1ef]"
            onClick={() => browse && void navigate(browse.home)}
            aria-label="홈 폴더"
            title="홈 폴더"
          >
            🏠
          </button>
        </div>

        <div className="min-h-44 flex-1 overflow-y-auto px-2 py-1.5">
          {browse?.dirs.map((directory) => (
            <button
              key={directory.path}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => void navigate(directory.path)}
              onDoubleClick={() => {
                setInput(directory.path)
                void onSelect(directory.path).catch((reason) => setError((reason as Error).message))
              }}
              title={directory.path}
            >
              <span aria-hidden="true">📁</span>
              <span className="truncate">{directory.name}</span>
            </button>
          ))}
          {browse && browse.dirs.length === 0 && (
            <p className="px-2 py-4 text-center text-[12px] text-[#9b9a97]">하위 폴더가 없습니다</p>
          )}
        </div>

        <div className="border-t border-[#efefed] bg-[#fbfbfa] px-4 py-3">
          {error && <p className="mb-2 text-[12px] text-[#c92a2a]">{error}</p>}
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="rounded border border-[#e3e2e0] bg-white px-3 py-1.5 text-[13px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={onClose}
            >
              {creation ? '선택 안함' : '취소'}
            </button>
            <button
              type="button"
              className="rounded bg-[#37352f] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#565452] disabled:opacity-50"
              onClick={() => void select()}
              disabled={!input.trim() || saving}
            >
              {saving ? '연결 중…' : '경로 선택'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
