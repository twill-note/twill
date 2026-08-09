/**
 * 데이터베이스 컬럼 스키마 (셀 타입 · 옵션 · 뷰 설정).
 *
 * 각 DB 폴더의 `.db.json` 에 저장되며, `/api/db/config` 로 조회/저장.
 */
import { api } from './api'

export type CellType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'path'  // 파일 시스템 경로 - 편집 시 폴더 피커 팝업

/** Notion 팔레트 — 프리셋 색 이름. */
export const SELECT_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const
export type SelectColor = (typeof SELECT_COLORS)[number]

export interface SelectOption {
  value: string
  label: string
  color: SelectColor
}

export interface ColumnDef {
  key: string
  label: string | null
  type: CellType
  options: SelectOption[]
  visible: boolean
}

export interface SortSpec {
  key: string
  dir: 'asc' | 'desc'
}

export interface DbConfig {
  title: string
  kind: string   // "task_board" 등. 특수 UI 라우팅.
  columns: ColumnDef[]
  primarySort: SortSpec | null
  defaultView: 'table' | 'board'
  boardGroupBy: string | null
}

export const EMPTY_CONFIG: DbConfig = {
  title: '',
  kind: '',
  columns: [],
  primarySort: null,
  defaultView: 'table',
  boardGroupBy: null,
}

export function defaultColumn(key: string, type: CellType = 'text'): ColumnDef {
  return { key, label: null, type, options: [], visible: true }
}

/** 보드 뷰의 그룹 기준으로 쓸 select 컬럼이 스키마에 하나도 없을 때 자동 생성하는 기본값. */
export function defaultStatusColumn(): ColumnDef {
  return {
    key: 'status',
    label: '상태',
    type: 'status',
    options: [
      { value: 'todo', label: '할 일', color: 'gray' },
      { value: 'doing', label: '진행 중', color: 'blue' },
      { value: 'done', label: '완료', color: 'green' },
    ],
    visible: true,
  }
}

/** Tailwind 클래스로 매핑. select/status/multi_select 뱃지에 사용. */
export function badgeClasses(color: SelectColor): { bg: string; text: string; border: string } {
  const map: Record<SelectColor, { bg: string; text: string; border: string }> = {
    default: { bg: 'bg-[#ececea]', text: 'text-[#5f5e5b]', border: 'border-[#e3e2e0]' },
    gray: { bg: 'bg-[#e3e2e0]', text: 'text-[#5f5e5b]', border: 'border-[#d3d1cb]' },
    brown: { bg: 'bg-[#eee0d6]', text: 'text-[#8a5a3b]', border: 'border-[#d9c1ae]' },
    orange: { bg: 'bg-[#faebdd]', text: 'text-[#b34d15]', border: 'border-[#f2d3ac]' },
    yellow: { bg: 'bg-[#fbf3db]', text: 'text-[#a67c1b]', border: 'border-[#f0dfa6]' },
    green: { bg: 'bg-[#dbeddb]', text: 'text-[#217a3f]', border: 'border-[#b6dab6]' },
    blue: { bg: 'bg-[#dbeaf4]', text: 'text-[#1f6fb2]', border: 'border-[#b7d4e8]' },
    purple: { bg: 'bg-[#eae4f2]', text: 'text-[#7c56b7]', border: 'border-[#d1c1e8]' },
    pink: { bg: 'bg-[#f4dfeb]', text: 'text-[#c94b8c]', border: 'border-[#eec1da]' },
    red: { bg: 'bg-[#fbe4e4]', text: 'text-[#c92a2a]', border: 'border-[#efbebe]' },
  }
  return map[color] ?? map.default
}

export function findOption(col: ColumnDef, value: string): SelectOption | null {
  return col.options.find((o) => o.value === value) ?? null
}

/**
 * 스키마와 원시 값(row.props[key]) 을 근거로 화면에 표현할 정규화된 값을 반환.
 * - select/status: string (option value) or ''
 * - multi_select: string[] (option values)
 * - date: 'YYYY-MM-DD' or ''
 * - checkbox: boolean
 * - number: number | null
 * - text/url: string
 */
export function normalizeValue(col: ColumnDef, raw: unknown): unknown {
  switch (col.type) {
    case 'multi_select':
      if (Array.isArray(raw)) return raw.map(String)
      if (typeof raw === 'string' && raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
      return []
    case 'checkbox':
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'string') return raw.toLowerCase() === 'true' || raw === '1' || raw === 'yes'
      return false
    case 'number': {
      if (typeof raw === 'number') return raw
      if (typeof raw === 'string' && raw.trim()) {
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
      }
      return null
    }
    case 'date':
      if (typeof raw === 'string') return raw.slice(0, 10)
      return ''
    case 'select':
    case 'status':
    case 'text':
    case 'url':
    case 'path':
    default:
      if (raw == null) return ''
      if (Array.isArray(raw)) return raw.join(', ')
      return String(raw)
  }
}

/** normalizeValue 의 역 — 저장 시 frontmatter 에 넣을 형태로 변환. */
export function serializeValue(col: ColumnDef, val: unknown): unknown {
  switch (col.type) {
    case 'multi_select':
      return Array.isArray(val) ? val.filter((v) => typeof v === 'string' && v) : []
    case 'checkbox':
      return !!val
    case 'number':
      return typeof val === 'number' && Number.isFinite(val) ? val : null
    case 'date':
      return typeof val === 'string' && val ? val : ''
    default:
      return typeof val === 'string' ? val : val == null ? '' : String(val)
  }
}

/** 옵션이 하나도 없을 때 새 select 값이 들어오면 자동으로 옵션에 추가. */
export function ensureOption(col: ColumnDef, value: string): ColumnDef {
  if (!value || col.options.some((o) => o.value === value)) return col
  const colors: SelectColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red']
  const color = colors[col.options.length % colors.length]
  return { ...col, options: [...col.options, { value, label: value, color }] }
}

// ─────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────
function coerceConfig(raw: unknown): DbConfig {
  if (!raw || typeof raw !== 'object') return EMPTY_CONFIG
  const o = raw as Partial<DbConfig>
  const baseTitle = typeof o.title === 'string' ? o.title : ''
  const baseKind = typeof o.kind === 'string' ? o.kind : ''
  if (!Array.isArray(o.columns)) return { ...EMPTY_CONFIG, title: baseTitle, kind: baseKind }
  return {
    title: baseTitle,
    kind: baseKind,
    columns: o.columns.map((c) => ({
      key: String(c.key ?? ''),
      label: c.label ?? null,
      type: (c.type ?? 'text') as ColumnDef['type'],
      options: Array.isArray(c.options) ? c.options : [],
      visible: c.visible !== false,
    })),
    primarySort: o.primarySort ?? null,
    defaultView: o.defaultView ?? 'table',
    boardGroupBy: o.boardGroupBy ?? null,
  }
}

export const dbApi = {
  getConfig: async (dir: string): Promise<DbConfig> => {
    try {
      const r = await fetch(`/api/db/config?dir=${encodeURIComponent(dir)}`)
      if (!r.ok) return EMPTY_CONFIG
      const raw = await r.json()
      return coerceConfig(raw)
    } catch {
      return EMPTY_CONFIG
    }
  },
  ensureTaskBoard: async (dir = 'tasks'): Promise<{ dir: string; created: boolean }> => {
    const r = await fetch('/api/db/ensure-task-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    if (!r.ok) throw new Error(`태스크 보드 생성 실패 (${r.status})`)
    return r.json()
  },
  ensureScopesBoard: async (dir = 'scopes'): Promise<{ dir: string; created: boolean }> => {
    const r = await fetch('/api/db/ensure-scopes-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    if (!r.ok) throw new Error(`프로젝트 관리 생성 실패 (${r.status})`)
    return r.json()
  },
  saveConfig: async (dir: string, config: DbConfig): Promise<DbConfig> => {
    const r = await fetch('/api/db/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, config }),
    })
    if (!r.ok) throw new Error(`DB config 저장 실패 (${r.status})`)
    const raw = await r.json()
    return coerceConfig(raw)
  },
  /** 새 노트(행) 생성. `dir` 아래에 자동 이름 부여.
   *  DB 폴더로 식별되도록 (`.db.json` 존재 → 트리에서 자식 감춤) config 를 먼저 확실히 저장한다.
   */
  createRow: async (
    dir: string,
    initialProps: Record<string, unknown> = {},
    currentConfig?: DbConfig,
  ): Promise<string> => {
    // 설정이 로드되기 전의 EMPTY_CONFIG를 저장하면 기존 태스크 보드 스키마가 사라진다.
    // 유효한 스키마를 이미 받은 경우에만 행 생성 전 저장한다.
    if (dir && currentConfig && (currentConfig.kind || currentConfig.columns.length > 0)) {
      try {
        await fetch('/api/db/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir, config: currentConfig ?? EMPTY_CONFIG }),
        })
      } catch {
        /* .db.json 저장 실패해도 행 생성은 계속 시도 */
      }
    }
    const stamp = Date.now().toString(36)
    const name = `무제-${stamp}`
    const path = dir ? `${dir}/${name}` : name
    const { path: created } = await api.createEntry(path, 'file')
    if (Object.keys(initialProps).length > 0) {
      const c = await api.getContent(created)
      const extra = { ...(c.frontmatter.extra ?? {}), ...initialProps }
      await api.saveContent(created, { ...c.frontmatter, extra }, c.body, c.mtime)
    }
    return created
  },
}
