import { useState } from 'react'
import { useAiStore } from '../aiStore'
import { SYSTEM_AI_TAB, useAppStore } from '../store'
import type { NoteRow } from '../types'

/**
 * 태스크 보드 '실행 중' 컬럼 카드 우측 상단의 ▶ 실행 버튼.
 *
 * 카드에 세팅된 값(스코프·모델·강도·시간 한도)대로 Twill AI 세션(탭)을 만들어 실행한다.
 * 카드마다 독립 세션이므로 여러 카드를 병렬 실행 가능 — 단 aiStore 의 동시 실행 상한과
 * 같은 프로젝트(스코프) 직렬화 정책에 걸리면 ⏳ 대기 상태로 표시되고 자리가 나면 자동 시작.
 */
export default function TaskRunButton({ row, onStarted }: { row: NoteRow; onStarted?: () => void }) {
  const [startError, setStartError] = useState<string | null>(null)
  const openRightTab = useAppStore((s) => s.openRightTab)
  const runTask = useAiStore((s) => s.runTask)
  const selectSession = useAiStore((s) => s.selectSession)
  const sourceSessionId =
    typeof row.props.source_session === 'string' && row.props.source_session.trim()
      ? row.props.source_session.trim()
      : null
  const sourceSession = useAiStore((s) =>
    sourceSessionId ? s.sessions.find((candidate) => candidate.id === sourceSessionId && candidate.kind === 'chat') : undefined,
  )
  const session = useAiStore((s) =>
    s.sessions.find(
      (candidate) =>
        (candidate.taskPath === row.path || candidate.activeTaskPath === row.path) &&
        (candidate.busy || candidate.queued),
    ),
  )

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (session) {
      // 이미 실행/대기 중 → 해당 세션 탭으로 포커스만 이동
      selectSession(session.id)
      openRightTab(SYSTEM_AI_TAB)
      return
    }
    if (sourceSession?.busy || sourceSession?.queued) {
      selectSession(sourceSession.id)
      openRightTab(SYSTEM_AI_TAB)
      return
    }
    setStartError(null)
    const sessionId = await runTask({
      taskPath: row.path,
      title: row.title || row.path,
      scopeId: (row.props.scope as string) || undefined,
      sectionId: (row.props.section_id as string) || undefined,
      model: (row.props.model as string) || undefined,
      effort: (row.props.effort as string) || undefined,
      maxTimeSec:
        typeof row.props.max_time_min === 'number' ? (row.props.max_time_min as number) * 60 : undefined,
      sourceSessionId: sourceSessionId ?? undefined,
      onError: setStartError,
    })
    if (sessionId) {
      useAppStore.getState().openAiSession(sessionId)
      onStarted?.()
    }
  }

  if (session?.busy) {
    return (
      <button
        className="flex items-center gap-1 rounded border border-[#d5e6ff] bg-[#f0f7ff] px-1.5 py-0.5 text-[10px] text-[#2f6fd0]"
        onClick={onClick}
        title="실행 중 — 클릭하면 Twill AI 세션 탭으로 이동"
      >
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#4a9eff]" />
        실행 중
      </button>
    )
  }
  if (session?.queued) {
    return (
      <button
        // 텍스트는 진한 앰버(#8a6817) + font-medium — 연한 #a67c1b 이 일부 테마에서 배경에 묻히던 문제 수정.
        // (#8a6817·#f4dfab·#fdf8ea 는 테마 생성기에서 전부 매핑되는 토큰이라 다크에서도 대비 유지)
        className="flex items-center gap-1 rounded border border-[#f4dfab] bg-[#fdf8ea] px-1.5 py-0.5 text-[10px] font-medium text-[#8a6817]"
        onClick={onClick}
        title="대기 중 — 실행 슬롯/같은 프로젝트 실행이 끝나면 자동 시작"
      >
        ⏳ 대기
      </button>
    )
  }
  if (sourceSession?.busy || sourceSession?.queued) {
    return (
      <button
        className="rounded border border-[#d5e6ff] bg-[#f0f7ff] px-1.5 py-0.5 text-[10px] text-[#2f6fd0]"
        onClick={onClick}
        title="원본 대화가 다른 요청을 처리 중입니다. 클릭하면 해당 대화로 이동합니다."
      >
        💬 대화 중
      </button>
    )
  }
  return (
    <div className="flex max-w-[220px] flex-col items-end gap-1">
      <button
        className="rounded border border-[#e3e2e0] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#37352f] shadow-sm hover:bg-[#37352f] hover:text-white"
        onClick={onClick}
        title={
          sourceSession
            ? '이 태스크를 등록한 원본 대화에서 이어서 실행'
            : '카드에 세팅된 값대로 Twill AI 세션을 만들어 실행'
        }
      >
        {sourceSession ? '▶ 이어서 실행' : '▶ 실행'}
      </button>
      {startError && (
        <span className="text-right text-[10px] leading-snug text-[#c92a2a]" role="alert">
          {startError}
        </span>
      )}
    </div>
  )
}

/**
 * '실행' 컬럼 전체 실행 — Twill AI 패널에 "계획 세션"을 열어 카드 내용 검토·순서 판단 과정을
 * 그대로 보여주고, 결론(제안 순서)을 패널 안에서 사용자가 확정하면 그때 차례로 실행한다.
 * (카드가 1장이면 판단 없이 바로 실행. 동시 실행 상한/스코프 직렬화는 대기열이 처리.)
 */
export async function runAllTasks(rows: NoteRow[]): Promise<void> {
  if (rows.length === 0) return
  const store = useAiStore.getState()

  if (rows.length === 1) {
    const row = rows[0]
    const id = await store.runTask({
      taskPath: row.path,
      title: row.title || row.path,
      scopeId: (row.props.scope as string) || undefined,
      sectionId: (row.props.section_id as string) || undefined,
      model: (row.props.model as string) || undefined,
      effort: (row.props.effort as string) || undefined,
      maxTimeSec:
        typeof row.props.max_time_min === 'number' ? (row.props.max_time_min as number) * 60 : undefined,
    })
    if (id) useAppStore.getState().openAiSession(id)
    return
  }

  // 계획 세션 시작 — 판단 과정은 벼리 패널에서 스트리밍되고,
  // 완료되면 "제안 순서 + ▶ 이 순서로 실행" 확정 카드가 세션 안에 표시된다.
  const id = await store.startRunOrderPlan(rows)
  if (id) useAppStore.getState().openAiSession(id)
}
