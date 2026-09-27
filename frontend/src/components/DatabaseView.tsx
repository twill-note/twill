import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useAiStore } from '../aiStore'
import { dialog } from '../dialog'
import { useAppStore } from '../store'
import type { NoteRow } from '../types'
import { propKeysOf, setNoteProp } from '../dbmodel'
import {
  dbApi,
  defaultColumn,
  defaultStatusColumn,
  EMPTY_CONFIG,
  ensureOption,
  serializeValue,
  type ColumnDef,
  type DbConfig,
} from '../dbschema'
import { DbBoard, DbTable } from './dbviews'
import TaskCardPopup from './TaskCardPopup'
import TaskRunButton, { runAllTasks } from './TaskRunButton'
import { notifyWorkspaceScopesChanged, subscribeWorkspaceScopesChanged } from '../workspaceScopeEvents'
import { tr } from '../i18n'

function isAutoFollowup(row: NoteRow): boolean {
  const created = row.props.auto_created
  return row.props.origin === 'auto_followup' && (created === true || created === 'true')
}

function scopeIdFromProjectRow(row: NoteRow): string | null {
  const filename = row.path.split('/').at(-1) ?? ''
  if (!filename.endsWith('.md')) return null
  const scopeId = filename.slice(0, -3).trim()
  return scopeId || null
}

function GroupByPicker({
  candidates,
  value,
  onChange,
}: {
  candidates: Array<{ key: string; label: string }>
  value: string
  onChange: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = candidates.find((candidate) => candidate.key === value)

  return (
    <div className="relative ml-2">
      <button
        type="button"
        className="flex min-w-28 items-center justify-between gap-2 rounded-md border border-[#e3e2e0] bg-white px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={tr("보드 그룹 기준")}
      >
        <span className="truncate">{selected?.label ?? tr("그룹 속성")}</span>
        <span className={`text-[10px] text-[#9b9a97] transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && (
        <>
          <button
            className="fixed inset-0 z-10 cursor-default"
            aria-label={tr("그룹 기준 선택 닫기")}
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 min-w-40 overflow-hidden rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg" role="listbox">
            {candidates.map((candidate) => {
              const active = candidate.key === value
              return (
                <button
                  key={candidate.key}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                    active ? 'bg-[#f1f1ef] font-medium text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#f7f7f5]'
                  }`}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(candidate.key)
                    setOpen(false)
                  }}
                >
                  <span className="w-3 text-[11px]">{active ? '✓' : ''}</span>
                  {candidate.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function ProjectFilterPicker({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)

  return (
    <div className="relative ml-2">
      <button
        type="button"
        className={`flex min-w-40 max-w-64 items-center justify-between gap-2 rounded-md border px-2.5 py-1 text-[12px] ${
          value
            ? 'border-[#b8c9e8] bg-[#f5f8ff] font-medium text-[#2f5f9f]'
            : 'border-[#e3e2e0] bg-white text-[#5f5e5b] hover:bg-[#f7f7f5]'
        }`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={tr("프로젝트별 태스크 필터")}
      >
        <span className="truncate">{selected?.label ?? tr("전체 프로젝트")}</span>
        <span className={`shrink-0 text-[10px] text-[#9b9a97] transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10 cursor-default"
            aria-label={tr("프로젝트 필터 닫기")}
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute left-0 z-20 mt-1 max-h-72 min-w-full overflow-y-auto rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
            role="listbox"
            aria-label={tr("프로젝트 필터")}
          >
            {[{ value: '', label: tr("전체 프로젝트") }, ...options].map((option) => {
              const active = option.value === value
              return (
                <button
                  key={option.value || '(all)'}
                  type="button"
                  className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12px] ${
                    active ? 'bg-[#f1f1ef] font-medium text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#f7f7f5]'
                  }`}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="w-3 text-[11px]">{active ? '✓' : ''}</span>
                  {option.label}
                </button>
              )
            })}
            {options.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-[#9b9a97]">{tr("설정된 프로젝트가 없습니다.")}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 노션식 데이터베이스 전체 페이지 뷰 — 폴더 하위 노트를 테이블/보드로 표시 */
export default function DatabaseView() {
  const { dbDir, dbRowFilter, openFile, setView, tree, closeBoardView, refreshSections } = useAppStore()
  const [rows, setRows] = useState<NoteRow[]>([])
  const [config, setConfig] = useState<DbConfig>(EMPTY_CONFIG)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [mode, setMode] = useState<'table' | 'board'>('table')
  const [groupBy, setGroupBy] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [scopeRevision, setScopeRevision] = useState(0)
  const [popupPath, setPopupPath] = useState<string | null>(null)
  const popupRow = popupPath ? rows.find((r) => r.path === popupPath) ?? null : null

  useEffect(() => {
    setProjectFilter('')
  }, [dbDir])

  // 사이드바·다른 Electron 창에서 프로젝트가 생성·이름 변경되면 현재 표와 태스크
  // 보드의 프로젝트 옵션도 같은 원본으로 즉시 다시 읽는다.
  useEffect(
    () => subscribeWorkspaceScopesChanged(() => {
      setReloadKey((key) => key + 1)
      setScopeRevision((revision) => revision + 1)
    }),
    [],
  )

  useEffect(() => {
    api
      .notesDb(dbDir ?? '')
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  }, [dbDir, tree, reloadKey])

  useEffect(() => {
    dbApi
      .getConfig(dbDir ?? '')
      .then(async (c) => {
        // 태스크 보드는 scope 컬럼 옵션을 스코프 카탈로그(SCOPES DB) 에서 동적으로 재구성.
        // 카탈로그에 스코프 추가/변경 시 태스크 보드에 즉시 반영됨.
        let next = c
        if (c.kind === 'task_board') {
          try {
            const { scopes } = await api.workspaceSettings.listScopes()
            const colors = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red'] as const
            const newOptions = scopes
              .filter((s) => s.id)
              .map((s, i) => ({
                value: s.id,
                label: (s.project ? `[${s.project}] ` : '') + (s.label || s.id),
                color: colors[i % colors.length],
              }))
            const scopeCol = c.columns.find((col) => col.key === 'scope')
            const existing = scopeCol?.options ?? []
            const sameLen = existing.length === newOptions.length
            const sameContent =
              sameLen &&
              existing.every(
                (e, i) => e.value === newOptions[i].value && e.label === newOptions[i].label,
              )
            if (!sameContent) {
              next = {
                ...c,
                columns: c.columns.map((col) =>
                  col.key === 'scope' ? { ...col, options: newOptions } : col,
                ),
              }
              // 서버에도 반영 (조용히)
              dbApi.saveConfig(dbDir ?? '', next).catch(() => {})
            }
          } catch {
            /* scopes fetch 실패해도 계속 진행 */
          }
        }
        setConfig(next)
        if (next.kind === 'scopes_board') setMode('table')
        else if (next.defaultView) setMode(next.defaultView)
        if (next.boardGroupBy) setGroupBy(next.boardGroupBy)
      })
      .catch(() => {})
  }, [dbDir, scopeRevision])

  const propKeys = useMemo(() => propKeysOf(rows), [rows])
  const groupCandidates = useMemo(() => {
    const known = new Set(config.columns.filter((c) => c.type === 'select' || c.type === 'status').map((c) => c.key))
    const configured = config.columns
      .filter((c) => c.type === 'select' || c.type === 'status')
      .map((c) => ({ key: c.key, label: c.label ?? c.key }))
    // 태스크 보드는 작업 흐름과 직접 관련된 속성만 그룹으로 쓴다. 카드의 내부
    // frontmatter(실행 이력·자동 등록 출처 등)가 드롭다운에 섞이지 않게 한다.
    if (config.kind === 'task_board') {
      // 프로젝트(scope)는 컬럼 그룹이 아니라 별도 필터로 사용한다. 그래야 한 프로젝트를
      // 고른 뒤에도 보류·대기·실행·완료 상태 흐름을 한 화면에서 비교할 수 있다.
      return configured.filter((candidate) => ['status', 'type'].includes(candidate.key))
    }
    return [
      ...configured,
      ...propKeys.filter((k) => !known.has(k)).map((k) => ({ key: k, label: k })),
    ]
  }, [config.columns, config.kind, propKeys])

  useEffect(() => {
    if (mode !== 'board' || groupCandidates.length === 0) return
    if (!groupCandidates.some((candidate) => candidate.key === groupBy)) {
      setGroupBy(groupCandidates.find((candidate) => candidate.key === 'status')?.key ?? groupCandidates[0].key)
    }
  }, [mode, groupBy, groupCandidates])

  const projectOptions = useMemo(
    () => config.columns.find((column) => column.key === 'scope')?.options ?? [],
    [config.columns],
  )

  useEffect(() => {
    if (projectFilter && !projectOptions.some((option) => option.value === projectFilter)) {
      setProjectFilter('')
    }
  }, [projectFilter, projectOptions])

  const visible = useMemo(() => {
    const scopedRows = dbRowFilter?.length ? rows.filter((r) => dbRowFilter.includes(r.path)) : rows
    const projectRows = config.kind === 'task_board' && projectFilter
      ? scopedRows.filter((row) => {
          const raw = row.props.scope
          const scopeId = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '')
          return scopeId === projectFilter
        })
      : scopedRows
    const q = filter.trim().toLowerCase()
    if (!q) return projectRows
    if (config.kind === 'task_board') {
      return projectRows.filter((r) =>
        [r.title, r.props.status, r.props.type, r.props.scope, r.props.skill]
          .map((value) => (Array.isArray(value) ? value.join(' ') : String(value ?? '')))
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    }
    return projectRows.filter((r) =>
      [r.title, r.path, r.tags.join(' '), ...Object.values(r.props).map((v) => String(v ?? ''))]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [rows, filter, projectFilter, dbRowFilter, config.kind])

  // 태스크 보드는 각 컬럼에서 최신 항목이 맨 위로 — '확인 필요'에서 방금 끝난 작업을 바로 찾아 완료로 옮기기 쉽게
  const boardRows = useMemo(
    () => (config.kind === 'task_board' ? [...visible].sort((a, b) => b.updated_at - a.updated_at) : visible),
    [visible, config.kind],
  )

  const persistConfig = useCallback(
    async (next: DbConfig) => {
      setConfig(next)
      try {
        await dbApi.saveConfig(dbDir ?? '', next)
      } catch (e) {
        dialog.alert((e as Error).message)
      }
    },
    [dbDir],
  )

  const selectProjectFilter = useCallback(
    (scopeId: string) => {
      setProjectFilter(scopeId)
      if (config.kind !== 'task_board') return
      const statusGroup = config.columns.some((column) => column.key === 'status') ? 'status' : groupBy
      setMode('board')
      setGroupBy(statusGroup)
      void persistConfig({ ...config, defaultView: 'board', boardGroupBy: statusGroup || null })
    },
    [config, groupBy, persistConfig],
  )

  const onCellChange = useCallback(
    async (path: string, key: string, value: unknown) => {
      try {
        await setNoteProp(path, key, value)
        if (config.kind === 'scopes_board' && key === 'path' && typeof value === 'string') {
          const row = rows.find((candidate) => candidate.path === path)
          const scopeId = row ? scopeIdFromProjectRow(row) : null
          if (!scopeId) throw new Error('프로젝트 관리 행의 식별자를 확인할 수 없습니다.')
          // 외부 경로가 있으면 그곳에, 없으면 프로젝트별 내부 위치에 AGENTS.md를 보장한다.
          await api.workspaceSettings.ensureScopeAgents(scopeId)
          await refreshSections()
          notifyWorkspaceScopesChanged()
        }
        // select 계열이면 옵션 자동 등록
        const col = config.columns.find((c) => c.key === key)
        if (col && (col.type === 'select' || col.type === 'status') && typeof value === 'string' && value) {
          const updated = ensureOption(col, value)
          if (updated !== col) {
            await persistConfig({ ...config, columns: config.columns.map((c) => (c.key === key ? updated : c)) })
          }
        }
        setReloadKey((k) => k + 1)
      } catch (e) {
        // 경로 속성 저장은 성공하고 AGENTS.md 생성만 실패했을 수 있으므로 서버 원본을
        // 다시 읽어 표와 디스크 상태가 어긋나지 않게 한다.
        setReloadKey((k) => k + 1)
        if (config.kind === 'scopes_board' && key === 'path') {
          await refreshSections()
          notifyWorkspaceScopesChanged()
        }
        dialog.alert((e as Error).message)
      }
    },
    [config, persistConfig, refreshSections, rows],
  )

  const onColumnChange = useCallback(
    async (col: ColumnDef) => {
      const existing = config.columns.findIndex((c) => c.key === col.key)
      const columns =
        existing >= 0
          ? config.columns.map((c) => (c.key === col.key ? col : c))
          : [...config.columns, col]
      await persistConfig({ ...config, columns })
    },
    [config, persistConfig],
  )

  const onColumnDelete = useCallback(
    async (key: string) => {
      await persistConfig({ ...config, columns: config.columns.filter((c) => c.key !== key) })
    },
    [config, persistConfig],
  )

  const onColumnAdd = useCallback(async () => {
    const name = window.prompt('새 컬럼 이름 (frontmatter 키)')
    const key = (name ?? '').trim()
    if (!key) return
    if (config.columns.some((c) => c.key === key) || ['title', 'date', 'tags', 'icon', 'cover'].includes(key)) {
      dialog.alert('이미 존재하는 컬럼 이름입니다')
      return
    }
    await persistConfig({ ...config, columns: [...config.columns, defaultColumn(key, 'text')] })
  }, [config, persistConfig])

  const createRow = useCallback(
    async (groupValue?: string) => {
      try {
        // 스키마의 default 값 + (보드에서 특정 그룹 열에 추가 시) 그 그룹 값
        const initial: Record<string, unknown> = {}
        if (groupValue !== undefined && groupBy) {
          const col = config.columns.find((c) => c.key === groupBy)
          initial[groupBy] = col ? serializeValue(col, groupValue) : groupValue
        }
        const path = await dbApi.createRow(dbDir ?? '', initial, config)
        setReloadKey((k) => k + 1)
        // 태스크 보드: 풀스크린 편집기 대신 카드 팝업 — 제목·메타·설명을 보드 위에서 바로 편집
        if (config.kind === 'task_board') setPopupPath(path)
        // 프로젝트 관리는 행 노트를 직접 열지 않는다. 표에서 경로를 설정한 뒤 프로젝트
        // 이름을 눌러 실제 AGENTS.md를 여는 것이 유일한 문서 진입점이다.
        else if (config.kind !== 'scopes_board') openFile(path)
      } catch (e) {
        dialog.alert((e as Error).message)
      }
    },
    [dbDir, config, groupBy, openFile],
  )

  const moveCard = async (path: string, value: string) => {
    try {
      await setNoteProp(path, groupBy, value)
      setReloadKey((k) => k + 1)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  /** 카드 삭제 — 실제 삭제가 아니라 휴지통(.trash) 이동이라 복구 가능. */
  const deleteRow = async (path: string) => {
    try {
      await api.remove(path)
      setReloadKey((k) => k + 1)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  /** 프로젝트 관리는 일반 DB 행 삭제와 달리 연결 참조를 서버에서 한 번에 해제한다. */
  const deleteProjectScope = useCallback(
    async (row: NoteRow) => {
      const scopeId = scopeIdFromProjectRow(row)
      if (!scopeId) {
        await dialog.alert('프로젝트 관리 행의 식별자를 확인할 수 없습니다.')
        return
      }
      try {
        const preview = await api.workspaceSettings.previewScopeDeletion(scopeId)
        const impact = [
          `프로젝트: ${preview.label}`,
          `연결된 사이드바 프로젝트: ${preview.section_count}개 (목록에서 제거)`,
          `scope 해제 태스크 카드: ${preview.task_count}개 (본문·상태·실행 이력 유지)`,
          `실행 중 또는 대기 중인 관련 태스크: ${preview.active_task_count}개`,
          '',
          '프로젝트 행은 휴지통으로 이동합니다.',
          '연결 프로젝트의 폴더·노트와 외부 코드 경로는 삭제하지 않고 Root에 그대로 남습니다.',
        ].join('\n')
        if (!preview.can_delete) {
          const names = preview.blocking_tasks
            .slice(0, 4)
            .map((task) => `- ${task.title} (${task.state})`)
            .join('\n')
          await dialog.alert(`'${preview.label}' 프로젝트는 지금 삭제할 수 없습니다.`, {
            detail: `${impact}\n\n실행을 종료하거나 취소한 뒤 다시 시도하세요.${names ? `\n${names}` : ''}`,
          })
          return
        }
        const confirmed = await dialog.confirm(`'${preview.label}' 프로젝트를 삭제할까요?`, {
          detail: impact,
          confirmLabel: '프로젝트 삭제',
          danger: true,
        })
        if (!confirmed) return

        await api.workspaceSettings.deleteScope(scopeId)
        await refreshSections()
        await useAiStore.getState().loadSessions()
        notifyWorkspaceScopesChanged()
        setReloadKey((key) => key + 1)
      } catch (error) {
        await dialog.alert((error as Error).message)
      }
    },
    [refreshSections],
  )

  const renameProjectScope = useCallback(async (row: NoteRow) => {
    const current = String(row.props.label ?? row.title).trim()
    const next = await dialog.prompt('프로젝트 이름 변경', {
      defaultValue: current,
      confirmLabel: '변경',
    })
    if (!next?.trim() || next.trim() === current) return
    try {
      const scopeId = scopeIdFromProjectRow(row)
      if (!scopeId) throw new Error('프로젝트 관리 행의 식별자를 확인할 수 없습니다.')
      await api.workspaceSettings.renameScopeProject(scopeId, next.trim())
      await refreshSections()
      notifyWorkspaceScopesChanged()
      setReloadKey((key) => key + 1)
    } catch (error) {
      await dialog.alert((error as Error).message)
    }
  }, [refreshSections])

  const projectRowMenuItems = useCallback(
    (row: NoteRow) => {
      if (config.kind !== 'scopes_board' || !scopeIdFromProjectRow(row)) return []
      return [
        {
          icon: '✏️',
          label: '프로젝트 이름 변경',
          title: '표의 프로젝트 이름을 변경합니다.',
          onClick: () => void renameProjectScope(row),
        },
        {
          icon: '🗑',
          label: '프로젝트 삭제',
          danger: true,
          title: '연결 프로젝트도 목록에서 제거하며, 노트·폴더·외부 코드 경로는 삭제하지 않습니다.',
          onClick: () => void deleteProjectScope(row),
        },
      ]
    },
    [config.kind, deleteProjectScope, renameProjectScope],
  )

  // 태스크 보드 → 카드 팝업, 프로젝트 관리 → 등록 경로의 실제 AGENTS.md,
  // 그 외 일반 DB → 행 Markdown 편집기로 이동.
  const handleOpenRow = (path: string) => {
    if (config.kind === 'task_board') {
      setPopupPath(path)
      return
    }
    if (config.kind === 'scopes_board') {
      const row = rows.find((candidate) => candidate.path === path)
      const scopeId = row ? scopeIdFromProjectRow(row) : null
      if (!scopeId) {
        void dialog.alert('프로젝트 관리 행의 식별자를 확인할 수 없습니다.')
        return
      }
      void api.workspaceSettings
        .ensureScopeAgents(scopeId)
        .then((result) => openFile(result.path))
        .catch((error) => dialog.alert((error as Error).message))
      return
    }
    openFile(path)
  }

  const changeGroupBy = (key: string) => {
    setGroupBy(key)
    persistConfig({ ...config, boardGroupBy: key || null })
  }

  const changeMode = async (m: 'table' | 'board') => {
    if (config.kind === 'scopes_board') return
    setMode(m)
    let nextConfig = { ...config, defaultView: m }
    // 보드로 들어가는데 그룹 후보가 하나도 없으면 기본 status 컬럼을 자동 생성
    if (m === 'board' && groupCandidates.length === 0) {
      const statusCol = defaultStatusColumn()
      nextConfig = {
        ...nextConfig,
        columns: [...nextConfig.columns, statusCol],
        boardGroupBy: statusCol.key,
      }
      setGroupBy(statusCol.key)
    }
    await persistConfig(nextConfig)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#efefed] px-6 py-3">
        <span className="text-[18px]">📊</span>
        {config.kind === 'task_board' ? (
          <h1 className="px-1.5 py-0.5 text-[15px] font-semibold text-[#37352f]">{tr("태스크 보드")}</h1>
        ) : (
          <input
            className="min-w-[100px] flex-none rounded px-1.5 py-0.5 text-[15px] font-semibold text-[#37352f] outline-none placeholder:text-[#c8c7c4] hover:bg-[#f7f7f5] focus:bg-white focus:ring-1 focus:ring-[#d3d1cb]"
            value={config.title}
            placeholder={dbDir || tr("제목 없는 데이터베이스")}
            onChange={(e) => setConfig({ ...config, title: e.target.value })}
            onBlur={() => persistConfig(config)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        )}
        <span className="text-[12px] text-[#9b9a97]" title={dbDir || tr("전체 노트")}>
          · {visible.length}
        </span>
        {dbRowFilter?.length ? (
          <span className="rounded bg-[#f1ebff] px-1.5 py-0.5 text-[10px] text-[#6f5aa8]" title={tr("방금 자동 등록된 카드만 표시 중")}>

            {tr("자동 등록")} {visible.length}{tr("개")}
          </span>
        ) : null}
        <input
          className="ml-2 w-56 rounded-md border border-[#e3e2e0] px-2.5 py-1 text-[13px] outline-none placeholder:text-[#c8c7c4] focus:border-blue-400"
          placeholder={config.kind === 'task_board' ? tr("태스크 검색…") : tr("필터…")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {config.kind === 'task_board' && (
          <ProjectFilterPicker options={projectOptions} value={projectFilter} onChange={selectProjectFilter} />
        )}
        {config.kind !== 'scopes_board' && (
          <div className="ml-2 flex rounded-md bg-[#ececea] p-0.5 text-[12px]">
            {(['table', 'board'] as const).map((m) => (
              <button
                key={m}
                className={`rounded px-2 py-0.5 ${mode === m ? 'bg-white shadow-sm' : 'text-[#7d7c78] hover:text-[#37352f]'}`}
                onClick={() => changeMode(m)}
              >
                {m === 'table' ? tr("표") : tr("보드")}
              </button>
            ))}
          </div>
        )}
        {config.kind !== 'scopes_board' && mode === 'board' && (
          <GroupByPicker candidates={groupCandidates} value={groupBy} onChange={changeGroupBy} />
        )}
        <button
          className="ml-2 rounded-md bg-[#37352f] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#2b2925]"
          onClick={() => createRow()}
        >

          {tr("+ 새로 만들기")}
        </button>
        <button
          className="ml-auto rounded px-2 py-1 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          onClick={() => {
            // 태스크 보드·프로젝트 관리는 탭 없는 토글 뷰 — 직전 화면으로 복귀
            if (dbDir === 'tasks' || dbDir === 'scopes') closeBoardView()
            else setView('editor')
          }}
        >

          {tr("✕ 닫기")}
        </button>
      </header>

      {error ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-red-500">{error}</div>
      ) : (
        <div className={mode === 'board' && config.kind !== 'scopes_board' ? 'flex-1 overflow-hidden px-6 py-4' : 'flex-1 overflow-auto px-6 py-4'}>
          {mode === 'table' || config.kind === 'scopes_board' ? (
            <DbTable
              rows={visible}
              config={config}
              onOpen={handleOpenRow}
              onOpenDocument={openFile}
              onCellChange={onCellChange}
              onColumnChange={config.kind === 'scopes_board' ? undefined : onColumnChange}
              onColumnDelete={config.kind === 'scopes_board' ? undefined : onColumnDelete}
              onColumnAdd={config.kind === 'scopes_board' ? undefined : onColumnAdd}
              rowMenuItems={projectRowMenuItems}
              onCreateRow={() => createRow()}
              showDate={config.kind !== 'scopes_board'}
              showTags={config.kind !== 'scopes_board' && config.kind !== 'task_board'}
            />
          ) : (
            <DbBoard
              rows={boardRows}
              config={config}
              groupBy={groupBy}
              onOpen={handleOpenRow}
              onOpenDocument={openFile}
              onCellChange={onCellChange}
              onMove={moveCard}
              onCreateRow={createRow}
              // 컬럼이 길어도 페이지가 세로로 늘어나지 않게 — 컬럼 내부 스크롤 + 가로 스크롤바 상시 노출
              fillHeight
              // 프로젝트 관리는 일반 DB 행 삭제 대신 서버 전용 참조 정리 삭제만 제공한다.
              onDeleteRow={config.kind === 'scopes_board' ? undefined : deleteRow}
              rowMenuItems={projectRowMenuItems}
              // 컬럼 ⋯ 메뉴: '실행' 컬럼에서 카드들을 순서대로 전체 실행한다.
              columnMenuExtras={
                config.kind === 'task_board' && groupBy === 'status'
                  ? (groupValue, items) =>
                      groupValue === 'running'
                        ? [
                            {
                              icon: '▶▶',
                              label: tr("전체 실행"),
                              disabled: items.length === 0,
                              title: tr("컬럼의 카드들을 위에서부터 순서대로 차례로 실행"),
                              onClick: () => {
                                void runAllTasks(items).then(() => setReloadKey((k) => k + 1))
                              },
                            },
                          ]
                        : []
                  : undefined
              }
              // 태스크 보드: '실행 중' 컬럼으로 옮긴 카드에 ▶ 실행 버튼 노출.
              // 카드마다 벼리 세션이 하나씩 생성되어 병렬 실행됨 (상한/스코프 직렬화는 aiStore 가 관리).
              cardAction={
                config.kind === 'task_board' && groupBy === 'status'
                  ? (row, groupValue) =>
                      groupValue === 'running' ? (
                        <TaskRunButton row={row} onStarted={() => setReloadKey((k) => k + 1)} />
                      ) : null
                  : undefined
              }
              cardBadge={
                config.kind === 'task_board'
                  ? (row) =>
                      isAutoFollowup(row) ? (
                        <span
                          className="rounded-full bg-[#faf0ff] px-1.5 py-0.5 text-[10px] font-medium text-[#8a3fa0]"
                          title={tr("이전 버전에서 AI가 자동 등록한 후속 업무입니다.")}
                        >

                          {tr("🤖 기존 자동 후속")}
                        </span>
                      ) : null
                  : undefined
              }
            />
          )}
        </div>
      )}
      {popupRow && (
        <TaskCardPopup
          row={popupRow}
          config={config}
          onClose={() => setPopupPath(null)}
          onCellChange={onCellChange}
          onRowUpdated={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  )
}
