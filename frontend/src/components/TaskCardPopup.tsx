import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { type AiSession, useAiStore } from '../aiStore'
import { type ColumnDef, type DbConfig } from '../dbschema'
import { SYSTEM_AI_TAB, useAppStore } from '../store'
import { TASK_PROJECT_CHANGED_MESSAGE, taskSessionAction } from '../taskExecutionScope'
import type { FileContent, NoteRow } from '../types'
import DbCell from './DbCell'
import NoteBodyEditor, { type NoteBodySaveStatus } from './NoteBodyEditor'
import SpellcheckToggleButton from './SpellcheckToggleButton'
import { useBackdropDismiss } from '../useBackdropDismiss'

interface Props {
  row: NoteRow
  config: DbConfig
  onClose: () => void
  onCellChange: (path: string, key: string, value: unknown) => void | Promise<void>
  onRowUpdated: () => void  // 실행 시작 후 status 전이됐음을 부모에게 알림
}

/** 팝업 메타 영역에 가로로 배치할 필드 순서. */
const META_KEYS = ['status', 'type', 'scope'] as const

function taskSessionForPath(session: AiSession, taskPath: string): boolean {
  return (
    session.taskPath === taskPath ||
    session.activeTaskPath === taskPath ||
    session.lastRun?.task_path === taskPath ||
    session.sourceTaskStatus?.path === taskPath ||
    session.sourceTask?.path === taskPath ||
    session.sourceTask?.last_path === taskPath
  )
}

/**
 * 태스크 보드 카드 팝업.
 * 카드 메타 편집 + 설명(본문) 마크다운 편집 + 작업 수행 트리거.
 *
 * · 메타 필드는 세로 나열 대신 가로 그리드 — 세로 공간을 설명에 양보.
 * · 설명은 plain text 미리보기가 아니라 본편집기와 동일한 BlockNote 마크다운 에디터
 *   (미리보기 = 편집) — 표/보드 뷰로 나가지 않고 팝업 안에서 바로 수정.
 * · 실행은 aiStore.runTask — 카드 하나당 벼리 세션(탭) 하나가 생성되고,
 *   개별 작업은 즉시 시작하며, 사용자가 확정한 배치의 선행 순서만 기다린다.
 */
export default function TaskCardPopup({ row, config, onClose, onCellChange, onRowUpdated }: Props) {
  const openFile = useAppStore((s) => s.openFile)
  const openRightTab = useAppStore((s) => s.openRightTab)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [spellcheck, setSpellcheck] = useState(false)
  const [bodySaveStatus, setBodySaveStatus] = useState<NoteBodySaveStatus>('idle')
  const [openingWork, setOpeningWork] = useState(false)
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose, row.path)
  const runTask = useAiStore((s) => s.runTask)
  const loadSessions = useAiStore((s) => s.loadSessions)
  const selectSession = useAiStore((s) => s.selectSession)
  const sourceSessionId =
    typeof row.props.source_session === 'string' && row.props.source_session.trim()
      ? row.props.source_session.trim()
      : null
  const sourceSession = useAiStore((s) =>
    sourceSessionId ? s.sessions.find((session) => session.id === sourceSessionId && session.kind === 'chat') : undefined,
  )
  // 실행 중 여부와 관계없이 카드에 이미 연결된 세션이 있으면 새 채팅을 만들지 않는다.
  const taskSession = useAiStore((s) => s.sessions.find((session) => taskSessionForPath(session, row.path)))
  const directCardScopeId =
    typeof row.props.scope === 'string' && row.props.scope.trim() ? row.props.scope.trim() : null
  const cardScopeId =
    taskSession?.sourceTaskStatus?.state === 'available'
      ? (taskSession.sourceTaskStatus.scope_id ?? null)
      : directCardScopeId ?? taskSession?.scopeId ?? null
  const currentSessionAction = taskSessionAction(
    taskSession ?? null,
    cardScopeId,
    Boolean(taskSession?.sourceTaskStatus?.scope_mismatch),
  )
  const scopeMismatch = Boolean(
    taskSession && (
      taskSession.sourceTaskStatus?.scope_mismatch ||
      taskSession.scopeId !== cardScopeId
    ),
  )

  useEffect(() => {
    api
      .getContent(row.path)
      .then(setContent)
      .catch((e) => setError((e as Error).message))
  }, [row.path])

  useEffect(() => {
    // 카드 프로젝트 편집 직후에도 서버가 계산한 세션 불일치 상태를 팝업에 반영한다.
    void loadSessions()
  }, [loadSessions, row.path, row.props.scope, row.props.section_id])

  const columnMap = useMemo(() => {
    const m: Record<string, ColumnDef> = {}
    for (const c of config.columns) m[c.key] = c
    return m
  }, [config])

  // 라벨만으로는 뭘 하는 값인지 안 보이는 필드에 붙이는 설명 (호버 시 표시)
  const FIELD_HINTS: Record<string, string> = {
    scope: '이 태스크를 어느 프로젝트(코드베이스) 안에서 실행할지. 프로젝트 관리에 등록된 항목 중에서 고릅니다.',
  }

  const runWithByeori = async () => {
    if (openingWork) return
    setError(null)
    setOpeningWork(true)
    try {
      // 분리 창이나 다른 렌더러에서 열린 세션도 놓치지 않도록 서버 목록을 먼저 동기화한다.
      await loadSessions()
      const sessions = useAiStore.getState().sessions
      const existing = sessions.find((session) => taskSessionForPath(session, row.path))
      const latestCardScopeId =
        existing?.sourceTaskStatus?.state === 'available'
          ? (existing.sourceTaskStatus.scope_id ?? null)
          : directCardScopeId ?? existing?.scopeId ?? null
      const existingAction = taskSessionAction(
        existing ?? null,
        latestCardScopeId,
        Boolean(existing?.sourceTaskStatus?.scope_mismatch),
      )
      if (existing && existingAction !== 'start-changed-project') {
        selectSession(existing.id)
        openRightTab(SYSTEM_AI_TAB)
        onClose()
        return
      }

      // 원본 대화가 다른 요청을 처리 중이면 thread를 분기하지 않고 해당 대화만 보여준다.
      let origin = sourceSessionId
        ? sessions.find((session) => session.id === sourceSessionId && session.kind === 'chat')
        : undefined
      if (sourceSessionId && !origin) {
        await loadSessions()
        origin = useAiStore.getState().sessions.find(
          (session) => session.id === sourceSessionId && session.kind === 'chat',
        )
      }
      if (origin?.busy || origin?.queued) {
        selectSession(origin.id)
        openRightTab(SYSTEM_AI_TAB)
        onClose()
        return
      }

      let startError = ''
      const sessionId = await runTask({
        taskPath: row.path,
        title: row.title || row.path,
        scopeId: (row.props.scope as string) || undefined,
        sectionId: (row.props.section_id as string) || undefined,
        model: (row.props.model as string) || undefined,
        effort: (row.props.effort as string) || undefined,
        maxTimeSec:
          typeof row.props.max_time_min === 'number' ? (row.props.max_time_min as number) * 60 : undefined,
        sourceSessionId: existingAction === 'start-changed-project' ? undefined : sourceSessionId ?? undefined,
        forceNewSession: existingAction === 'start-changed-project',
        onError: (message) => {
          startError = message
          setError(message)
        },
      })
      if (!sessionId) {
        if (!startError) setError('세션을 만들 수 없습니다. 백엔드 연결을 확인하세요.')
        return
      }
      useAppStore.getState().openAiSession(sessionId)
      onRowUpdated()
      onClose()
    } finally {
      setOpeningWork(false)
    }
  }

  /** 제목 저장 — 최신 frontmatter 를 다시 읽어 title 만 교체 (병행 수정 보존). */
  const saveTitle = async (raw: string) => {
    const title = raw.trim()
    if (!title || title === row.title) return
    try {
      const latest = await api.getContent(row.path)
      await api.saveContent(row.path, { ...latest.frontmatter, title }, latest.body, latest.mtime)
      onRowUpdated()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const openInMarkdownEditor = () => {
    onClose()
    openFile(row.path)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[6vh]"
      onClick={dismissFromBackdrop}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-[880px] max-w-[95vw] flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${row.title || '태스크'} 편집`}
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-start gap-2 border-b border-[#e9e9e7] px-6 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-[#9b9a97]">태스크</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-[20px]">{row.icon || '📄'}</span>
              {/* 제목 인라인 편집 — 보드에서 + 로 만든 '무제' 카드를 팝업 안에서 바로 명명 */}
              <input
                className="min-w-0 flex-1 rounded px-1 py-0.5 text-[16px] font-semibold text-[#37352f] outline-none placeholder:text-[#c8c7c4] hover:bg-[#f7f7f5] focus:bg-[#f7f7f5]"
                defaultValue={row.title}
                placeholder="태스크 제목"
                title={row.path}
                onBlur={(e) => void saveTitle(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded p-1.5 text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]"
              onClick={openInMarkdownEditor}
              title="마크다운 편집기에서 열기"
              aria-label="마크다운 편집기에서 열기"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M6 2.5H2.5V6M10 13.5h3.5V10M2.5 6l4-4M13.5 10l-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="rounded px-2 py-0.5 text-[13px] text-[#9b9a97] hover:bg-[#efefed]"
              onClick={onClose}
              title="닫기"
              aria-label="태스크 편집 닫기"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 메타 — 가로 그리드. 표/보드 뷰와 동일한 편집기(DbCell) 라서 바로 값을 바꿀 수 있음 */}
        <div className="shrink-0 border-b border-[#e9e9e7] px-6 py-3">
          <div className="grid grid-cols-3 gap-x-5 gap-y-2.5 lg:grid-cols-5">
            {META_KEYS.map((key) => {
              const col = columnMap[key]
              if (!col) return null
              return (
                <div key={key} className="min-w-0">
                  <div className="mb-1 text-[11px] text-[#9b9a97]" title={FIELD_HINTS[key]}>
                    {col.label ?? key}
                  </div>
                  <DbCell column={col} raw={row.props[key]} onCommit={(v) => onCellChange(row.path, key, v)} />
                </div>
              )
            })}
          </div>
        </div>

        {/* 설명 — 본편집기와 동일한 마크다운 미리보기+편집 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-[#9b9a97]">설명</span>
            <div className="flex shrink-0 items-center gap-3">
              {bodySaveStatus !== 'idle' && (
                <span
                  className={`whitespace-nowrap text-[10px] ${
                    bodySaveStatus === 'error'
                      ? 'text-red-500'
                      : bodySaveStatus === 'saved'
                        ? 'text-green-600'
                        : 'text-[#9b9a97]'
                  }`}
                >
                  {bodySaveStatus === 'saving'
                    ? '저장 중…'
                    : bodySaveStatus === 'saved'
                      ? '저장됨 ✓'
                      : '저장 실패'}
                </span>
              )}
              <SpellcheckToggleButton
                enabled={spellcheck}
                onToggle={() => setSpellcheck((value) => !value)}
              />
            </div>
          </div>
          {content ? (
            <NoteBodyEditor
              key={content.path}
              content={content}
              spellCheck={spellcheck}
              onSaveStatusChange={setBodySaveStatus}
            />
          ) : error ? (
            <p className="text-[12px] text-[#c92a2a]">{error}</p>
          ) : (
            <p className="text-[12px] text-[#9b9a97]">로드 중…</p>
          )}
        </div>

        {error && content && (
          <div className="shrink-0 border-t border-[#e9e9e7] bg-[#fdf2f2] px-6 py-2 text-[12px] text-[#c92a2a]">
            {error}
          </div>
        )}

        {scopeMismatch && (
          <div className="shrink-0 border-t border-[#f4dfab] bg-[#fff9eb] px-6 py-2 text-[12px] text-[#8a6817]" role="alert">
            <div className="font-medium">프로젝트가 변경되었습니다</div>
            <div className="mt-0.5 text-[11px]">
              {TASK_PROJECT_CHANGED_MESSAGE}{' '}
              {taskSession?.busy || taskSession?.queued
                ? '현재 실행이 끝나거나 보류된 뒤 새 실행을 시작할 수 있습니다.'
                : '아래에서 변경된 프로젝트로 새 실행을 시작해주세요.'}
            </div>
          </div>
        )}

        {/* 액션 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#e9e9e7] px-6 py-3">
          <div className="truncate text-[10px] text-[#9b9a97]" title={row.path}>
            {taskSession
              ? `연결된 작업: ${taskSession.title}`
              : sourceSession
              ? `연결된 대화: ${sourceSession.title}`
              : sourceSessionId
                ? '연결된 원본 대화를 찾을 수 없어 새 세션에서 실행합니다.'
                : row.path}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="rounded-md bg-[#37352f] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#2b2925] disabled:opacity-60"
              onClick={() => void runWithByeori()}
              disabled={openingWork}
              title={
                currentSessionAction === 'start-changed-project'
                  ? '기존 세션을 재사용하지 않고 카드의 최신 프로젝트 권한으로 새 실행을 시작합니다.'
                  : taskSession
                  ? '이미 연결된 작업 채팅을 엽니다. 새 채팅은 만들지 않습니다.'
                  : '이 태스크의 작업을 시작하고 우측 작업 채팅에서 진행 상황을 보여줍니다.'
              }
            >
              {openingWork
                ? '여는 중…'
                : currentSessionAction === 'start-changed-project'
                  ? '변경된 프로젝트로 새 실행'
                  : '작업 수행'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
