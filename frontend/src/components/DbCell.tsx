import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import {
  badgeClasses,
  ensureOption,
  findOption,
  normalizeValue,
  SELECT_COLORS,
  serializeValue,
  type ColumnDef,
  type SelectColor,
  type SelectOption,
} from '../dbschema'
import type { BrowseResult } from '../types'
import { tr } from '../i18n'

interface Props {
  column: ColumnDef
  raw: unknown
  readOnly?: boolean
  /** run_log 같은 워크스페이스 문서를 새 창 대신 현재 편집기에서 연다. */
  onOpenDocument?: (path: string) => void
  /** 저장할 값(정규화된 형태). null/빈값이면 속성 자체 제거. */
  onCommit: (nextValue: unknown) => void | Promise<void>
  /** 컬럼 스키마 자체가 바뀐 경우(예: select 옵션 추가). */
  onColumnChange?: (nextColumn: ColumnDef) => void | Promise<void>
}

/**
 * 타입별 셀 렌더러 + 인라인 편집.
 *  - text / number / url / date: 클릭 시 인라인 input
 *  - select / status: 클릭 시 옵션 팝오버 (없는 값이면 자동 옵션 등록)
 *  - multi_select: 태그 리스트 + 팝오버로 다중 선택
 *  - checkbox: 클릭 즉시 토글
 */
export default function DbCell({ column, raw, readOnly, onOpenDocument, onCommit, onColumnChange }: Props) {
  const value = normalizeValue(column, raw)
  const [editing, setEditing] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  const open = () => {
    if (readOnly) return
    if (column.type === 'checkbox') {
      onCommit(!value)
      return
    }
    setEditing(true)
  }

  const commit = async (next: unknown) => {
    await onCommit(serializeValue(column, next))
    setEditing(false)
  }

  return (
    <div
      ref={anchorRef}
      className={`relative min-h-[24px] w-full ${readOnly ? '' : 'cursor-pointer'}`}
      onClick={(e) => {
        if (editing) return
        e.stopPropagation()
        open()
      }}
    >
      <CellDisplay column={column} value={value} onOpenDocument={onOpenDocument} />
      {editing && !readOnly && (
        <CellEditor
          column={column}
          value={value}
          anchor={anchorRef.current}
          onClose={() => setEditing(false)}
          onCommit={commit}
          onColumnChange={onColumnChange}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 읽기 표시
// ─────────────────────────────────────────────────────────
function CellDisplay({
  column,
  value,
  onOpenDocument,
}: {
  column: ColumnDef
  value: unknown
  onOpenDocument?: (path: string) => void
}) {
  if (column.type === 'checkbox') {
    return (
      <div className="flex items-center py-0.5">
        <span
          className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
            value ? 'border-[#37352f] bg-[#37352f] text-white' : 'border-[#d3d1cb] bg-white'
          }`}
        >
          {value ? '✓' : ''}
        </span>
      </div>
    )
  }

  if (column.type === 'select' || column.type === 'status') {
    const v = value as string
    if (!v) return <EmptyCell />
    const opt = findOption(column, v)
    const badge = badgeClasses(opt?.color ?? 'default')
    return (
      <div className="py-0.5">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${badge.bg} ${badge.text}`}>
          {column.type === 'status' && (
            <span className={`h-1.5 w-1.5 rounded-full ${badge.text.replace('text-', 'bg-')}`} />
          )}
          {tr(opt?.label ?? v)}
        </span>
      </div>
    )
  }

  if (column.type === 'multi_select') {
    const arr = (value as string[]) ?? []
    if (arr.length === 0) return <EmptyCell />
    return (
      <div className="flex flex-wrap items-center gap-1 py-0.5">
        {arr.map((v) => {
          const opt = findOption(column, v)
          const badge = badgeClasses(opt?.color ?? 'default')
          return (
            <span key={v} className={`rounded px-1.5 py-0.5 text-[11px] ${badge.bg} ${badge.text}`}>
              {tr(opt?.label ?? v)}
            </span>
          )
        })}
      </div>
    )
  }

  if (column.type === 'url') {
    const v = value as string
    if (!v) return <EmptyCell />
    if (column.key === 'run_log' && onOpenDocument) {
      return (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-[#0f7a48] hover:bg-[#edf7f1]"
          title={`${v} — 현재 편집기에서 열기`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenDocument(v)
          }}
        >
          <span>📄</span>
          <span>{tr("열기")}</span>
        </button>
      )
    }
    return (
      <a
        className="truncate text-[13px] text-[#0f7a48] underline decoration-dotted underline-offset-2"
        href={v}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {v}
      </a>
    )
  }

  if (column.type === 'path') {
    const v = value as string
    return v ? (
      <span className="truncate font-mono text-[12px] text-[#5f5e5b]" title={v}>
        📁 {v}
      </span>
    ) : (
      <span className="text-[12px] text-[#c7c6c2]">{tr("— 클릭해서 폴더 선택")}</span>
    )
  }

  if (column.type === 'date') {
    const v = value as string
    return v ? <span className="text-[12px] text-[#5f5e5b]">{v}</span> : <EmptyCell />
  }

  if (column.type === 'number') {
    return value == null ? <EmptyCell /> : <span className="text-[13px] text-[#37352f]">{String(value)}</span>
  }

  // text
  const v = value as string
  return v ? (
    <span className="truncate text-[13px] text-[#37352f]">{v}</span>
  ) : (
    <EmptyCell />
  )
}

function EmptyCell() {
  return <span className="text-[12px] text-[#c7c6c2]">—</span>
}

// ─────────────────────────────────────────────────────────
// 편집 팝오버
// ─────────────────────────────────────────────────────────
function CellEditor({
  column,
  value,
  anchor,
  onClose,
  onCommit,
  onColumnChange,
}: {
  column: ColumnDef
  value: unknown
  anchor: HTMLDivElement | null
  onClose: () => void
  onCommit: (v: unknown) => void
  onColumnChange?: (c: ColumnDef) => void
}) {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 })

  useLayoutEffect(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    // 타입별 원하는 너비. path 는 폴더 탐색기 때문에 넓어야 함.
    const desiredWidth =
      column.type === 'path' ? 420 : column.type === 'multi_select' ? 280 : Math.max(rect.width, 200)
    const viewportW = window.innerWidth
    const margin = 8
    // 팝오버가 뷰포트 우측을 넘지 않도록 왼쪽으로 밀어냄
    let left = rect.left + window.scrollX
    if (left + desiredWidth + margin > viewportW) {
      left = Math.max(margin, viewportW - desiredWidth - margin)
    }
    // 뷰포트 하단을 넘으면 위쪽에 띄우기
    const viewportH = window.innerHeight
    const desiredMaxH = column.type === 'path' ? 380 : 300
    let top = rect.bottom + window.scrollY + 2
    if (rect.bottom + desiredMaxH + margin > viewportH && rect.top - desiredMaxH - margin > 0) {
      top = rect.top + window.scrollY - desiredMaxH - 4
    }
    setPos({ top, left, width: desiredWidth })
  }, [anchor, column.type])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!popRef.current) return
      if (!popRef.current.contains(e.target as Node)) onClose()
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

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos.top - window.scrollY,
    left: pos.left,
    width: pos.width,
    zIndex: 50,
  }

  if (column.type === 'select' || column.type === 'status') {
    return (
      <div ref={popRef} style={style} onClick={(e) => e.stopPropagation()}>
        <OptionPicker
          column={column}
          selected={typeof value === 'string' ? [value] : []}
          multi={false}
          onPick={(v) => onCommit(v)}
          onColumnChange={onColumnChange}
        />
      </div>
    )
  }

  if (column.type === 'path') {
    return (
      <div ref={popRef} style={style} onClick={(e) => e.stopPropagation()}>
        <PathPicker current={String(value ?? '')} onPick={(v) => onCommit(v)} onCancel={() => onCommit(String(value ?? ''))} />
      </div>
    )
  }

  if (column.type === 'multi_select') {
    return (
      <div ref={popRef} style={style} onClick={(e) => e.stopPropagation()}>
        <OptionPicker
          column={column}
          selected={Array.isArray(value) ? (value as string[]) : []}
          multi={true}
          onPick={(v) => onCommit(v)}
          onColumnChange={onColumnChange}
        />
      </div>
    )
  }

  // text / number / url / date: 인라인 input
  return (
    <div
      ref={popRef}
      style={style}
      className="rounded-md border border-[#e3e2e0] bg-white p-1 shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <InlineInput column={column} value={value} onCommit={onCommit} onCancel={onClose} />
    </div>
  )
}

function InlineInput({
  column,
  value,
  onCommit,
  onCancel,
}: {
  column: ColumnDef
  value: unknown
  onCommit: (v: unknown) => void
  onCancel: () => void
}) {
  const [v, setV] = useState<string>(value == null ? '' : String(value))
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const type =
    column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : column.type === 'url' ? 'url' : 'text'
  return (
    <input
      ref={ref}
      type={type}
      className="w-full rounded border border-transparent px-1.5 py-1 text-[13px] outline-none focus:border-[#8a8886]"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (column.type === 'number') {
            const n = Number(v)
            onCommit(Number.isFinite(n) && v.trim() ? n : null)
          } else {
            onCommit(v)
          }
        } else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        if (column.type === 'number') {
          const n = Number(v)
          onCommit(Number.isFinite(n) && v.trim() ? n : null)
        } else {
          onCommit(v)
        }
      }}
    />
  )
}

// ─────────────────────────────────────────────────────────
// select/multi_select 옵션 팝오버
// ─────────────────────────────────────────────────────────
function OptionPicker({
  column,
  selected,
  multi,
  onPick,
  onColumnChange,
}: {
  column: ColumnDef
  selected: string[]
  multi: boolean
  onPick: (next: string | string[]) => void
  onColumnChange?: (c: ColumnDef) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = column.options.filter(
    (o) => !query || o.label.toLowerCase().includes(query.toLowerCase()) || o.value.toLowerCase().includes(query.toLowerCase()),
  )

  const toggle = (value: string) => {
    if (!multi) {
      onPick(selected[0] === value ? '' : value)
      return
    }
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    onPick(next)
  }

  const addNew = () => {
    const v = query.trim()
    if (!v) return
    const nextCol = ensureOption(column, v)
    if (onColumnChange) onColumnChange(nextCol)
    if (multi) onPick([...selected, v])
    else onPick(v)
    setQuery('')
  }

  const cycleColor = (opt: SelectOption) => {
    const idx = SELECT_COLORS.indexOf(opt.color)
    const next = SELECT_COLORS[(idx + 1) % SELECT_COLORS.length]
    if (!onColumnChange) return
    onColumnChange({
      ...column,
      options: column.options.map((o) => (o.value === opt.value ? { ...o, color: next as SelectColor } : o)),
    })
  }

  const rename = (opt: SelectOption, newLabel: string) => {
    if (!onColumnChange) return
    onColumnChange({
      ...column,
      options: column.options.map((o) => (o.value === opt.value ? { ...o, label: newLabel } : o)),
    })
  }

  const removeOption = (opt: SelectOption) => {
    if (!onColumnChange) return
    onColumnChange({ ...column, options: column.options.filter((o) => o.value !== opt.value) })
  }

  return (
    <div className="rounded-md border border-[#e3e2e0] bg-white shadow-lg">
      <div className="border-b border-[#e9e9e7] p-1.5">
        <input
          ref={inputRef}
          className="w-full rounded bg-[#f7f7f5] px-2 py-1 text-[12px] outline-none"
          placeholder={tr("옵션 검색 또는 새로 추가…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              e.preventDefault()
              const existing = column.options.find(
                (o) => o.value === query.trim() || o.label === query.trim(),
              )
              if (existing) toggle(existing.value)
              else addNew()
            }
          }}
        />
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filtered.map((opt) => {
          const badge = badgeClasses(opt.color)
          const isSel = selected.includes(opt.value)
          return (
            <div
              key={opt.value}
              className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-[#f7f7f5]"
            >
              <button
                className="flex-1 truncate text-left"
                onClick={() => toggle(opt.value)}
                title={isSel ? tr("선택 해제") : tr("선택")}
              >
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge.bg} ${badge.text}`}>{tr(opt.label)}</span>
              </button>
              {isSel && <span className="text-[11px] text-[#0f7a48]">✓</span>}
              {onColumnChange && (
                <div className="hidden items-center gap-0.5 group-hover:flex">
                  <button
                    className="rounded px-1 text-[10px] text-[#9b9a97] hover:bg-[#efefed]"
                    onClick={(e) => {
                      e.stopPropagation()
                      cycleColor(opt)
                    }}
                    title={tr("색상 바꾸기")}
                  >
                    🎨
                  </button>
                  <button
                    className="rounded px-1 text-[10px] text-[#9b9a97] hover:bg-[#efefed]"
                    onClick={(e) => {
                      e.stopPropagation()
                      const nn = window.prompt(tr("새 라벨"), opt.label)
                      if (nn && nn !== opt.label) rename(opt, nn)
                    }}
                    title={tr("이름 변경")}
                  >
                    ✎
                  </button>
                  <button
                    className="rounded px-1 text-[10px] text-[#9b9a97] hover:bg-[#efefed] hover:text-[#c92a2a]"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`옵션 "${opt.label}" 을 삭제할까요?`)) removeOption(opt)
                    }}
                    title={tr("옵션 삭제")}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {query.trim() && !column.options.find((o) => o.value === query.trim() || o.label === query.trim()) && (
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
            onClick={addNew}
          >
            <span className="text-[10px]">+</span>
            <span>{tr('새 옵션 "')}</span>
            <span className="rounded bg-[#f1f1ef] px-1.5 py-0.5 text-[11px]">{query.trim()}</span>
            <span>" {tr('추가')}</span>
          </button>
        )}
        {filtered.length === 0 && !query && (
          <p className="px-2 py-2 text-center text-[11px] text-[#9b9a97]">{tr("옵션이 없습니다. 위에서 추가하세요.")}</p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// PathPicker — path 타입 셀 편집 시 뜨는 폴더 탐색기
// ─────────────────────────────────────────────────────────
function PathPicker({
  current,
  onPick,
  onCancel,
}: {
  current: string
  onPick: (path: string) => void
  onCancel: () => void
}) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [input, setInput] = useState(current)
  const [error, setError] = useState<string | null>(null)

  const navigate = async (path?: string) => {
    setError(null)
    try {
      const r = await api.browse(path)
      setBrowse(r)
      setInput(r.path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    navigate(current || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="rounded-md border border-[#e3e2e0] bg-white shadow-lg">
      <div className="flex items-center gap-1 border-b border-[#e9e9e7] p-1.5">
        <button
          className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#efefed] disabled:opacity-40"
          onClick={() => browse?.parent && navigate(browse.parent)}
          disabled={!browse?.parent}
          title={tr("상위 폴더")}
        >
          ↑
        </button>
        <input
          className="flex-1 rounded border border-[#e3e2e0] px-2 py-0.5 font-mono text-[11px] outline-none focus:border-[#8a8886]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(input)
          }}
          placeholder={tr("/Users/... 경로 입력 또는 아래에서 선택")}
        />
        <button
          className="rounded bg-[#37352f] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#2b2925]"
          onClick={() => onPick(input)}
          title={tr("이 경로 사용")}
        >

          {tr("선택")}
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#efefed]"
          onClick={onCancel}
          title={tr("취소")}
        >
          ✕
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto p-1 text-[12px]">
        {error && <p className="px-2 py-2 text-[#c92a2a]">{error}</p>}
        {browse?.dirs.map((d) => (
          <button
            key={d.path}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-[#f7f7f5]"
            onClick={() => navigate(d.path)}
            onDoubleClick={() => onPick(d.path)}
            title={tr("더블클릭으로 선택")}
          >
            <span className="text-[13px]">📁</span>
            <span className="truncate text-[#37352f]">{d.name}</span>
          </button>
        ))}
        {browse && browse.dirs.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-[#9b9a97]">{tr("하위 폴더 없음")}</p>
        )}
      </div>
      {browse?.home && (
        <div className="border-t border-[#e9e9e7] p-1">
          <button
            className="rounded px-2 py-0.5 text-[10px] text-[#5f5e5b] hover:bg-[#efefed]"
            onClick={() => navigate(browse.home)}
          >

            {tr("🏠 홈")}
          </button>
        </div>
      )}
    </div>
  )
}
