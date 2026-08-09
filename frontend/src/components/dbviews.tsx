import { useMemo, useState } from 'react'
import { cellValue, propKeysOf } from '../dbmodel'
import {
  badgeClasses,
  defaultColumn,
  findOption,
  type ColumnDef,
  type DbConfig,
} from '../dbschema'
import { dialog } from '../dialog'
import type { NoteRow } from '../types'
import DbCell from './DbCell'
import DbColumnConfig from './DbColumnConfig'

/** 데이터베이스 뷰 공용 컴포넌트 — 전체 페이지(DatabaseView)와 본문 임베드 블록(dbview)이 함께 사용 */

export type DbRowMenuItem = {
  icon?: string
  label: string
  onClick: () => void
  title?: string
  danger?: boolean
}

function displayRowTitle(row: NoteRow, config: DbConfig): string {
  if (config.kind === 'scopes_board') {
    const label = String(row.props.label ?? '').trim()
    if (label) return label
  }
  return row.title
}

interface CommonProps {
  rows: NoteRow[]
  config: DbConfig
  onOpen: (path: string) => void
  /** 워크스페이스 문서를 현재 앱의 편집기 탭에서 연다. */
  onOpenDocument?: (path: string) => void
  /** 셀 값 변경. serializeValue 를 거쳐 정규화된 값이 전달됨. */
  onCellChange: (path: string, key: string, value: unknown) => void | Promise<void>
  /** 컬럼 정의 하나 변경 (옵션 추가/색상/이름 등). */
  onColumnChange?: (col: ColumnDef) => void | Promise<void>
  /** 컬럼을 스키마에서 제거 */
  onColumnDelete?: (key: string) => void | Promise<void>
  /** 새 컬럼 추가 */
  onColumnAdd?: () => void | Promise<void>
  /** 행 우클릭 메뉴에 DB 종류별 전용 동작을 더한다. */
  rowMenuItems?: (row: NoteRow) => DbRowMenuItem[]
}

interface TableProps extends CommonProps {
  /** 본문 임베드용 — 여백 축소, 수정일 컬럼 생략 */
  compact?: boolean
  /** "+새로 만들기" 버튼 표시 여부 및 클릭 핸들러 */
  onCreateRow?: () => void | Promise<void>
  /** 날짜·태그가 의미 없는 카탈로그형 테이블에서 기본 컬럼을 숨긴다. */
  showDate?: boolean
  showTags?: boolean
  /** 카탈로그처럼 모든 셀을 조회 전용으로 표시한다. */
  readOnly?: boolean
  emptyLabel?: string
}

/**
 * `config.columns` 를 우선 표시하고, 스키마에 정의되지 않은 frontmatter props 는
 * 자동으로 뒤에 붙여 default text 컬럼으로 렌더한다. 사용자는 헤더 팝오버에서 타입을
 * 지정해 스키마에 승격시킬 수 있다.
 */
function resolveColumns(config: DbConfig, rows: NoteRow[], tableView = false): ColumnDef[] {
  // 프로젝트 관리는 고정 첫 열에서 label을 프로젝트명으로 표시한다. 나머지 내부
  // frontmatter와 사용자 추가 열은 숨기고 실제 경로만 편집 열로 노출한다.
  if (config.kind === 'scopes_board') {
    const pathColumn = config.columns.find((column) => column.key === 'path')
    return pathColumn ? [{ ...pathColumn, label: '경로', type: 'path', visible: true }] : []
  }
  const defined = new Map(config.columns.map((c) => [c.key, c]))
  // 자동 생성 카드의 출처·중복 방지 플래그는 보드 내부 메타데이터다. 일반 컬럼으로
  // 노출하면 사람이 작성한 카드와의 비교가 흐려지므로 태스크 보드에서는 숨긴다.
  const taskInternalKeys = new Set([
    'origin',
    'plan_reviewed',
    'auto_created',
    'followup_key',
    'source_run',
    'source_task',
    'source_note',
    'source_request',
    // 대화에서 등록한 카드가 원본 벼리 세션을 다시 열기 위한 연결 id.
    'source_session',
    // 카드 이동·이름 변경 뒤 대화 출처를 복원하는 내부 UUID.
    'source_card_id',
    'section_id',
  ])
  // 실행 파이프라인에는 필요하지만 사람이 훑는 태스크 표에는 불필요한 메타데이터.
  // 원본 frontmatter는 보존하고 표의 컬럼에서만 제외한다.
  const taskTableHiddenKeys = new Set([
    'approval',
    'current_run',
    'priority',
    'task_template',
  ])
  const orphanKeys = propKeysOf(rows).filter(
    (k) =>
      !defined.has(k) &&
      !(
        config.kind === 'task_board' &&
        (taskInternalKeys.has(k) || (tableView && taskTableHiddenKeys.has(k)))
      ),
  )
  return [
    ...config.columns.filter(
      (c) =>
        c.visible !== false &&
        !(config.kind === 'task_board' && tableView && taskTableHiddenKeys.has(c.key)),
    ),
    ...orphanKeys.map((k) => defaultColumn(k, 'text')),
  ]
}

export function DbTable({
  rows,
  config,
  onOpen,
  onOpenDocument,
  onCellChange,
  onColumnChange,
  onColumnDelete,
  onColumnAdd,
  rowMenuItems,
  onCreateRow,
  compact = false,
  showDate = true,
  showTags = true,
  readOnly = false,
  emptyLabel = '노트가 없습니다',
}: TableProps) {
  const [sort, setSort] = useState<{ key: string; asc: boolean }>({
    key: showDate ? 'date' : 'title',
    asc: !showDate,
  })
  const [configCol, setConfigCol] = useState<{ col: ColumnDef; anchor: HTMLElement } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: NoteRow } | null>(null)
  const dataColumns = useMemo(() => resolveColumns(config, rows, true), [config, rows])
  const displayTags = showTags && config.kind !== 'task_board'

  const sorted = useMemo(() => {
    const dir = sort.asc ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = sort.key === 'title' ? displayRowTitle(a, config) : cellValue(a, sort.key)
      const vb = sort.key === 'title' ? displayRowTitle(b, config) : cellValue(b, sort.key)
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      if (va === '' && vb !== '') return 1
      if (vb === '' && va !== '') return -1
      return String(va).localeCompare(String(vb), 'ko') * dir
    })
  }, [rows, sort, config])

  const pad = compact ? 'px-2 py-1' : 'px-2 py-1.5'
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === 'title' }))

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[#e9e9e7]">
            <th
              className={`${pad} cursor-pointer text-left font-medium whitespace-nowrap text-[#9b9a97] select-none hover:text-[#37352f]`}
              onClick={() => toggleSort('title')}
            >
              {config.kind === 'scopes_board' ? '프로젝트' : '제목'}
              {sort.key === 'title' && <span className="ml-1 text-[10px]">{sort.asc ? '▲' : '▼'}</span>}
            </th>
            {showDate && (
              <th
                className={`${pad} cursor-pointer text-left font-medium whitespace-nowrap text-[#9b9a97] select-none hover:text-[#37352f]`}
                onClick={() => toggleSort('date')}
              >
                날짜{sort.key === 'date' && <span className="ml-1 text-[10px]">{sort.asc ? '▲' : '▼'}</span>}
              </th>
            )}
            {displayTags && <th className={`${pad} text-left font-medium whitespace-nowrap text-[#9b9a97]`}>태그</th>}
            {dataColumns.map((c) => (
              <th
                key={c.key}
                className={`${pad} min-w-[120px] text-left font-medium whitespace-nowrap text-[#9b9a97] select-none`}
              >
                <button
                  className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[#f1f1ef] hover:text-[#37352f]"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (onColumnChange) setConfigCol({ col: c, anchor: e.currentTarget })
                  }}
                  title="컬럼 설정"
                >
                  <span className="text-[10px] text-[#9b9a97]">{typeIcon(c.type)}</span>
                  <span>{c.label ?? c.key}</span>
                </button>
                <button
                  className="ml-0.5 rounded px-0.5 text-[10px] text-[#c7c6c2] hover:text-[#37352f]"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSort(c.key)
                  }}
                  title="정렬"
                >
                  {sort.key === c.key ? (sort.asc ? '▲' : '▼') : '⇅'}
                </button>
              </th>
            ))}
            {onColumnAdd && (
              <th className={`${pad}`}>
                <button
                  className="rounded px-2 py-0.5 text-[12px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
                  onClick={onColumnAdd}
                  title="새 컬럼"
                >
                  +
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.path}
              className="group cursor-pointer border-b border-[#f1f1ef] hover:bg-[#fbfbfa]"
              title={r.path}
              onContextMenu={(event) => {
                if (!rowMenuItems?.(r).length) return
                event.preventDefault()
                setCtxMenu({ x: event.clientX, y: event.clientY, row: r })
              }}
            >
              <td
                className={`${pad} max-w-[320px] truncate font-medium text-[#37352f]`}
                onClick={() => onOpen(r.path)}
                title={config.kind === 'scopes_board' ? '프로젝트 AGENTS.md 열기' : undefined}
              >
                {config.kind === 'scopes_board' ? '🎯' : r.icon || '📄'} {displayRowTitle(r, config)}
              </td>
              {showDate && (
                <td className={`${pad} whitespace-nowrap text-[#787774]`} onClick={() => onOpen(r.path)}>
                  {r.date ?? ''}
                </td>
              )}
              {displayTags && (
                <td className={pad} onClick={() => onOpen(r.path)}>
                  <div className="flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <span key={t} className="rounded-full bg-[#ececea] px-1.5 py-0.5 text-[11px] text-[#5f5e5b]">
                        #{t}
                      </span>
                    ))}
                  </div>
                </td>
              )}
              {dataColumns.map((c) => (
                <td key={c.key} className={`${pad} max-w-[220px] text-[#5f5e5b]`}>
                  <DbCell
                    column={c}
                    raw={r.props[c.key]}
                    readOnly={readOnly}
                    onOpenDocument={onOpenDocument}
                    onCommit={(v) => onCellChange(r.path, c.key, v)}
                    onColumnChange={onColumnChange}
                  />
                </td>
              ))}
              {onColumnAdd && <td className={pad}></td>}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={1 + Number(showDate) + Number(displayTags) + dataColumns.length + (onColumnAdd ? 1 : 0)}
                className="px-2 py-6 text-center text-[#9b9a97]"
              >
                {emptyLabel}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {onCreateRow && (
        <button
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[#9b9a97] hover:bg-[#f7f7f5] hover:text-[#37352f]"
          onClick={onCreateRow}
        >
          <span>+</span>
          <span>새로 만들기</span>
        </button>
      )}
      {configCol && onColumnChange && (
        <DbColumnConfig
          anchor={configCol.anchor}
          column={configCol.col}
          onChange={(next) => {
            onColumnChange(next)
            setConfigCol((s) => (s ? { ...s, col: next } : s))
          }}
          onDelete={() => {
            if (onColumnDelete) onColumnDelete(configCol.col.key)
            setConfigCol(null)
          }}
          onClose={() => setConfigCol(null)}
        />
      )}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-56 rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
            style={{
              left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 232)),
              top: Math.min(ctxMenu.y, window.innerHeight - 100),
            }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => {
                onOpen(ctxMenu.row.path)
                setCtxMenu(null)
              }}
            >
              <span>📄</span> 열기
            </button>
            {(rowMenuItems?.(ctxMenu.row) ?? []).map((item, index) => (
              <button
                key={`${item.label}-${index}`}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[#f1f1ef] ${
                  item.danger ? 'text-[#c92a2a] hover:bg-[#fdf2f2]' : 'text-[#37352f]'
                }`}
                title={item.title}
                onClick={() => {
                  setCtxMenu(null)
                  item.onClick()
                }}
              >
                {item.icon && <span>{item.icon}</span>}
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function typeIcon(t: ColumnDef['type']): string {
  switch (t) {
    case 'number':
      return '#'
    case 'select':
      return '◉'
    case 'status':
      return '●'
    case 'multi_select':
      return '≡'
    case 'date':
      return '📅'
    case 'checkbox':
      return '☐'
    case 'url':
      return '🔗'
    case 'path':
      return '📁'
    default:
      return 'T'
  }
}

interface BoardProps extends CommonProps {
  /** 그룹핑할 frontmatter 속성 키 (예: status) */
  groupBy: string
  onMove?: (path: string, value: string) => void
  onCreateRow?: (groupValue?: string) => void | Promise<void>
  /** 카드 우측 상단 액션 (예: 태스크 보드 '실행 중' 컬럼의 ▶ 실행 버튼). null 반환 시 미표시. */
  cardAction?: (row: NoteRow, groupValue: string) => React.ReactNode
  /** 카드 제목 아래의 상태·메타 배지. 버튼을 반환해도 카드 열기 이벤트와 충돌하지 않는다. */
  cardBadge?: (row: NoteRow, groupValue: string) => React.ReactNode
  /** 카드 삭제(휴지통 이동). 지정하면 카드 우클릭 메뉴와 컬럼 ⋯ 메뉴의 정리 항목이 활성화된다. */
  onDeleteRow?: (path: string) => void | Promise<void>
  /** 카드 우클릭 메뉴에 DB 종류별 전용 동작을 더한다. */
  rowMenuItems?: (row: NoteRow) => DbRowMenuItem[]
  /** 컬럼 ⋯ 메뉴에 추가할 항목들 (예: '실행' 컬럼의 전체 실행). 빈 배열이면 기본 항목만. */
  columnMenuExtras?: (
    groupValue: string,
    items: NoteRow[],
  ) => Array<{ icon?: string; label: string; onClick: () => void; disabled?: boolean; title?: string }>
  /** 전체 페이지 보드용: 보드가 부모 높이를 채우고 각 컬럼이 내부 스크롤 —
   *  가로 스크롤바가 항상 화면 하단에 보이게 된다 (긴 컬럼 때문에 페이지가 늘어나지 않음). */
  fillHeight?: boolean
}

export function DbBoard({ rows, config, groupBy, onOpen, onOpenDocument, onCellChange, onMove, onCreateRow, cardAction, cardBadge, onDeleteRow, rowMenuItems, columnMenuExtras, fillHeight = false }: BoardProps) {
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: NoteRow } | null>(null)
  const [colMenu, setColMenu] = useState<{ x: number; y: number; value: string; label: string } | null>(null)
  const groupCol = config.columns.find((c) => c.key === groupBy) ?? null
  const dataColumns = useMemo(() => resolveColumns(config, rows).filter((c) => c.key !== groupBy), [
    config,
    rows,
    groupBy,
  ])

  const groups = useMemo(() => {
    const map = new Map<string, NoteRow[]>()
    // groupCol 의 옵션 순서를 우선으로 초기화 → 빈 그룹도 표시
    if (groupCol) {
      for (const opt of groupCol.options) map.set(opt.value, [])
    }
    rows.forEach((r) => {
      const raw = r.props[groupBy]
      const v = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw)
      map.set(v, [...(map.get(v) ?? []), r])
    })
    const entries = [...map.entries()]
    if (groupCol) {
      const order = new Map(groupCol.options.map((o, i) => [o.value, i]))
      entries.sort(([a], [b]) => {
        if (a === '') return 1
        if (b === '') return -1
        const ai = order.get(a) ?? 9999
        const bi = order.get(b) ?? 9999
        if (ai !== bi) return ai - bi
        return a.localeCompare(b, 'ko')
      })
    }
    return entries
  }, [rows, groupBy, groupCol])

  if (!groupBy) {
    return <p className="px-2 py-6 text-center text-[13px] text-[#9b9a97]">그룹으로 사용할 속성을 선택하세요</p>
  }

  const cleanupColumn = async (label: string, items: NoteRow[]) => {
    if (!onDeleteRow || items.length === 0) return
    const ok = await dialog.confirm(`'${label}' 컬럼의 카드 ${items.length}개를 모두 휴지통으로 이동할까요?`, {
      detail: '휴지통(.trash)으로 이동하므로 필요하면 복구할 수 있습니다.',
      confirmLabel: '모두 이동',
      danger: true,
    })
    if (!ok) return
    for (const r of items) {
      await onDeleteRow(r.path)
    }
  }

  return (
    <div className={`flex items-start gap-3 overflow-x-auto pb-1 ${fillHeight ? 'h-full' : ''}`}>
      {groups.map(([value, items]) => {
        const opt = groupCol ? findOption(groupCol, value) : null
        const badge = badgeClasses(opt?.color ?? 'default')
        const columnLabel = opt ? opt.label : value || '미분류'
        return (
          <div
            key={value || '(없음)'}
            className={`group/col w-64 shrink-0 rounded-lg bg-[#f7f7f5] p-2 ${
              fillHeight ? 'flex max-h-full flex-col' : ''
            } ${dragOver === value ? 'ring-2 ring-blue-300' : ''}`}
            onDragOver={(e) => {
              if (onMove) {
                e.preventDefault()
                setDragOver(value)
              }
            }}
            onDragLeave={() => setDragOver((d) => (d === value ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(null)
              const path = e.dataTransfer.getData('text/db-note')
              if (path && onMove) onMove(path, value)
            }}
          >
            <div className="mb-1.5 flex shrink-0 items-center gap-1.5 px-1">
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${badge.bg} ${badge.text}`}>
                {columnLabel}
              </span>
              <span className="text-[11px] text-[#9b9a97]">{items.length}</span>
              {(onDeleteRow || columnMenuExtras) && (
                <button
                  className="ml-auto rounded px-1.5 py-0.5 text-[12px] leading-none text-[#9b9a97] hover:bg-[#ececea] hover:text-[#37352f]"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setColMenu({ x: rect.right, y: rect.bottom + 4, value, label: columnLabel })
                  }}
                  title="컬럼 메뉴"
                >
                  ⋯
                </button>
              )}
            </div>
            <div className={fillHeight ? 'min-h-0 flex-1 overflow-y-auto pr-0.5' : ''}>
            {items.map((r) => {
              const action = cardAction?.(r, value)
              const cardMeta = cardBadge?.(r, value)
              return (
              <div
                key={r.path}
                draggable={!!onMove}
                onDragStart={(e) => e.dataTransfer.setData('text/db-note', r.path)}
                className="relative mb-1.5 cursor-pointer rounded-md border border-[#e9e9e7] bg-white px-2.5 py-2 shadow-sm hover:border-[#d3d1cb]"
                onClick={() => onOpen(r.path)}
                onContextMenu={(e) => {
                  // 우클릭 → 카드 컨텍스트 메뉴 (열기·삭제)
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, row: r })
                }}
                title={r.path}
              >
                {action && (
                  <div className="absolute right-1.5 top-1.5 z-10" onClick={(e) => e.stopPropagation()}>
                    {action}
                  </div>
                )}
                <div className={`truncate text-[13px] font-medium text-[#37352f] ${action ? 'pr-14' : ''}`}>
                  {config.kind === 'scopes_board' ? '🎯' : r.icon || '📄'} {displayRowTitle(r, config)}
                </div>
                {cardMeta && (
                  <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                    {cardMeta}
                  </div>
                )}
                {r.date && <div className="mt-0.5 text-[11px] text-[#9b9a97]">{r.date}</div>}
                {dataColumns.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
                    {dataColumns.slice(0, 4).map((c) => {
                      const raw = r.props[c.key]
                      const isEmpty =
                        raw == null ||
                        raw === '' ||
                        (Array.isArray(raw) && (raw as unknown[]).length === 0)
                      if (isEmpty) return null
                      return (
                        <DbCell
                          key={c.key}
                          column={c}
                          raw={raw}
                          onOpenDocument={onOpenDocument}
                          onCommit={(v) => onCellChange(r.path, c.key, v)}
                        />
                      )
                    })}
                  </div>
                )}
                {r.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <span key={t} className="rounded-full bg-[#ececea] px-1.5 text-[10px] text-[#5f5e5b]">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              )
            })}
            </div>
            {onCreateRow && (
              <button
                className="mt-0.5 flex w-full shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] text-[#9b9a97] hover:bg-white hover:text-[#37352f]"
                onClick={() => onCreateRow(value)}
              >
                <span>+</span>
                <span>새 페이지</span>
              </button>
            )}
          </div>
        )
      })}
      {groups.length === 0 && (
        <p className="w-full px-2 py-6 text-center text-[13px] text-[#9b9a97]">노트가 없습니다</p>
      )}

      {/* 컬럼 ⋯ 메뉴 — 정리(휴지통) + 컬럼별 추가 액션(예: '실행'의 전체 실행) */}
      {colMenu &&
        (() => {
          const items = groups.find(([v]) => v === colMenu.value)?.[1] ?? []
          const extras = columnMenuExtras?.(colMenu.value, items) ?? []
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setColMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setColMenu(null)
                }}
              />
              <div
                className="fixed z-50 w-48 rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
                style={{
                  left: Math.max(8, Math.min(colMenu.x - 192, window.innerWidth - 200)),
                  top: Math.min(colMenu.y, window.innerHeight - 120),
                }}
              >
                {extras.map((item, i) => (
                  <button
                    key={i}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f1f1ef] disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => {
                      setColMenu(null)
                      item.onClick()
                    }}
                  >
                    {item.icon && <span>{item.icon}</span>}
                    {item.label}
                  </button>
                ))}
                {onDeleteRow && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#c92a2a] hover:bg-[#fdf2f2] disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={items.length === 0}
                    onClick={() => {
                      setColMenu(null)
                      void cleanupColumn(colMenu.label, items)
                    }}
                    title="휴지통(.trash)으로 이동 — 필요하면 복구 가능"
                  >
                    <span>🗑</span> 카드 모두 정리
                  </button>
                )}
              </div>
            </>
          )
        })()}

      {/* 카드 우클릭 컨텍스트 메뉴 */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-48 rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 200),
              top: Math.min(ctxMenu.y, window.innerHeight - 100),
            }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => {
                onOpen(ctxMenu.row.path)
                setCtxMenu(null)
              }}
            >
              <span>📄</span> 열기
            </button>
            {(rowMenuItems?.(ctxMenu.row) ?? []).map((item, index) => (
              <button
                key={`${item.label}-${index}`}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[#f1f1ef] ${
                  item.danger ? 'text-[#c92a2a] hover:bg-[#fdf2f2]' : 'text-[#37352f]'
                }`}
                title={item.title}
                onClick={() => {
                  setCtxMenu(null)
                  item.onClick()
                }}
              >
                {item.icon && <span>{item.icon}</span>}
                {item.label}
              </button>
            ))}
            {onDeleteRow && (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#c92a2a] hover:bg-[#fdf2f2]"
                onClick={() => {
                  void onDeleteRow(ctxMenu.row.path)
                  setCtxMenu(null)
                }}
                title="휴지통(.trash)으로 이동 — 필요하면 복구 가능"
              >
                <span>🗑</span> 삭제 (휴지통 이동)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
