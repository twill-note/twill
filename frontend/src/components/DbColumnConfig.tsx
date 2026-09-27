import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CellType, ColumnDef } from '../dbschema'
import { tr } from '../i18n'

const TYPE_LABELS: Record<CellType, string> = {
  text: '텍스트',
  number: '숫자',
  select: '선택',
  multi_select: '다중 선택',
  status: '상태',
  date: '날짜',
  checkbox: '체크박스',
  url: 'URL',
  path: '경로',
}

const TYPES: CellType[] = ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'path']

/**
 * 컬럼 헤더 옆에 뜨는 설정 팝오버:
 * - 컬럼 라벨 변경
 * - 타입 변경 (기존 데이터는 서버측에서 유지, 새 타입 기준으로 재해석)
 * - 컬럼 삭제 (스키마에서만 제거, 노트의 frontmatter 는 그대로 남음)
 */
export default function DbColumnConfig({
  anchor,
  column,
  onChange,
  onDelete,
  onClose,
}: {
  anchor: HTMLElement | null
  column: ColumnDef
  onChange: (next: ColumnDef) => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPos({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 rounded-md border border-[#e3e2e0] bg-white shadow-lg"
      style={{ top: pos.top - window.scrollY, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-b border-[#e9e9e7] p-2">
        <label className="text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">{tr("이름")}</label>
        <input
          className="mt-1 w-full rounded border border-[#e3e2e0] px-2 py-1 text-[12px] outline-none focus:border-[#8a8886]"
          value={column.label ?? column.key}
          onChange={(e) => onChange({ ...column, label: e.target.value })}
        />
      </div>
      <div className="border-b border-[#e9e9e7] p-2">
        <label className="text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">{tr("타입")}</label>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {TYPES.map((t) => (
            <button
              key={t}
              className={`rounded px-2 py-1 text-left text-[11px] ${
                column.type === t ? 'bg-[#37352f] text-white' : 'text-[#5f5e5b] hover:bg-[#f7f7f5]'
              }`}
              onClick={() => onChange({ ...column, type: t })}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <button
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] text-[#c92a2a] hover:bg-[#fdf2f2]"
        onClick={() => {
          if (window.confirm(`컬럼 "${column.label ?? column.key}" 을 스키마에서 삭제할까요? (노트의 값은 유지)`)) {
            onDelete()
          }
        }}
      >
        <span>🗑</span>
        <span>{tr("컬럼 삭제")}</span>
      </button>
    </div>
  )
}
