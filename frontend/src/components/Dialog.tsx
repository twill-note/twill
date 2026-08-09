import { useEffect, useRef } from 'react'
import { useDialogStore } from '../dialog'

/** 공통 팝업 렌더러 — dialog.alert/confirm/prompt 요청을 큐 순서대로 표시. App에 한 번만 마운트. */
export default function DialogHost() {
  const current = useDialogStore((s) => s.queue[0])
  const shift = useDialogStore((s) => s.shift)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const finish = (value: string | boolean | null) => {
    current?.resolve(value)
    shift()
  }

  useEffect(() => {
    if (!current) return
    // prompt는 입력창에, 나머지는 확인 버튼에 포커스 (Enter로 바로 닫기)
    setTimeout(() => {
      if (current.kind === 'prompt') {
        inputRef.current?.focus()
        inputRef.current?.select()
      } else {
        confirmRef.current?.focus()
      }
    }, 0)
  }, [current])

  if (!current) return null

  const cancelValue = current.kind === 'prompt' ? null : false
  const submit = () => finish(current.kind === 'prompt' ? (inputRef.current?.value ?? '') : true)

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 pt-[22vh]"
      onClick={() => finish(cancelValue)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(cancelValue)
      }}
    >
      <div
        className="w-[400px] max-w-[90vw] overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3">
          <p className="text-[14px] font-medium whitespace-pre-line text-[#37352f]">{current.message}</p>
          {current.detail && (
            <p className="mt-1 text-[12px] whitespace-pre-line text-[#9b9a97]">{current.detail}</p>
          )}
          {current.kind === 'prompt' && (
            <input
              ref={inputRef}
              defaultValue={current.defaultValue}
              placeholder={current.placeholder}
              className="mt-3 w-full rounded border border-[#e3e2e0] px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#efefed] bg-[#fbfbfa] px-4 py-2.5">
          {current.kind !== 'alert' && (
            <button
              className="rounded border border-[#e3e2e0] bg-white px-3 py-1.5 text-[13px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={() => finish(cancelValue)}
            >
              취소
            </button>
          )}
          <button
            ref={confirmRef}
            className={`rounded px-3 py-1.5 text-[13px] text-white ${
              current.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-[#37352f] hover:bg-[#565452]'
            }`}
            onClick={submit}
          >
            {current.confirmLabel ?? '확인'}
          </button>
        </div>
      </div>
    </div>
  )
}
