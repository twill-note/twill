import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { ReactNode } from 'react'
import type { ErdColumn, ErdTable } from './types'
import { commentText } from './comments'

interface LinkingState {
  fromTable: string
  fromColumn: string
  x: number
  y: number
}

interface TableBoxProps {
  table: ErdTable
  selected: boolean
  relationMode: boolean
  linking: LinkingState | null
  typeOptions: string[]
  onSelect: () => void
  onMove: (x: number, y: number) => void
  onTableChange: (patch: Partial<ErdTable>) => void
  onTableDuplicate: () => void
  onTableRemove: () => void
  onColumnAdd: () => void
  onColumnChange: (columnId: string, patch: Partial<ErdColumn>) => void
  onColumnRemove: (columnId: string) => void
  onColumnMove: (columnId: string, direction: -1 | 1) => void
  onColumnReorder: (columnId: string, targetColumnId: string, position: 'before' | 'after') => void
  onRelationColumnPick: (columnId: string, event: ReactMouseEvent<HTMLElement>) => void
  scale: number
}

interface DragState {
  clientX: number
  clientY: number
  x: number
  y: number
}

interface ResizeState {
  clientX: number
  width: number
}

interface ColumnDropTarget {
  columnId: string
  position: 'before' | 'after'
}

const MIN_WIDTH = 440

/**
 * 테이블 카드가 주 편집 화면이다. 컬럼의 COMMENT는 default 값과 분리해
 * 항상 독립 열에 표시하고, 부가 속성은 행의 작은 메뉴에서 수정한다.
 */
export default function TableBox({
  table,
  selected,
  relationMode,
  linking,
  typeOptions,
  onSelect,
  onMove,
  onTableChange,
  onTableDuplicate,
  onTableRemove,
  onColumnAdd,
  onColumnChange,
  onColumnRemove,
  onColumnMove,
  onColumnReorder,
  onRelationColumnPick,
  scale,
}: TableBoxProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const [tableMenuOpen, setTableMenuOpen] = useState(false)
  const [openColumnMenu, setOpenColumnMenu] = useState<string | null>(null)
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null)
  const [columnDropTarget, setColumnDropTarget] = useState<ColumnDropTarget | null>(null)

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current
      const resize = resizeRef.current
      if (drag) {
        onMove(
          drag.x + (event.clientX - drag.clientX) / scale,
          drag.y + (event.clientY - drag.clientY) / scale,
        )
      }
      if (resize) {
        onTableChange({ width: Math.max(MIN_WIDTH, Math.round(resize.width + (event.clientX - resize.clientX) / scale)) })
      }
    }
    const onMouseUp = () => {
      dragRef.current = null
      resizeRef.current = null
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onMove, onTableChange, scale])

  // 카드 밖을 누르면 옵션 메뉴를 닫아 캔버스 작업을 방해하지 않게 한다.
  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const clickedMenu = target.closest('[data-erd-menu], [data-erd-menu-trigger]')
      if (!rootRef.current?.contains(target) || !clickedMenu) {
        setTableMenuOpen(false)
        setOpenColumnMenu(null)
      }
    }
    window.addEventListener('mousedown', closeMenus, true)
    return () => window.removeEventListener('mousedown', closeMenus, true)
  }, [])

  const startDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: table.x,
      y: table.y,
    }
    onSelect()
  }

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (linking) return
    event.preventDefault()
    event.stopPropagation()
    resizeRef.current = { clientX: event.clientX, width: Math.max(table.width, MIN_WIDTH) }
    onSelect()
  }

  const stopPropagation = (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation()
  const controlsDisabled = Boolean(linking)
  const headerTextColor = hasLightBackground(table.color) ? '#37352f' : '#ffffff'
  const tableComment = commentText(table)

  const pickRelationColumn = (columnId: string, event: ReactMouseEvent<HTMLDivElement>) => {
    if (!relationMode) return
    event.stopPropagation()
    onRelationColumnPick(columnId, event)
  }

  const beginColumnDrag = (event: ReactDragEvent<HTMLElement>, columnId: string) => {
    if (controlsDisabled || relationMode) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', columnId)
    setDraggingColumnId(columnId)
    setColumnDropTarget(null)
  }

  const updateColumnDropTarget = (event: ReactDragEvent<HTMLDivElement>, columnId: string) => {
    if (!draggingColumnId || draggingColumnId === columnId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setColumnDropTarget({
      columnId,
      position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    })
  }

  const dropColumn = (event: ReactDragEvent<HTMLDivElement>, targetColumnId: string) => {
    event.preventDefault()
    const draggedId = draggingColumnId ?? event.dataTransfer.getData('text/plain')
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (draggedId && draggedId !== targetColumnId) onColumnReorder(draggedId, targetColumnId, position)
    setDraggingColumnId(null)
    setColumnDropTarget(null)
  }

  return (
    <div
      ref={rootRef}
      className="absolute select-none"
      style={{ left: table.x, top: table.y, width: Math.max(table.width, MIN_WIDTH) }}
      onMouseDown={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
      <div
        className={`overflow-visible rounded-md border bg-white shadow-[0_2px_8px_rgba(55,53,47,0.12)] ${
          selected ? 'border-[#37352f] ring-2 ring-[#d3d1cb]' : 'border-[#e3e2e0]'
        }`}
      >
        <div
          className="relative flex h-9 cursor-grab items-center gap-2 rounded-t-md px-2.5 text-white active:cursor-grabbing"
          style={{ backgroundColor: table.color, color: headerTextColor }}
          onMouseDown={startDrag}
        >
          <input
            className="min-w-0 flex-1 rounded bg-transparent px-1 font-mono text-[14px] font-semibold outline-none placeholder:text-current placeholder:opacity-65 hover:bg-black/10 focus:bg-black/15"
            value={table.name}
            placeholder="table_name"
            title="테이블 이름"
            disabled={controlsDisabled}
            onMouseDown={stopPropagation}
            onChange={(event) => onTableChange({ name: event.target.value })}
          />
          <span className="rounded bg-black/15 px-1.5 py-0.5 text-[10px] tabular-nums">{table.columns.length}</span>
          <button
            type="button"
            className="grid h-5 w-5 place-items-center rounded text-white/80 hover:bg-black/15 hover:text-white"
            title="테이블 옵션"
            disabled={controlsDisabled}
            onMouseDown={stopPropagation}
            onClick={() => {
              setOpenColumnMenu(null)
              setTableMenuOpen((open) => !open)
            }}
            data-erd-menu-trigger
          >
            <MoreIcon />
          </button>
        </div>

        <div className="flex h-8 items-center gap-2 border-b border-[#efefed] bg-[#fbfbfa] px-2.5">
          <span className="shrink-0 text-[9px] font-semibold tracking-[0.08em] text-[#9b9a97]">COMMENT</span>
          <input
            className="min-w-0 flex-1 rounded bg-transparent px-1 text-[12px] text-[#5f5e5b] outline-none placeholder:text-[#c8c7c4] hover:bg-[#f1f1ef] focus:bg-[#f7f7f5] focus:ring-1 focus:ring-[#d3d1cb]"
            value={tableComment}
            placeholder="테이블 설명"
            title={tableComment || '테이블 COMMENT'}
            disabled={controlsDisabled}
            // 일부 브라우저 테마에서 transparent 배경 input의 글자색이 상속돼 COMMENT가
            // 자리표시자만 보이는 문제를 막는다.
            style={{ color: '#5f5e5b', WebkitTextFillColor: '#5f5e5b', opacity: 1 }}
            onMouseDown={stopPropagation}
            onChange={(event) => onTableChange({ note: event.target.value || undefined })}
          />
        </div>

        <div className="grid h-7 grid-cols-[42px_minmax(100px,1fr)_minmax(92px,0.8fr)_minmax(130px,1.15fr)] items-center border-b border-[#efefed] bg-[#f1f1ef] px-2.5 text-[9px] font-semibold tracking-[0.07em] text-[#9b9a97]">
          <span className="text-center">KEY</span>
          <span>COLUMN</span>
          <span>TYPE</span>
          <span>COMMENT</span>
        </div>

        <div className="divide-y divide-[#efefed]">
          {table.columns.length === 0 ? (
            <div className="flex h-9 items-center px-3 text-[11px] italic text-[#9b9a97]">컬럼 없음</div>
          ) : (
            table.columns.map((column) => {
              const columnComment = commentText(column)
              return (
                <div key={column.id} className="relative">
                  {columnDropTarget?.columnId === column.id && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-blue-500"
                      style={{ top: columnDropTarget.position === 'before' ? 0 : '100%' }}
                    />
                  )}
                  <div
                    className={`grid h-9 grid-cols-[42px_minmax(100px,1fr)_minmax(92px,0.8fr)_minmax(130px,1.15fr)] items-center px-2.5 text-[13px] ${
                      relationMode
                        ? linking?.fromTable === table.id && linking.fromColumn === column.id
                          ? 'cursor-crosshair bg-[#e8e7e4]'
                          : 'cursor-crosshair bg-[#fbfbfa] hover:bg-[#efefed]'
                        : 'hover:bg-[#f7f7f5]'
                    }`}
                    onClick={(event) => pickRelationColumn(column.id, event)}
                    onDragOver={(event) => updateColumnDropTarget(event, column.id)}
                    onDrop={(event) => dropColumn(event, column.id)}
                  >
                  <div className="flex items-center justify-center gap-0.5" onMouseDown={stopPropagation}>
                    <span
                      draggable={!controlsDisabled && !relationMode}
                      className={`grid h-5 w-3 shrink-0 cursor-grab place-items-center text-[#b4b3b0] active:cursor-grabbing ${
                        draggingColumnId === column.id ? 'opacity-40' : 'hover:text-[#5f5e5b]'
                      }`}
                      title="드래그하여 컬럼 순서 변경"
                      onDragStart={(event) => beginColumnDrag(event, column.id)}
                      onDragEnd={() => {
                        setDraggingColumnId(null)
                        setColumnDropTarget(null)
                      }}
                      onClick={stopPropagation}
                    >
                      <DragHandleIcon />
                    </span>
                    {column.isPK && (
                      <button
                        type="button"
                        className="grid h-5 w-5 place-items-center rounded text-[#d6a33c] hover:bg-[#fff9eb]"
                        title="Primary key 해제"
                        disabled={controlsDisabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          onColumnChange(column.id, { isPK: false })
                        }}
                      >
                        <KeyIcon />
                      </button>
                    )}
                    {column.isFK && (
                      <span className="grid h-5 w-5 place-items-center text-[#4a9eff]" title="Foreign key">
                        <KeyIcon />
                      </span>
                    )}
                    {!column.isPK && !column.isFK && (
                      <button
                        type="button"
                        className="grid h-5 w-5 place-items-center rounded text-transparent hover:bg-[#f1f1ef] hover:text-[#d6a33c]"
                        title="Primary key로 지정"
                        disabled={controlsDisabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          onColumnChange(column.id, { isPK: true, nullable: false })
                        }}
                      >
                        <KeyIcon />
                      </button>
                    )}
                  </div>
                  <input
                    className="min-w-0 rounded bg-transparent px-1 font-mono text-[13px] text-[#37352f] outline-none hover:bg-[#f1f1ef] focus:bg-[#f7f7f5] focus:ring-1 focus:ring-[#d3d1cb]"
                    value={column.name}
                    placeholder="column_name"
                    title={column.name}
                    disabled={controlsDisabled}
                    onMouseDown={stopPropagation}
                    onClick={stopPropagation}
                    onChange={(event) => onColumnChange(column.id, { name: event.target.value })}
                  />
                  <input
                    list={`erd-types-${table.id}`}
                    className="min-w-0 rounded bg-transparent px-1 font-mono text-[12px] text-[#5f5e5b] outline-none hover:bg-[#f1f1ef] focus:bg-[#f7f7f5] focus:ring-1 focus:ring-[#d3d1cb]"
                    value={column.type}
                    placeholder="TYPE"
                    title={column.type}
                    disabled={controlsDisabled}
                    onMouseDown={stopPropagation}
                    onClick={stopPropagation}
                    onChange={(event) => onColumnChange(column.id, { type: event.target.value })}
                  />
                  <div className="flex min-w-0 items-center gap-0.5" onMouseDown={stopPropagation}>
                    <input
                      className="min-w-0 flex-1 rounded bg-transparent px-1 text-[12px] text-[#5f5e5b] outline-none placeholder:text-[#c8c7c4] hover:bg-[#f1f1ef] focus:bg-[#f7f7f5] focus:ring-1 focus:ring-[#d3d1cb]"
                      value={columnComment}
                      placeholder="설명"
                      title={columnComment || '컬럼 COMMENT'}
                      disabled={controlsDisabled}
                      style={{ color: '#5f5e5b', WebkitTextFillColor: '#5f5e5b', opacity: 1 }}
                      onClick={stopPropagation}
                      onChange={(event) => onColumnChange(column.id, { note: event.target.value || undefined })}
                    />
                    <button
                      type="button"
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded text-[#9b9a97] hover:bg-[#efefed] hover:text-[#5f5e5b] ${
                        openColumnMenu === column.id ? 'bg-[#efefed] text-[#5f5e5b]' : ''
                      }`}
                      title="컬럼 옵션"
                      disabled={controlsDisabled}
                      onClick={(event) => {
                        event.stopPropagation()
                        setTableMenuOpen(false)
                        setOpenColumnMenu((open) => (open === column.id ? null : column.id))
                      }}
                      data-erd-menu-trigger
                    >
                      <MoreIcon />
                    </button>
                  </div>
                  </div>

                {openColumnMenu === column.id && (
                  <ColumnMenu
                    column={column}
                    isFirst={table.columns[0]?.id === column.id}
                    isLast={table.columns.at(-1)?.id === column.id}
                    onClose={() => setOpenColumnMenu(null)}
                    onChange={(patch) => onColumnChange(column.id, patch)}
                    onRemove={() => {
                      setOpenColumnMenu(null)
                      onColumnRemove(column.id)
                    }}
                    onMove={(direction) => onColumnMove(column.id, direction)}
                  />
                )}
              </div>
              )
            })
          )}
        </div>

        <button
          type="button"
          className="flex h-8 w-full items-center px-3 text-left text-[10px] font-medium text-[#5f5e5b] hover:bg-[#f1f1ef]"
          disabled={controlsDisabled}
          onMouseDown={stopPropagation}
          onClick={onColumnAdd}
        >
          <PlusIcon />
          <span className="ml-1">컬럼 추가</span>
        </button>
      </div>

      <div
        className={`absolute -right-1 top-0 z-20 flex h-full w-3 cursor-ew-resize items-center justify-center ${
          selected ? 'text-[#777672]' : 'text-transparent hover:text-[#9b9a97]'
        }`}
        onMouseDown={startResize}
        title="드래그하여 테이블 너비 조절"
        aria-label="테이블 너비 조절"
      >
        <span className="h-8 w-px rounded bg-current" />
      </div>

      {tableMenuOpen && (
        <TableMenu
          table={table}
          onClose={() => setTableMenuOpen(false)}
          onChange={onTableChange}
          onDuplicate={() => {
            setTableMenuOpen(false)
            onTableDuplicate()
          }}
          onRemove={() => {
            setTableMenuOpen(false)
            onTableRemove()
          }}
        />
      )}
      <datalist id={`erd-types-${table.id}`}>
        {typeOptions.map((type) => <option key={type} value={type} />)}
      </datalist>
    </div>
  )
}

function TableMenu({
  table,
  onClose,
  onChange,
  onDuplicate,
  onRemove,
}: {
  table: ErdTable
  onClose: () => void
  onChange: (patch: Partial<ErdTable>) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  return (
    <div
      className="absolute right-1 top-8 z-30 w-48 rounded-md border border-[#e3e2e0] bg-white p-2 text-[10px] text-[#5f5e5b] shadow-lg"
      onMouseDown={(event) => event.stopPropagation()}
      data-erd-menu
    >
      <div className="mb-1 flex items-center justify-between px-1 text-[8px] font-semibold tracking-[0.08em] text-[#9b9a97]">
        테이블 옵션
        <button className="rounded px-1 hover:bg-[#f1f1ef]" onClick={onClose} title="닫기">×</button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1 border-b border-[#efeeeb] px-1 pb-2">
        {['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#6b7280'].map((color) => (
          <button
            key={color}
            type="button"
            className={`h-4 w-4 rounded-full ring-offset-1 ${table.color === color ? 'ring-2 ring-[#37352f]' : 'hover:ring-1 hover:ring-[#9b9a97]'}`}
            style={{ backgroundColor: color }}
            title="헤더 색상"
            onClick={() => onChange({ color })}
          />
        ))}
      </div>
      <button className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 hover:bg-[#f1f1ef]" onClick={onDuplicate}>
        <CopyIcon /> 테이블 복제
      </button>
      <button className="mt-0.5 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[#c34e4e] hover:bg-[#fff3f3]" onClick={onRemove}>
        <TrashIcon /> 테이블 삭제
      </button>
    </div>
  )
}

function ColumnMenu({
  column,
  isFirst,
  isLast,
  onClose,
  onChange,
  onRemove,
  onMove,
}: {
  column: ErdColumn
  isFirst: boolean
  isLast: boolean
  onClose: () => void
  onChange: (patch: Partial<ErdColumn>) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) {
  return (
    <div
      className="absolute right-1 top-7 z-20 w-60 rounded-md border border-[#e3e2e0] bg-white p-2 text-[10px] text-[#5f5e5b] shadow-lg"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      data-erd-menu
    >
      <div className="mb-1.5 flex items-center justify-between text-[8px] font-semibold tracking-[0.08em] text-[#9b9a97]">
        컬럼 옵션
        <button className="rounded px-1 hover:bg-[#f1f1ef]" onClick={onClose} title="닫기">×</button>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 border-b border-[#efeeeb] pb-2">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={!column.nullable} disabled={column.isPK} onChange={(event) => onChange({ nullable: !event.target.checked })} />
          NOT NULL
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={column.unique} disabled={column.isPK} onChange={(event) => onChange({ unique: event.target.checked })} />
          UNIQUE
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={column.isFK} onChange={(event) => onChange({ isFK: event.target.checked })} />
          FOREIGN KEY
        </label>
      </div>
      <label className="mt-2 block text-[8px] font-semibold tracking-[0.08em] text-[#9b9a97]">
        DEFAULT
        <input
          className="mt-1 w-full rounded border border-[#e3e2e0] px-1.5 py-1 font-mono text-[10px] text-[#37352f] outline-none focus:border-[#d3d1cb]"
          placeholder="예: CURRENT_TIMESTAMP"
          value={column.defaultVal ?? ''}
          onChange={(event) => onChange({ defaultVal: event.target.value || undefined })}
        />
      </label>
      <div className="mt-2 flex items-center gap-1 border-t border-[#efeeeb] pt-2">
        <button className="rounded px-1.5 py-1 hover:bg-[#f1f1ef] disabled:text-[#c9c8c4]" disabled={isFirst} onClick={() => onMove(-1)}>위로</button>
        <button className="rounded px-1.5 py-1 hover:bg-[#f1f1ef] disabled:text-[#c9c8c4]" disabled={isLast} onClick={() => onMove(1)}>아래로</button>
        <button className="ml-auto rounded px-1.5 py-1 text-[#c34e4e] hover:bg-[#fff3f3]" onClick={onRemove}>삭제</button>
      </div>
    </div>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>{children}</svg>
}

function KeyIcon() {
  return <Icon><circle cx="5.1" cy="8" r="2.7" /><path d="M7.8 8h6.1M11.5 8v2M13.2 8v1.4" /></Icon>
}

function MoreIcon() {
  return <Icon><circle cx="3" cy="8" r=".5" fill="currentColor" /><circle cx="8" cy="8" r=".5" fill="currentColor" /><circle cx="13" cy="8" r=".5" fill="currentColor" /></Icon>
}

function DragHandleIcon() {
  return <Icon><circle cx="5" cy="4.5" r=".55" fill="currentColor" /><circle cx="11" cy="4.5" r=".55" fill="currentColor" /><circle cx="5" cy="8" r=".55" fill="currentColor" /><circle cx="11" cy="8" r=".55" fill="currentColor" /><circle cx="5" cy="11.5" r=".55" fill="currentColor" /><circle cx="11" cy="11.5" r=".55" fill="currentColor" /></Icon>
}

function PlusIcon() {
  return <Icon><path d="M8 3.5v9M3.5 8h9" /></Icon>
}

function CopyIcon() {
  return <Icon><rect x="5.5" y="5.5" width="7" height="7" rx="1" /><path d="M10.5 5.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" /></Icon>
}

function TrashIcon() {
  return <Icon><path d="M3.5 5h9M6.3 3.5h3.4M5 5l.5 7h5l.5-7" /></Icon>
}

function hasLightBackground(color: string): boolean {
  const hex = color.match(/^#([\da-f]{6})$/i)?.[1]
  if (!hex) return false
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return (red * 0.299 + green * 0.587 + blue * 0.114) > 154
}
