import { createStreamBatcher } from './streamBatcher'
/**
 * 벼리(AI) 다중 세션 전역 상태 — 구 runStore(단일 실행)를 대체.
 *
 * 세션 하나 = 벼리 패널의 탭 하나. 챗 세션과 태스크 실행 세션이 같은 구조를 공유하며,
 * 세션마다 독립 WebSocket(/api/ai/run)으로 오케스트레이터 이벤트를 스트리밍한다.
 *
 * 동시 실행 정책 (태스크 세션):
 *  · 개별 작업은 프로젝트와 실행 개수에 관계없이 즉시 시작
 *  · 사용자가 확정한 전체 실행 배치의 선행 순서만 유지
 *  · 챗 세션은 대화형이라 대기열을 거치지 않고 즉시 시작
 */
import { create } from 'zustand'
import { api, type AiSessionMeta, type AiSessionLastRun, type AiTaskSource, type AiTaskSourceStatus } from './api'
import { SYSTEM_AI_TAB, useAppStore } from './store'
import { setNoteProp } from './dbmodel'
import { resolveTaskExecutionScope } from './taskExecutionScope'
import { canStartTask } from './taskQueue'
import type { NoteRow } from './types'
import { currentLanguage } from './i18n'

/** 전체 실행 순서 계획 세션 → 대상 카드들 (확정 시 이 순서 정보로 runTask). 런타임 전용. */
const orderPlanRows = new Map<string, NoteRow[]>()

/** 세션 생성 요청이 끝나기 전 같은 카드를 다시 실행하는 경쟁 상태를 막는다. */
const startingTaskPaths = new Set<string>()

/**
 * 채팅·태스크의 실제 실행 여부는 서버 active_run이 최종 권위다. 아래
 * localStorage에는 브라우저가 이어서 시작해야 하는 태스크 대기열 요청만 보관하고,
 * 세션 id가 서버에 더 이상 없으면 loadSessions에서 즉시 버린다.
 */
const TASK_RUNTIME_STORAGE_KEY = 'note-ai-task-runtime-v1'

/** 계획 세션의 최종 답변에서 {"order": [...], "reason": ...} JSON 을 추출. */
function parseRunOrderJson(text: string): { order: string[]; reason: string } | null {
  const matches = text.match(/\{\s*"order"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/g)
  if (!matches) return null
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(matches[i])
      if (Array.isArray(data.order)) {
        return { order: data.order.map(String), reason: String(data.reason ?? '') }
      }
    } catch {
      /* 다음 후보 */
    }
  }
  return null
}

export type RunEvent = {
  type: string
  [key: string]: unknown
}

export type ChatImage = {
  url: string
  name?: string
  alt?: string
}

export type AiMessage = {
  role: 'user' | 'assistant' | 'reasoning' | 'tool'
  content: string
  /** 사용자 첨부 또는 AI 생성 이미지. 바이트는 assets에 있고 대화에는 URL만 둔다. */
  images?: ChatImage[]
  itemId?: string
  streaming?: boolean
  /** 실행 중 보낸 추가 지시의 전달 상태. 일반 대화 메시지는 지정하지 않는다. */
  delivery?: 'pending' | 'accepted' | 'failed'
  /** 도구 메시지에만 존재하는 인라인 실행 상태와 출력. */
  toolState?: 'running' | 'done' | 'error' | 'cancelled'
  toolType?: 'command' | 'file_change' | 'dynamic' | 'other'
  toolOutput?: string
  exitCode?: number | null
}

export type RunRequestParams = {
  session_id?: string
  task_path?: string
  prompt?: string
  scope_id?: string
  section_id?: string
  skills?: string[]
  model?: string
  effort?: string
  max_time_sec?: number
  current_path?: string
  context?: string
  /** 선택 영역의 명시적 액션으로만 true. 일반 채팅은 현재 문서를 자동 첨부하지 않는다. */
  include_document?: boolean
  /** `@`로 고른 노트 경로. 서버는 이 목록에 한해서 본문을 컨텍스트로 확장한다. */
  mention_paths?: string[]
  /** 세션 히스토리에 남길 사용자 메시지 표시문 — 실제 프롬프트가 내부용으로 길 때 (예: 순서 계획). */
  display_prompt?: string
  /** 첨부 이미지 — 업로드된 에셋 URL (/assets/<name>). 서버가 디스크 경로로 변환해 엔진에 전달. */
  images?: string[]
  /** 말풍선과 세션 복원에 쓸 이미지 URL·원본 파일명. */
  image_attachments?: ChatImage[]
  /** 이미지가 아닌 첨부 파일 — 디스크 경로 참조로 전달되어 벼리가 직접 열어본다. */
  files?: Array<{ url: string; name: string }>
  /** 같은 질문을 다시 보내는 경우. 서버 세션 히스토리에 사용자 메시지를 중복 저장하지 않는다. */
  retry?: boolean
}

type PersistedTaskRuntime = {
  mode: 'running' | 'queued'
  request: RunRequestParams
  runId?: string | null
  savedAt: number
}

function readPersistedTaskRuntime(): Record<string, PersistedTaskRuntime> {
  try {
    const raw = window.localStorage.getItem(TASK_RUNTIME_STORAGE_KEY)
    const data: unknown = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, PersistedTaskRuntime>)
      : {}
  } catch {
    return {}
  }
}

function writePersistedTaskRuntime(items: Record<string, PersistedTaskRuntime>) {
  try {
    window.localStorage.setItem(TASK_RUNTIME_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // private mode/quota 문제는 실행 자체를 막으면 안 된다. 서버 active_run 복원은 계속 동작한다.
  }
}

function persistTaskRuntime(sessionId: string, runtime: PersistedTaskRuntime) {
  const items = readPersistedTaskRuntime()
  items[sessionId] = runtime
  writePersistedTaskRuntime(items)
}

function clearPersistedTaskRuntime(sessionId: string) {
  const items = readPersistedTaskRuntime()
  if (!(sessionId in items)) return
  delete items[sessionId]
  writePersistedTaskRuntime(items)
}

function taskRequestFromMeta(meta: AiSessionMeta): RunRequestParams | null {
  const taskPath = meta.active_run?.task_path || (meta.kind === 'task' ? meta.task_path : null)
  if (!taskPath) return null
  return {
    task_path: taskPath,
    section_id: meta.section_id ?? undefined,
    model: meta.model ?? undefined,
    effort: meta.effort ?? undefined,
  }
}

function hasServerActiveRun(meta: AiSessionMeta): boolean {
  // active_run은 이 수정 이전에 시작된 실행에는 없을 수 있다. 기존 running last_run도
  // 호환용으로 읽되, 현재 카드도 running인 경우에만 인정한다. 예전 버전에서 완료 뒤
  // last_run.status만 running으로 남은 이력이 실제 슬롯을 영구 점유하지 않게 한다.
  return Boolean(meta.active_run) || (meta.last_run?.status === 'running' && meta.task_status === 'running')
}

function isTerminalTaskRun(meta: AiSessionMeta): boolean {
  return Boolean(meta.last_run && meta.last_run.status !== 'running')
}

/** 서버 프로세스 재시작으로만 중단된 태스크는 같은 배치에서 안전하게 다시 대기열에 넣는다. */
function isRestartInterruptedTask(meta: AiSessionMeta): boolean {
  return meta.last_run?.status === 'error' && /서버가 재시작/.test(meta.last_run.message || '')
}

/** 실패한 질문을 원문·첨부 문맥 그대로 다시 보낼 수 있도록 보관하는 스냅샷. */
export type ChatRequestSnapshot = {
  prompt: string
  currentPath?: string
  context?: string
  includeDocument?: boolean
  mentionPaths: string[]
  /** 첨부 이미지 — 업로드된 에셋 URL과 화면에 표시할 원본 파일명. */
  images?: ChatImage[]
  /** 이미지가 아닌 첨부 파일 */
  files?: Array<{ url: string; name: string }>
}

export type SteerAttachments = {
  /** 실행 중 추가 지시와 함께 전달할 업로드 이미지. */
  images?: ChatImage[]
  /** 이미지가 아닌 업로드 파일. */
  files?: Array<{ url: string; name: string }>
}

export type RecoveryKind = 'websocket' | 'timeout' | 'auth' | 'cli' | 'limit' | 'backend' | 'cancelled'

export type RecoveryState = {
  kind: RecoveryKind
  message: string
  request: ChatRequestSnapshot | null
  occurredAt: number
}

export type AiSession = {
  id: string
  kind: 'chat' | 'task'
  title: string
  taskPath: string | null
  /** 태스크 카드에서 시작한 경우에만 표시하는 카드 출처 메타데이터. */
  sourceTask: AiTaskSource | null
  sourceTaskStatus: AiTaskSourceStatus | null
  scopeId: string | null
  /** 삭제된 프로젝트에서 이어진 과거 세션의 표시용 이름. 실행 scope로는 절대 쓰지 않는다. */
  lastScopeLabel: string | null
  /** 섹션별 메모리와 실행 대상 프로젝트를 결정하는 컨텍스트. */
  sectionId: string | null
  model: string | null
  effort: string | null
  createdAt: number
  updatedAt: number
  /** 카드 frontmatter에서 읽은 배치 식별자·순서. 같은 배치는 반드시 직렬로 실행한다. */
  batchId: string | null
  batchOrder: number | null
  /** 카드의 최신 상태. 선행 카드가 확인 필요/완료가 되기 전에는 후속 카드를 시작하지 않는다. */
  cardStatus: string | null
  /** 마지막 태스크 실행의 영속 상태. 새로고침 뒤에도 실행 요약·중단 안내를 복원한다. */
  lastRun: AiSessionLastRun | null

  // ── 런타임 (스트리밍) 상태 ──
  busy: boolean
  /** 사용자가 확정한 배치의 선행 작업을 대기 중 (태스크 세션만). */
  queued: boolean
  pendingReq: RunRequestParams | null
  runId: string | null
  turnId: string | null
  messages: AiMessage[]
  /** 현재 실행의 사용자용 진행 요약. 하단 Working 표시에서 사용한다. */
  currentStatus: string | null
  runLogPath: string | null
  /** 현재 이 세션에서 실행 중인 태스크. 원본 채팅 세션을 재사용하는 실행도 포함한다. */
  activeTaskPath: string | null
  memoryBullets: string[] | null
  /** 가장 최근의 명시적 기억 요청이 어느 실행에서 처리됐는지 식별한다. */
  memoryResultRunId: string | null
  /** 요청한 사실이 이미 같은 내용으로 기록돼 있었는지 표시한다. */
  memoryAlreadySaved: boolean
  /** 명시적 기억 요청을 처리했지만 저장하지 못한 이유. */
  memoryError: string | null
  taskStatus: { path: string; status: string } | null
  contextInfo: RunEvent | null
  error: string | null
  steerAck: 'pending' | 'ok' | 'fail' | null
  /** 이 세션이 '전체 실행 순서 계획' 세션인지 (결론 JSON 을 화면에서 숨기는 데 사용). */
  isOrderPlan?: boolean
  /** 전체 실행 순서 계획 세션의 결론 — 사용자가 패널에서 확정/취소한다. */
  runOrderProposal: {
    order: string[]
    titles: string[]
    reason: string
    parseFailed?: boolean
  } | null
  /** 가장 최근에 전송한 채팅 요청. 실패 시 recovery 의 재시도 원본이 된다. */
  lastRequest: ChatRequestSnapshot | null
  /** 오류·중단 후 복구 UI가 사용할 요청 및 상태. */
  recovery: RecoveryState | null
  /** 진행 시간 표시에 쓰는 클라이언트 기준 시작 시각(ms). */
  runStartedAt: number | null
  /** 중단 요청을 보낸 뒤 서버 확인을 기다리는 중인지. */
  cancelRequested: boolean
}

/** 세션 완료 알림 토스트 (메인 화면 우하단). */
export type AiToast = {
  id: number
  sessionId: string | null
  title: string
  kind: 'done' | 'error'
  message: string
  taskPath?: string | null
  category?: 'save'
}

let toastIdCounter = 0

interface AiStoreState {
  sessions: AiSession[]
  activeSessionId: string | null
  sessionsLoaded: boolean
  /** 세션 완료 알림 (메인 화면 토스트). */
  toasts: AiToast[]
  dismissToast: (id: number) => void
  notifySave: (success: boolean) => void
  reportTaskStartError: (title: string, message: string) => void

  /** Editor 가 구독하는 run log 갱신 신호 (마지막으로 갱신된 파일). */
  runLogPath: string | null
  runLogVersion: number

  loadSessions: () => Promise<void>
  newChatSession: (opts?: {
    title?: string
    scopeId?: string | null
    sectionId?: string | null
    /** 태스크 카드에서 시작한 '벼리와 논의' 대화의 출처. */
    sourceTaskPath?: string
  }) => Promise<string | null>
  selectSession: (id: string) => void
  closeSession: (id: string) => Promise<void>
  closeAllSessions: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  setSessionModel: (id: string, model: string | null, effort: string | null) => Promise<void>

  /** 챗 세션에 메시지 전송. */
  sendChat: (
    sessionId: string,
    prompt: string,
    opts?: {
      currentPath?: string
      context?: string
      includeDocument?: boolean
      mentionPaths?: string[]
      images?: ChatImage[]
      files?: Array<{ url: string; name: string }>
    },
  ) => void
  /** 태스크 카드 실행 — 세션 생성 + (대기열 정책에 따라) 시작. 세션 id 반환. */
  runTask: (params: {
    taskPath: string
    title: string
    scopeId?: string
    sectionId?: string
    model?: string
    effort?: string
    maxTimeSec?: number
    prompt?: string
    /** 카드가 이 대화에서 등록됐다면 새 태스크 세션 대신 해당 대화를 재사용한다. */
    sourceSessionId?: string
    /** 카드 프로젝트가 바뀐 뒤 기존 대화/thread를 재사용하지 않는 명시적 새 실행. */
    forceNewSession?: boolean
    /** 세션 생성 전 차단 사유를 카드 UI 안에 표시할 때 사용한다. */
    onError?: (message: string) => void
  }) => Promise<string | null>
  steer: (sessionId: string, guidance: string, attachments?: SteerAttachments) => void
  cancel: (sessionId: string) => void
  /** 실패/중단된 채팅을 같은 대화 세션에서 재시도한다. */
  retryChat: (sessionId: string) => void
  dismissRecovery: (sessionId: string) => void
  clearFinished: (sessionId: string) => void
  /** 전체 실행: 계획 세션을 만들어 벼리가 카드 내용을 검토·순서 판단하는 과정을 패널에서 보여준다. */
  startRunOrderPlan: (rows: NoteRow[]) => Promise<string | null>
  /** 계획 세션의 제안 순서로 실제 실행을 확정. */
  confirmRunOrder: (sessionId: string) => Promise<void>
  dismissRunOrder: (sessionId: string) => void
}

// WebSocket 인스턴스는 렌더링과 무관하므로 스토어 밖에서 관리
const sockets = new Map<string, WebSocket>()
let toolMessageIdCounter = 1
let steerMessageIdCounter = 1

const EMPTY_RUNTIME = {
  busy: false,
  queued: false,
  pendingReq: null,
  runId: null,
  turnId: null,
  currentStatus: null,
  runLogPath: null,
  activeTaskPath: null,
  memoryBullets: null,
  memoryResultRunId: null,
  memoryAlreadySaved: false,
  memoryError: null,
  taskStatus: null,
  contextInfo: null,
  error: null,
  steerAck: null,
  runOrderProposal: null,
  recovery: null,
  runStartedAt: null,
  cancelRequested: false,
} satisfies Partial<AiSession>

function restoredRecovery(lastRun: AiSessionLastRun | null): RecoveryState | null {
  if (!lastRun || lastRun.status === 'completed' || lastRun.status === 'running') return null
  return {
    kind: lastRun.status === 'cancelled' ? 'cancelled' : 'backend',
    message: lastRun.message,
    request: null,
    occurredAt: lastRun.completed_at * 1000,
  }
}

function visibleSessionMessages(meta: AiSessionMeta): AiMessage[] {
  const generatedTaskStart = meta.task_path ? `태스크 실행: ${meta.task_path}` : ''
  return (meta.messages ?? [])
    .filter((message) => !(meta.kind === 'task' && message.role === 'user' && message.content === generatedTaskStart))
    .map((message) => ({
      role: message.role,
      content: message.content,
      images: message.images
        ?.filter((image) => Boolean(image?.url))
        .map((image) => ({ url: image.url, name: image.name, alt: image.alt })),
    }))
}

function fromMeta(meta: AiSessionMeta): AiSession {
  const lastRun = meta.last_run ?? null
  const activeRun = meta.active_run ?? null
  const serverActive = hasServerActiveRun(meta)
  return {
    id: meta.id,
    kind: meta.kind === 'task' ? 'task' : 'chat',
    title: meta.title,
    taskPath: meta.task_path,
    sourceTask: meta.source_task ?? null,
    sourceTaskStatus: meta.source_task_status ?? null,
    scopeId: meta.scope_id,
    lastScopeLabel: meta.last_scope_label ?? null,
    sectionId: meta.section_id ?? null,
    model: meta.model,
    effort: meta.effort,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    batchId: meta.batch_id ?? null,
    batchOrder: meta.batch_order ?? null,
    cardStatus: meta.task_status ?? null,
    messages: visibleSessionMessages(meta),
    lastRequest: null,
    ...EMPTY_RUNTIME,
    lastRun,
    busy: serverActive,
    runId: activeRun?.run_id ?? lastRun?.run_id ?? null,
    currentStatus: serverActive ? '작업을 이어가는 중' : null,
    activeTaskPath: activeRun?.task_path ?? null,
    runStartedAt: activeRun ? activeRun.started_at * 1000 : null,
    runLogPath: activeRun?.run_log_path ?? lastRun?.run_log_path ?? null,
    taskStatus:
      lastRun?.task_path && lastRun.task_status
        ? { path: lastRun.task_path, status: lastRun.task_status }
        : null,
    memoryBullets: meta.memory_saved?.bullets?.length ? [...meta.memory_saved.bullets] : null,
    memoryResultRunId: meta.memory_error?.run_id ?? meta.memory_saved?.run_id ?? null,
    memoryAlreadySaved: Boolean(meta.memory_saved?.already_saved),
    memoryError: meta.memory_error?.message ?? null,
    recovery: restoredRecovery(lastRun),
  }
}

function requestParams(
  snapshot: ChatRequestSnapshot,
  retry = false,
  scopeId?: string | null,
  sectionId?: string | null,
): RunRequestParams {
  return {
    prompt: snapshot.prompt,
    // 채팅 대상 프로젝트는 세션에도 저장하지만, 이번 실행 요청에도 명시한다. 현재 문서가
    // 속한 섹션의 기본 scope보다 사용자가 고른 프로젝트가 항상 우선해야 한다.
    scope_id: scopeId || undefined,
    // 카드에서 시작한 논의는 세션에 고정한 섹션을 함께 보내 원래 메모리·문서 저장 문맥을 유지한다.
    section_id: sectionId || undefined,
    current_path: snapshot.currentPath,
    context: snapshot.context,
    include_document: snapshot.includeDocument || undefined,
    // 빈 배열도 전송: 이 UI에서는 @ 텍스트가 아니라 이 목록만 노트 본문 컨텍스트로 확장한다.
    mention_paths: snapshot.mentionPaths,
    images: snapshot.images?.length ? snapshot.images.map((image) => image.url) : undefined,
    image_attachments: snapshot.images?.length ? snapshot.images : undefined,
    files: snapshot.files?.length ? snapshot.files : undefined,
    // 메모리 기록 여부는 서버가 사용자 메시지의 명시적 기억 요청만으로 판정한다.
    retry,
  }
}

function failureKind(message: string, code?: string): RecoveryKind {
  const value = `${code ?? ''} ${message}`.toLocaleLowerCase()
  if (code === 'usage_limit_exceeded' || /usage.?limit|rate.?limit|사용량.{0,8}한도/.test(value)) return 'limit'
  if (code === 'timeout' || /timeout|time out|시간.{0,8}초과/.test(value)) return 'timeout'
  if (code === 'login_expired' || /로그인|login|auth|unauthorized|forbidden|expired|401|403/.test(value)) return 'auth'
  if (code === 'cli_unavailable' || /codex cli|cli.*설치|not found/.test(value)) return 'cli'
  if (code === 'websocket' || /websocket|연결.{0,8}(종료|실패|끊)/.test(value)) return 'websocket'
  return 'backend'
}

function toolTypeFromEvent(value: unknown): NonNullable<AiMessage['toolType']> {
  return value === 'command' || value === 'file_change' || value === 'dynamic' ? value : 'other'
}

function friendlyDynamicToolName(value: string): string {
  const normalized = value.trim()
  const known: Record<string, string> = {
    list_skillbook: '스킬북 확인',
    read_skillbook: '스킬 읽기',
    search_memories: '메모리 검색',
    list_calendar_events: '캘린더 일정 조회',
    create_calendar_event: '캘린더 일정 등록',
    update_calendar_event: '캘린더 일정 수정',
    delete_calendar_event: '캘린더 일정 삭제',
    list_todos: '할 일 조회',
    create_todo: '할 일 등록',
    complete_todo: '할 일 완료 처리',
    request_user_input: '사용자 입력 확인',
  }
  if (known[normalized]) return known[normalized]
  const short = normalized.includes('__') ? normalized.split('__').at(-1) || normalized : normalized
  return short.replace(/[_-]+/g, ' ').trim() || '앱 기능 사용'
}

function toolLabelFromEvent(msg: RunEvent): string {
  const toolType = toolTypeFromEvent(msg.tool_type)
  const raw = String(msg.text ?? msg.path ?? '').trim()
  const stripped = raw.replace(/^(?:실행 중|완료|실패|파일 변경|도구 호출)\s*:\s*/u, '').trim()
  if (toolType === 'dynamic') return friendlyDynamicToolName(stripped)
  if (stripped) return stripped
  if (toolType === 'command') return '명령 실행'
  if (toolType === 'file_change') return '파일 수정'
  return '작업 수행'
}

function toolProgressText(toolType: NonNullable<AiMessage['toolType']>, label: string, running: boolean): string {
  if (toolType === 'file_change') return running ? `파일 수정 중 · ${label}` : `파일 수정 완료 · ${label}`
  if (toolType === 'command') return running ? `명령 실행 중 · ${label}` : `명령 실행 완료 · ${label}`
  return running ? `${label} 중` : `${label} 완료`
}

export const useAiStore = create<AiStoreState>((set, get) => {
  // ── 내부 헬퍼 ────────────────────────────────────────────

  const patch = (id: string, p: Partial<AiSession> | ((s: AiSession) => Partial<AiSession>)) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...(typeof p === 'function' ? p(s) : p) } : s,
      ),
    }))
  }

  /** 응답 delta는 서버가 짧은 조각으로 매우 자주 보낸다. 매 조각마다 외부 스토어를 갱신하면
   * Markdown 렌더와 키보드 입력이 같은 메인 스레드를 경쟁한다. 최대 40ms 단위로 합쳐 그린다. */
  const pendingAssistantDeltas = new Map<string, { sessionId: string; itemId: string; text: string }>()
  let assistantDeltaTimer: number | null = null

  const appendAssistantDelta = (sessionId: string, itemId: string, text: string) => {
    if (!text) return
    patch(sessionId, (s) => {
      let idx = itemId ? s.messages.findLastIndex((message) => message.itemId === itemId) : -1
      if (idx < 0) idx = s.messages.findLastIndex((message) => message.role === 'assistant' && message.streaming)
      if (idx < 0) {
        return { messages: [...s.messages, { role: 'assistant', content: text, itemId, streaming: true }] }
      }
      const messages = s.messages.slice()
      messages[idx] = { ...messages[idx], content: messages[idx].content + text }
      return { messages }
    })
  }

  const flushAssistantDeltas = (sessionId?: string) => {
    const entries: Array<{ key: string; sessionId: string; itemId: string; text: string }> = []
    for (const [key, entry] of pendingAssistantDeltas) {
      if (!sessionId || entry.sessionId === sessionId) entries.push({ key, ...entry })
    }
    for (const entry of entries) pendingAssistantDeltas.delete(entry.key)
    for (const entry of entries) appendAssistantDelta(entry.sessionId, entry.itemId, entry.text)

    if (pendingAssistantDeltas.size === 0 && assistantDeltaTimer !== null) {
      window.clearTimeout(assistantDeltaTimer)
      assistantDeltaTimer = null
    }
  }

  const queueAssistantDelta = (sessionId: string, itemId: string, text: string) => {
    if (!text) return
    const key = `${sessionId}\u0000${itemId}`
    const pending = pendingAssistantDeltas.get(key)
    if (pending) pending.text += text
    else pendingAssistantDeltas.set(key, { sessionId, itemId, text })

    if (assistantDeltaTimer === null) {
      assistantDeltaTimer = window.setTimeout(() => {
        assistantDeltaTimer = null
        flushAssistantDeltas()
      }, 40)
    }
  }

  /** 복원된 대기열에서 시작 가능한 세션을 즉시 시작한다.
   *  openRun이 즉시 busy 상태를 설정하므로 중복 시작하지 않는다. */
  const pumpQueue = () => {
    // sessions 배열은 최신 세션이 앞에 오므로(prepend), 대기열은 "먼저 등록된 것부터"
    // 실행되도록 역순으로 순회한다 (전체 실행의 우선순위 순서 보장).
    for (const s of [...get().sessions].reverse()) {
      if (!s.queued || !s.pendingReq) continue
      if (!canStartTask(s, get().sessions)) continue
      const req = s.pendingReq
      patch(s.id, { queued: false, pendingReq: null })
      openRun(s.id, req)
    }
  }

  const finalizeStream = (id: string) => {
    clearPersistedTaskRuntime(id)
    patch(id, (s) => ({
      busy: false,
      currentStatus: null,
      activeTaskPath: null,
      runStartedAt: null,
      cancelRequested: false,
      messages: s.messages
        .filter((m) => !(m.role === 'reasoning' && m.streaming && !m.content))
        .map((m) =>
          m.role === 'tool' && m.toolState === 'running'
            ? { ...m, toolState: 'done' as const }
            : m.streaming
              ? { ...m, streaming: false }
              : m,
        ),
    }))
  }

  /** 오류 스트림을 끝내고 동일한 질문을 재시도할 수 있는 상태로 만든다. */
  const failRun = (id: string, message: string, kind?: RecoveryKind) => {
    clearPersistedTaskRuntime(id)
    patch(id, (s) => ({
      busy: false,
      currentStatus: null,
      activeTaskPath: null,
      runStartedAt: null,
      cancelRequested: false,
      error: message,
      recovery: {
        kind: kind ?? failureKind(message),
        message,
        request: s.lastRequest,
        occurredAt: Date.now(),
      },
      messages: s.messages
        .filter((m) => !(m.role === 'reasoning' && m.streaming && !m.content))
        .map((m) =>
          m.role === 'tool' && m.toolState === 'running'
            ? { ...m, toolState: 'error' as const }
            : m.streaming
              ? { ...m, streaming: false }
              : m,
        ),
    }))
  }

  /** 사용자가 중단한 경우는 오류와 분리해, 재시작 가능한 복구 상태만 남긴다. */
  const cancelRun = (id: string, message = '요청에 따라 이 턴을 중단했습니다.') => {
    clearPersistedTaskRuntime(id)
    patch(id, (s) => ({
      busy: false,
      currentStatus: null,
      activeTaskPath: null,
      runStartedAt: null,
      cancelRequested: false,
      error: null,
      recovery: {
        kind: 'cancelled',
        message,
        request: s.lastRequest,
        occurredAt: Date.now(),
      },
      messages: s.messages
        .filter((m) => !(m.role === 'reasoning' && m.streaming && !m.content))
        .map((m) =>
          m.role === 'tool' && m.toolState === 'running'
            ? { ...m, toolState: 'cancelled' as const }
            : m.streaming
              ? { ...m, streaming: false }
              : m,
        ),
    }))
  }

  /** 서버 세션 메타(제목 등)만 다시 당겨와 병합 — 런타임 상태는 유지. */
  const refreshMeta = async () => {
    try {
      const { sessions: metas } = await api.ai.listSessions()
      set((state) => ({
        // 서버의 최근 수정 순서를 유지해 목록에서 방금 사용한 대화가 위에 보이게 한다.
        sessions: metas.map((m) => {
          const existing = state.sessions.find((s) => s.id === m.id)
          if (!existing) return fromMeta(m)
          return {
            ...existing,
            title: m.title,
            model: m.model,
            effort: m.effort,
            scopeId: m.scope_id,
            lastScopeLabel: m.last_scope_label ?? null,
            sectionId: m.section_id ?? null,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
            batchId: m.batch_id ?? null,
            batchOrder: m.batch_order ?? null,
            cardStatus: m.task_status ?? null,
            lastRun: m.last_run ?? existing.lastRun,
          }
        }),
      }))
    } catch {
      /* ignore */
    }
  }

  const updateToolStatus = (id: string, msg: RunEvent, forceDone = false) => {
    const kind = forceDone ? 'tool_done' : String(msg.kind ?? 'tool_start')
    const running = kind === 'tool_start'
    const toolType = toolTypeFromEvent(msg.tool_type)
    const label = toolLabelFromEvent(msg)
    const eventItemId = typeof msg.itemId === 'string' ? msg.itemId.trim() : ''
    const exitCode = typeof msg.exit_code === 'number' ? msg.exit_code : null
    const failed = !running && (msg.success === false || (exitCode != null && exitCode !== 0) || /^실패\s*:/.test(String(msg.text ?? '')))

    patch(id, (session) => {
      let index = eventItemId
        ? session.messages.findLastIndex((message) => message.role === 'tool' && message.itemId === eventItemId)
        : -1
      if (index < 0 && !running) {
        index = session.messages.findLastIndex(
          (message) => message.role === 'tool' && message.toolState === 'running' && message.toolType === toolType,
        )
      }

      if (index >= 0) {
        const messages = session.messages.slice()
        const previous = messages[index]
        const fallbackLabel = label === '명령 실행' || label === '파일 수정' || label === '작업 수행'
        messages[index] = {
          ...previous,
          content: fallbackLabel && previous.content ? previous.content : label,
          itemId: eventItemId || previous.itemId,
          toolType,
          toolState: running ? 'running' : failed ? 'error' : 'done',
          exitCode,
        }
        return {
          messages,
          currentStatus: failed
            ? `${messages[index].content} 실패`
            : toolProgressText(toolType, messages[index].content, running),
        }
      }

      const itemId = eventItemId || `tool-${Date.now()}-${toolMessageIdCounter++}`
      const toolMessage: AiMessage = {
        role: 'tool',
        content: label,
        itemId,
        toolType,
        toolState: running ? 'running' : failed ? 'error' : 'done',
        toolOutput: '',
        exitCode,
      }
      return {
        messages: [...session.messages, toolMessage],
        currentStatus: failed ? `${label} 실패` : toolProgressText(toolType, label, running),
      }
    })
  }

  const appendToolOutput = (id: string, msg: RunEvent) => {
    const text = String(msg.text ?? '')
    if (!text) return
    const eventItemId = typeof msg.itemId === 'string' ? msg.itemId.trim() : ''
    patch(id, (session) => {
      let index = eventItemId
        ? session.messages.findLastIndex((message) => message.role === 'tool' && message.itemId === eventItemId)
        : -1
      if (index < 0) {
        index = session.messages.findLastIndex(
          (message) => message.role === 'tool' && message.toolState === 'running',
        )
      }
      if (index < 0) {
        return {
          messages: [
            ...session.messages,
            {
              role: 'tool',
              content: '명령 실행',
              itemId: eventItemId || `tool-${Date.now()}-${toolMessageIdCounter++}`,
              toolType: 'command',
              toolState: 'running',
              toolOutput: text.slice(-8000),
            },
          ],
          currentStatus: '명령을 실행하는 중',
        }
      }
      const messages = session.messages.slice()
      const current = messages[index]
      messages[index] = { ...current, toolOutput: `${current.toolOutput ?? ''}${text}`.slice(-8000) }
      return { messages }
    })
  }

  const handleEvent = (id: string, msg: RunEvent) => {
    const t = String(msg.type || '')
    // 시작·완료·오류 같은 경계 이벤트 전에 대기 중인 텍스트를 반영해 순서와 최종 답변을 보존한다.
    if (t !== 'delta') flushAssistantDeltas(id)
    switch (t) {
      case 'context_ready':
        patch(id, { contextInfo: msg })
        break
      case 'run_id':
        patch(id, { runId: String(msg.run_id ?? ''),
          ...(typeof msg.started_at === 'number' && Number.isFinite(msg.started_at) ? { runStartedAt: msg.started_at * 1000 } : {}),
        })
        {
          const session = get().sessions.find((s) => s.id === id)
          if (session?.activeTaskPath || session?.kind === 'task') {
            const previous = readPersistedTaskRuntime()[id]
            const request = previous?.request ?? taskRequestFromMeta({
              id: session.id,
              kind: session.kind,
              title: session.title,
              task_path: session.taskPath,
              scope_id: session.scopeId,
              section_id: session.sectionId,
              thread_id: null,
              engine_id: null,
              model: session.model,
              effort: session.effort,
              created_at: session.createdAt,
              updated_at: session.updatedAt,
              messages: [],
            })
            if (request) {
              persistTaskRuntime(id, {
                mode: 'running',
                request,
                runId: String(msg.run_id ?? ''),
                savedAt: Date.now(),
              })
            }
          }
        }
        break
      case 'turn_id':
        patch(id, { turnId: String(msg.turn_id ?? '') })
        break
      case 'turn_start':
        // 사고가 시작되기 전 placeholder 를 만들어 공백 제거 (delta 도착 시 채워짐)
        patch(id, (s) => {
          const last = s.messages[s.messages.length - 1]
          if (last?.role === 'reasoning' && last.streaming && !last.content) return {}
          return {
            messages: [
              ...s.messages,
              { role: 'reasoning', content: '', itemId: `reasoning-placeholder-${Date.now()}`, streaming: true },
            ],
            currentStatus: '요청을 분석하는 중',
          }
        })
        break
      case 'reasoning_start': {
        const itemId = String(msg.itemId ?? `reasoning-${Date.now()}`)
        patch(id, (s) => {
          const idx = s.messages.findLastIndex((x) => x.role === 'reasoning' && x.streaming && !x.content)
          if (idx >= 0) {
            const next = s.messages.slice()
            next[idx] = { ...next[idx], itemId }
            return { messages: next, currentStatus: '작업 결과를 살펴보는 중' }
          }
          return {
            messages: [...s.messages, { role: 'reasoning', content: '', itemId, streaming: true }],
            currentStatus: '작업 결과를 살펴보는 중',
          }
        })
        break
      }
      case 'reasoning_delta':
      case 'reasoning_part': {
        const itemId = msg.itemId ? String(msg.itemId) : ''
        const text = t === 'reasoning_part' ? '\n\n' : String(msg.text ?? '')
        patch(id, (s) => {
          let idx = itemId ? s.messages.findLastIndex((x) => x.itemId === itemId) : -1
          if (idx < 0) idx = s.messages.findLastIndex((x) => x.role === 'reasoning' && x.streaming)
          if (idx < 0) {
            return { messages: [...s.messages, { role: 'reasoning', content: text, itemId, streaming: true }] }
          }
          const next = s.messages.slice()
          const isPlaceholder = next[idx].itemId?.startsWith('reasoning-placeholder-') ?? false
          next[idx] = {
            ...next[idx],
            itemId: isPlaceholder && itemId ? itemId : next[idx].itemId,
            content:
              t === 'reasoning_part' && (!next[idx].content || next[idx].content.endsWith('\n\n'))
                ? next[idx].content
                : next[idx].content + text,
          }
          return { messages: next }
        })
        break
      }
      case 'reasoning_end': {
        const itemId = msg.itemId ? String(msg.itemId) : ''
        patch(id, (s) => {
          const idx = itemId
            ? s.messages.findLastIndex((x) => x.itemId === itemId)
            : s.messages.findLastIndex((x) => x.role === 'reasoning' && x.streaming)
          if (idx < 0) return {}
          const next = s.messages.slice()
          next[idx] = { ...next[idx], streaming: false }
          return { messages: next }
        })
        break
      }
      case 'message_start': {
        const itemId = String(msg.itemId ?? String(Date.now()))
        patch(id, (s) => ({
          // 답변이 시작되면 빈 reasoning placeholder 는 제거 (내용 있는 사고는 유지 — UI 가 접어서 표시)
          messages: [
            ...s.messages.filter((m) => !(m.role === 'reasoning' && m.streaming && !m.content)),
            { role: 'assistant', content: '', itemId, streaming: true },
          ],
          currentStatus: '답변 작성 중…',
        }))
        break
      }
      case 'delta': {
        const itemId = msg.itemId ? String(msg.itemId) : ''
        const text = String(msg.text ?? '')
        queueAssistantDelta(id, itemId, text)
        break
      }
      case 'message_end': {
        const itemId = msg.itemId ? String(msg.itemId) : ''
        const text = msg.text ? String(msg.text) : ''
        patch(id, (s) => {
          const idx = itemId
            ? s.messages.findLastIndex((x) => x.itemId === itemId)
            : s.messages.findLastIndex((x) => x.role === 'assistant' && x.streaming)
          if (idx < 0) return {}
          const next = s.messages.slice()
          const finalText = text && text.length > next[idx].content.length ? text : next[idx].content
          next[idx] = { ...next[idx], content: finalText, streaming: false }
          return { messages: next }
        })
        break
      }
      case 'image_result': {
        const rawImage = msg.image
        if (!rawImage || typeof rawImage !== 'object' || Array.isArray(rawImage)) break
        const value = rawImage as Record<string, unknown>
        const url = typeof value.url === 'string' ? value.url : ''
        if (!url) break
        const image: ChatImage = {
          url,
          name: typeof value.name === 'string' ? value.name : undefined,
          alt: typeof value.alt === 'string' ? value.alt : undefined,
        }
        const itemId = String(msg.itemId ?? `generated-image-${Date.now()}`)
        patch(id, (s) => {
          const existingIndex = s.messages.findLastIndex(
            (message) => message.role === 'assistant' && message.itemId === itemId,
          )
          if (existingIndex >= 0) {
            const next = s.messages.slice()
            next[existingIndex] = {
              ...next[existingIndex],
              images: [...(next[existingIndex].images ?? []), image],
              streaming: false,
            }
            return { messages: next, currentStatus: '이미지 생성 완료' }
          }
          return {
            messages: [
              ...s.messages.filter((message) => !(message.role === 'reasoning' && message.streaming && !message.content)),
              { role: 'assistant', content: '', images: [image], itemId, streaming: false },
            ],
            currentStatus: '이미지 생성 완료',
          }
        })
        break
      }
      case 'status': {
        updateToolStatus(id, msg)
        break
      }
      case 'tool_output_delta': {
        appendToolOutput(id, msg)
        break
      }
      case 'turn_done':
        // 엔진 턴은 끝났으며 서버에서 기록 저장을 마무리한다.
        patch(id, { currentStatus: '결과를 정리하는 중', turnId: null })
        break
      case 'run_log':
      case 'run_log_updated': {
        const path = msg.path ? String(msg.path) : null
        patch(id, (s) => ({ runLogPath: path ?? s.runLogPath }))
        set((state) => ({
          runLogPath: path ?? state.runLogPath,
          runLogVersion: state.runLogVersion + 1,
        }))
        break
      }
      case 'file_change': {
        // 벼리가 워크스페이스 노트를 생성/수정 — 에디터가 열려 있으면 자동 reload 되도록 신호
        const path = msg.path ? String(msg.path) : null
        updateToolStatus(id, msg, true)
        if (path) {
          set((state) => ({ runLogPath: path, runLogVersion: state.runLogVersion + 1 }))
        }
        break
      }
      case 'task_status':
        patch(id, {
          taskStatus: { path: String(msg.task_path ?? ''), status: String(msg.status ?? '') },
          cardStatus: String(msg.status ?? ''),
        })
        break
      case 'memory_learned':
        patch(id, (session) => ({
          memoryBullets: Array.isArray(msg.bullets) ? msg.bullets.map(String) : [],
          memoryResultRunId: String(msg.run_id ?? session.runId ?? ''),
          memoryAlreadySaved: Boolean(msg.already_saved),
          memoryError: null,
        }))
        break
      case 'memory_save_failed':
        patch(id, {
          memoryBullets: null,
          memoryResultRunId: String(msg.run_id ?? ''),
          memoryAlreadySaved: false,
          memoryError: String(msg.message ?? '메모리를 저장하지 못했습니다'),
        })
        break
      case 'steer_ack': {
        const ok = Boolean(msg.ok)
        const messageId = typeof msg.client_message_id === 'string' ? msg.client_message_id : ''
        const turnId = ok && typeof msg.turn_id === 'string' && msg.turn_id ? msg.turn_id : null
        patch(id, (s) => ({
          steerAck: ok ? 'ok' : 'fail',
          // steer가 새 활성 turn ID를 돌려주는 Codex app-server에서는 이를 즉시 반영한다.
          // 다음 추가 지시가 완료된 이전 턴을 기준으로 전송되는 일을 막는다.
          turnId: turnId ?? s.turnId,
          messages: messageId
            ? s.messages.map((message) =>
                message.itemId === messageId
                  ? { ...message, delivery: ok ? 'accepted' : 'failed' }
                  : message,
              )
            : s.messages,
        }))
        setTimeout(() => patch(id, { steerAck: null }), 3000)
        break
      }
      case 'session_updated':
        refreshMeta()
        break
      case 'budget_hit':
        failRun(id, `⏱ ${String(msg.reason ?? '실행 한도에 도달했습니다')}`)
        break
      case 'timeout':
        failRun(id, `⏱ ${String(msg.message ?? msg.reason ?? '응답 시간 제한을 초과했습니다')}`, 'timeout')
        break
      case 'cancelled':
        cancelRun(id, String(msg.message ?? '요청에 따라 이 턴을 중단했습니다.'))
        break
      case 'cancel_ack':
        patch(id, {
          cancelRequested: Boolean(msg.ok),
          currentStatus: msg.ok ? '중단 요청을 전달했어요. 실행을 정리하는 중…' : '중단 요청을 전달하지 못했습니다.',
          error: msg.ok ? null : '중단 요청을 전달하지 못했습니다. 잠시 후 다시 시도해주세요.',
        })
        break
      case 'error': {
        const message = String(msg.message ?? '알 수 없는 오류가 발생했습니다.')
        failRun(id, message, failureKind(message, typeof msg.code === 'string' ? msg.code : undefined))
        break
      }
      case 'done':
        finalizeStream(id)
        captureRunOrder(id)
        notifyFinished(id)
        break
      default:
        break
    }
  }

  /** 순서 계획 세션이 끝나면 최종 답변에서 결론 JSON 을 추출해 패널에 확정 카드를 띄운다. */
  const captureRunOrder = (id: string) => {
    const rows = orderPlanRows.get(id)
    if (!rows) return
    const s = get().sessions.find((x) => x.id === id)
    if (!s) return
    const lastAnswer = [...s.messages].reverse().find((m) => m.role === 'assistant')?.content ?? ''
    const parsed = parseRunOrderJson(lastAnswer)
    const byPath = new Map(rows.map((r) => [r.path, r]))
    const order: string[] = []
    const seen = new Set<string>()
    for (const p of parsed?.order ?? []) {
      if (byPath.has(p) && !seen.has(p)) {
        order.push(p)
        seen.add(p)
      }
    }
    for (const r of rows) if (!seen.has(r.path)) order.push(r.path) // 누락 카드는 원래 순서대로 뒤에
    patch(id, {
      runOrderProposal: {
        order,
        titles: order.map((p) => byPath.get(p)?.title || p),
        reason: parsed?.reason ?? '',
        parseFailed: !parsed,
      },
    })
  }

  /** 완료 알림 토스트 — 벼리 패널이 안 보이거나 다른 세션을 보고 있을 때만 띄운다.
   *  다른 작업 중에도 메인 화면에서 완료 사실과 결과 요약을 바로 확인하는 용도. */
  const notifyFinished = (id: string) => {
    const s = get().sessions.find((x) => x.id === id)
    if (!s) return
    const app = useAppStore.getState()
    const panelVisibleOnThis =
      app.rightDockOpen && app.activeRightTab === SYSTEM_AI_TAB && get().activeSessionId === id
    if (panelVisibleOnThis) return
    const lastAnswer = [...s.messages].reverse().find((m) => m.role === 'assistant')?.content ?? ''
    const failed = Boolean(s.error || s.recovery)
    const toast: AiToast = {
      id: ++toastIdCounter,
      sessionId: id,
      title: s.title,
      kind: failed ? 'error' : 'done',
      message: failed
        ? (s.recovery?.message || s.error || '오류로 종료되었습니다')
        : lastAnswer.slice(0, 120) || '작업이 완료되었습니다',
      taskPath: s.taskStatus?.path ?? s.taskPath,
    }
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }))
    // 성공 토스트는 12초 뒤 자동 소멸, 오류는 직접 닫을 때까지 유지
    if (!failed) {
      setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== toast.id) }))
      }, 12_000)
    }
  }

  const notifyTaskStartError = (title: string, message: string) => {
    const toast: AiToast = {
      id: ++toastIdCounter,
      sessionId: null,
      title,
      kind: 'error',
      message,
    }
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }))
  }

  /** WS 를 열고 실행 요청 전송. 세션의 런타임 상태를 초기화. */
  const openRun = (id: string, req: RunRequestParams) => {
    flushAssistantDeltas(id)
    const existing = sockets.get(id)
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      try {
        existing.close()
      } catch {
        /* ignore */
      }
    }

    if (req.task_path) {
      persistTaskRuntime(id, { mode: 'running', request: req, runId: null, savedAt: Date.now() })
    }

    patch(id, {
      ...EMPTY_RUNTIME,
      busy: true,
      activeTaskPath: req.task_path ?? null,
      lastRun: null,
      currentStatus: '연결하는 중',
      runStartedAt: Date.now(),
    })

    const ws = api.ai.runWs()
    sockets.set(id, ws)

    const isCurrentSocket = () => sockets.get(id) === ws
    ws.onopen = () => {
      if (!isCurrentSocket()) return
      const taskMode = req.task_path || get().sessions.find(session => session.id === id)?.taskPath
      const approval = taskMode ? null : localStorage.getItem(`twill.ai.approval.${id}`)
      ws.send(JSON.stringify({ ...req, ...(approval === 'never' || approval === 'on-request' ? { approval } : {}), session_id: id, app_language: currentLanguage() }))
      patch(id, { currentStatus: '요청을 준비하는 중' })
      // 연결이 열리기 전에 누른 중단도 첫 요청 뒤 즉시 서버에 전달한다.
      if (get().sessions.find((s) => s.id === id)?.cancelRequested) {
        ws.send(JSON.stringify({ type: 'cancel' }))
      }
    }
    const eventBatcher = createStreamBatcher(msg => { if (isCurrentSocket()) handleEvent(id, msg) })
    ws.onmessage = (ev) => {
      if (!isCurrentSocket()) return
      let msg: RunEvent
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      eventBatcher.push(msg)
    }
    ws.onerror = () => {
      if (!isCurrentSocket()) return
      patch(id, { currentStatus: '연결 상태를 확인하는 중' })
    }
    ws.onclose = () => {
      eventBatcher.flush()
      if (!isCurrentSocket()) return
      flushAssistantDeltas(id)
      sockets.delete(id)
      const current = get().sessions.find((s) => s.id === id)
      if (current?.busy) {
        if (current.cancelRequested) {
          cancelRun(id, '중단 요청 후 연결이 종료되었습니다. 이 질문은 다시 시작할 수 있습니다.')
        } else {
          // 세션에 연결된 채팅·태스크는 서버가 브라우저 연결과 독립적으로
          // 끝까지 소비한다. 새 소켓을 억지로 열지 않고 active_run 폴링으로
          // 진행 표시·중단 동작·완료 메시지를 이어받는다.
          patch(id, { currentStatus: '작업 상태를 다시 확인하는 중' })
          window.setTimeout(() => void get().loadSessions(), 300)
        }
      }
      pumpQueue()
    }
  }

  let sessionsLoading: Promise<void> | null = null

  // ── 스토어 본체 ─────────────────────────────────────────
  return {
    sessions: [],
    activeSessionId: null,
    sessionsLoaded: false,
    toasts: [],
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    notifySave: (success) => {
      const toast: AiToast = {
        id: ++toastIdCounter, sessionId: null, title: '', category: 'save',
        kind: success ? 'done' : 'error',
        message: success ? '모드 설정을 저장했습니다.' : '모드 설정을 저장하지 못했습니다. 다시 시도해주세요.',
      }
      set(state => ({ toasts: [...state.toasts.slice(-3), toast] }))
      if (success) setTimeout(() => get().dismissToast(toast.id), 4000)
    },
    reportTaskStartError: notifyTaskStartError,
    runLogPath: null,
    runLogVersion: 0,

    loadSessions: async () => {
      if (sessionsLoading) return sessionsLoading
      sessionsLoading = (async () => {
      try {
        const { sessions: metas } = await api.ai.listSessions()
        const savedRuntime = readPersistedTaskRuntime()
        const nextRuntime = { ...savedRuntime }
        const metaById = new Map(metas.map((meta) => [meta.id, meta]))
        set((state) => {
          const merged = metas.map((m) => {
            const existing = state.sessions.find((s) => s.id === m.id)
            const serverActive = hasServerActiveRun(m)
            // 연결된 스트림은 받은 delta를 유지하고, 새로고침 뒤의 분리된 실행은 서버
            // active_run을 기준으로 busy/run log를 되살린다.
            const base: AiSession = existing
              ? {
                ...existing,
                title: m.title,
                model: m.model,
                effort: m.effort,
                sourceTask: m.source_task ?? null,
                sourceTaskStatus: m.source_task_status ?? null,
                scopeId: m.scope_id,
                lastScopeLabel: m.last_scope_label ?? null,
                sectionId: m.section_id ?? null,
                createdAt: m.created_at,
                updatedAt: m.updated_at,
                batchId: m.batch_id ?? null,
                batchOrder: m.batch_order ?? null,
                cardStatus: m.task_status ?? null,
                lastRun: m.last_run ?? null,
                memoryBullets: m.memory_saved?.bullets?.length
                  ? [...m.memory_saved.bullets]
                  : existing.memoryBullets,
                memoryResultRunId:
                  m.memory_error?.run_id ?? m.memory_saved?.run_id ?? existing.memoryResultRunId,
                memoryAlreadySaved: m.memory_saved
                  ? Boolean(m.memory_saved.already_saved)
                  : existing.memoryAlreadySaved,
                memoryError: m.memory_error?.message ?? (m.memory_saved ? null : existing.memoryError),
                messages: sockets.has(m.id) ? existing.messages : visibleSessionMessages(m),
              }
              : fromMeta(m)
            const stored = savedRuntime[m.id]
            const request = stored?.request ?? taskRequestFromMeta(m)
            const activeRun = m.active_run ?? null
            if (serverActive) {
              if (request) {
                nextRuntime[m.id] = {
                  mode: 'running',
                  request,
                  runId: activeRun?.run_id ?? m.last_run?.run_id ?? stored?.runId ?? null,
                  savedAt: Date.now(),
                }
              }
              return {
                ...base,
                busy: true,
                queued: false,
                pendingReq: null,
                runId: activeRun?.run_id ?? m.last_run?.run_id ?? base.runId,
                runLogPath: activeRun?.run_log_path ?? m.last_run?.run_log_path ?? base.runLogPath,
                activeTaskPath: activeRun?.task_path ?? request?.task_path ?? base.activeTaskPath,
                runStartedAt: activeRun ? activeRun.started_at * 1000 : base.runStartedAt,
                currentStatus: sockets.has(m.id) ? base.currentStatus : '작업을 이어가는 중',
                recovery: null,
              }
            }
            if (m.kind !== 'task') {
              delete nextRuntime[m.id]
              if (sockets.has(m.id)) return base
              return {
                ...base,
                busy: false,
                queued: false,
                pendingReq: null,
                activeTaskPath: null,
                runStartedAt: null,
                cancelRequested: false,
                currentStatus: null,
                taskStatus:
                  m.last_run?.task_path && m.last_run.task_status
                    ? { path: m.last_run.task_path, status: m.last_run.task_status }
                    : base.taskStatus,
                recovery: restoredRecovery(m.last_run ?? null),
              }
            }
            if (
              stored?.mode === 'queued' &&
              (!isTerminalTaskRun(m) || isRestartInterruptedTask(m)) &&
              stored.request.task_path === m.task_path
            ) {
              return {
                ...base,
                busy: false,
                queued: true,
                pendingReq: stored.request,
                currentStatus: '대기 중 (새로고침 후 복원)',
                recovery: null,
              }
            }
            // 종료된 실행은 다시 시작되지 않도록 로컬 기록을 버린다.
            delete nextRuntime[m.id]
            return {
              ...base,
              busy: false,
              queued: false,
              pendingReq: null,
              runStartedAt: null,
              cancelRequested: false,
              currentStatus: null,
              recovery: restoredRecovery(m.last_run ?? null),
            }
          })

          // active_run 도입 전 실행한 배치와 localStorage가 없는 배치도 한 번 복원한다.
          // 실제 실행 중인 카드가 있거나, 방금 생성됐는데 아직 한 번도 실행하지 않은
          // running 카드가 있는 배치만 대상으로 해 오래전에 멈춘 카드를 되살리지 않는다.
          const recentBatchCutoff = Date.now() / 1000 - 24 * 60 * 60
          const recoverableBatches = new Set(
            merged.flatMap((session) => {
              const meta = metaById.get(session.id)
              const isFreshUnstarted =
                Boolean(meta) &&
                meta?.task_status === 'running' &&
                !meta.last_run &&
                !meta.active_run &&
                meta.created_at >= recentBatchCutoff
              const isRestartInterrupted = Boolean(meta && isRestartInterruptedTask(meta))
              return meta?.batch_id && (session.busy || isFreshUnstarted || isRestartInterrupted) ? [meta.batch_id] : []
            }),
          )
          const recovered = merged.map((session) => {
            const meta = metaById.get(session.id)
            if (
              !meta ||
              session.kind !== 'task' ||
              session.busy ||
              session.queued ||
              !meta.batch_id ||
              !recoverableBatches.has(meta.batch_id) ||
              (meta.task_status !== 'running' && !isRestartInterruptedTask(meta)) ||
              (meta.last_run && !isRestartInterruptedTask(meta)) ||
              meta.active_run
            ) {
              return session
            }
            const request = taskRequestFromMeta(meta)
            if (!request) return session
            nextRuntime[session.id] = { mode: 'queued', request, runId: null, savedAt: Date.now() }
            return {
              ...session,
              queued: true,
              pendingReq: request,
              currentStatus: '대기 중 (배치 실행 복원)',
            }
          })
          const active =
            state.activeSessionId && recovered.some((s) => s.id === state.activeSessionId)
              ? state.activeSessionId
              : (recovered.find((s) => s.busy)?.id ?? recovered[0]?.id ?? null)
          return { sessions: recovered, activeSessionId: active, sessionsLoaded: true }
        })
        const known = new Set(metas.map((meta) => meta.id))
        for (const id of Object.keys(nextRuntime)) if (!known.has(id)) delete nextRuntime[id]
        writePersistedTaskRuntime(nextRuntime)
        window.setTimeout(pumpQueue, 0)
      } catch {
        // A failed list request is not evidence that restored conversations were deleted.
        set({ sessionsLoaded: false })
      }
      })()
      try { await sessionsLoading } finally { sessionsLoading = null }
    },

    newChatSession: async (opts) => {
      try {
        const meta = await api.ai.createSession({
          kind: 'chat',
          title: opts?.title,
          scope_id: opts?.scopeId ?? undefined,
          section_id: opts?.sectionId ?? undefined,
          source_task_path: opts?.sourceTaskPath,
        })
        set((state) => ({
          sessions: [fromMeta(meta), ...state.sessions],
          activeSessionId: meta.id,
        }))
        return meta.id
      } catch {
        return null
      }
    },

    selectSession: (id) => {
      set({ activeSessionId: id })
      // 과거 대화를 다시 열 때 카드가 그 사이 이동·이름 변경·삭제됐을 수 있다.
      // 목록 메타를 조용히 새로 읽어 출처 배너가 오래된 경로 링크를 만들지 않게 한다.
      void get().loadSessions()
    },

    closeSession: async (id) => {
      const s = get().sessions.find((x) => x.id === id)
      if (s?.busy || s?.queued) get().cancel(id)
      const ws = sockets.get(id)
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        sockets.delete(id)
      }
      await api.ai.deleteSession(id)
      set((state) => {
        const sessions = state.sessions.filter((x) => x.id !== id)
        const active =
          state.activeSessionId === id ? (sessions[0]?.id ?? null) : state.activeSessionId
        return { sessions, activeSessionId: active }
      })
      clearPersistedTaskRuntime(id)
      pumpQueue()
    },

    closeAllSessions: async () => {
      await api.ai.deleteSessions()
      for (const ws of sockets.values()) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
      sockets.clear()
      orderPlanRows.clear()
      writePersistedTaskRuntime({})
      set({ sessions: [], activeSessionId: null, toasts: [] })
    },

    renameSession: async (id, title) => {
      const updated = await api.ai.updateSession(id, { title })
      patch(id, { title: updated.title, updatedAt: updated.updated_at })
      await get().loadSessions()
      await useAppStore.getState().refreshTree()
    },

    setSessionModel: async (id, model, effort) => {
      const updatedAt = Date.now() / 1000
      patch(id, { model, effort, updatedAt })
      try {
        await api.ai.updateSession(id, { model, effort })
      } catch {
        /* ignore */
      }
    },

    sendChat: (sessionId, prompt, opts) => {
      const s = get().sessions.find((x) => x.id === sessionId)
      // 이미지만 첨부하고 텍스트 없이 보내는 것도 허용
      if (!s || s.busy || (!prompt.trim() && !opts?.images?.length && !opts?.files?.length)) return
      const snapshot: ChatRequestSnapshot = {
        prompt,
        currentPath: opts?.currentPath,
        context: opts?.context,
        includeDocument: opts?.includeDocument,
        mentionPaths: opts?.mentionPaths ?? [],
        images: opts?.images ?? [],
        files: opts?.files ?? [],
      }
      const displayUser =
        (opts?.context ? `[선택된 내용]\n${opts.context}\n\n` : '') +
        prompt +
        (opts?.files?.length ? `\n[📎 파일 첨부: ${opts.files.map((f) => f.name).join(', ')}]` : '')
      patch(sessionId, (cur) => ({
        messages: [
          ...cur.messages,
          {
            role: 'user',
            content: displayUser,
            images: opts?.images?.length ? opts.images.map((image) => ({ ...image })) : undefined,
          },
        ],
        error: null,
        lastRequest: snapshot,
        recovery: null,
        updatedAt: Date.now() / 1000,
      }))
      openRun(sessionId, requestParams(snapshot, false, s.scopeId, s.sectionId))
    },

    runTask: async ({
      taskPath,
      title,
      scopeId,
      sectionId,
      model,
      effort,
      maxTimeSec,
      prompt,
      sourceSessionId,
      forceNewSession,
      onError,
    }) => {
      // 같은 태스크가 이미 실행/대기 중이면 그 세션 재사용 (중복 실행 방지)
      const dup = get().sessions.find(
        (s) => (s.taskPath === taskPath || s.activeTaskPath === taskPath) && (s.busy || s.queued),
      )
      if (dup) {
        set({ activeSessionId: dup.id })
        return dup.id
      }

      let resolvedScopeId = scopeId ?? null
      let resolvedSectionId = sectionId ?? null
      try {
        const [{ scopes }, { sections }] = await Promise.all([
          api.workspaceSettings.listScopes(),
          api.workspaceSettings.getSections(),
        ])
        const resolution = resolveTaskExecutionScope(
          { scopeId, sectionId, taskPath },
          sections,
          scopes,
        )
        if (resolution.error) {
          if (onError) onError(resolution.error)
          else notifyTaskStartError(title || taskPath, resolution.error)
          return null
        }
        resolvedScopeId = resolution.scopeId
        resolvedSectionId = resolution.sectionId
      } catch {
        // 카탈로그 사전 확인이 일시적으로 실패해도 세션 생성 API가 같은 정책으로 최종 검증한다.
      }

      let sourceSession = sourceSessionId
        ? get().sessions.find((session) => session.id === sourceSessionId && session.kind === 'chat')
        : null
      if (sourceSessionId && !sourceSession) {
        await get().loadSessions()
        sourceSession =
          get().sessions.find((session) => session.id === sourceSessionId && session.kind === 'chat') ?? null
      }
      if (sourceSession && !forceNewSession && sourceSession.scopeId === resolvedScopeId) {
        set({ activeSessionId: sourceSession.id })
        // 한 thread에는 동시에 두 turn을 실행할 수 없다. 사용자가 원본 대화의 현재 실행을
        // 확인한 뒤 다시 누를 수 있도록 포커스만 옮기고 새 세션으로 우회하지 않는다.
        if (sourceSession.busy || sourceSession.queued) return sourceSession.id

        const displayPrompt = `태스크 실행: ${title || taskPath}`
        const req: RunRequestParams = {
          task_path: taskPath,
          section_id: resolvedSectionId || sourceSession.sectionId || undefined,
          model,
          effort,
          max_time_sec: maxTimeSec,
          prompt,
          display_prompt: displayPrompt,
        }
        patch(sourceSession.id, (current) => ({
          messages: [...current.messages, { role: 'user', content: displayPrompt }],
          error: null,
          recovery: null,
          lastRequest: null,
          updatedAt: Date.now() / 1000,
        }))
        openRun(sourceSession.id, req)
        return sourceSession.id
      }

      if (startingTaskPaths.has(taskPath)) return null
      startingTaskPaths.add(taskPath)
      let meta: AiSessionMeta
      try {
        meta = await api.ai.createSession({
          kind: 'task',
          title,
          task_path: taskPath,
          scope_id: resolvedScopeId ?? undefined,
          section_id: resolvedSectionId ?? undefined,
          model,
          effort,
        })
      } catch (error) {
        const message = (error as Error).message || '태스크 실행 세션을 만들 수 없습니다.'
        if (onError) onError(message)
        else notifyTaskStartError(title || taskPath, message)
        return null
      } finally {
        startingTaskPaths.delete(taskPath)
      }
      const session = fromMeta(meta)
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: meta.id,
      }))
      const req: RunRequestParams = {
        task_path: taskPath,
        // 세션 생성 시 서버가 카드 frontmatter 기준으로 확정한 섹션을 다시 사용한다.
        section_id: session.sectionId ?? resolvedSectionId ?? undefined,
        model,
        effort,
        max_time_sec: maxTimeSec,
        prompt,
      }
      if (canStartTask(session, get().sessions)) {
        openRun(meta.id, req)
      } else {
        patch(meta.id, { queued: true, pendingReq: req, currentStatus: '대기 중 (배치 선행 작업)' })
        persistTaskRuntime(meta.id, { mode: 'queued', request: req, runId: null, savedAt: Date.now() })
      }
      return meta.id
    },

    steer: (sessionId, guidance, attachments) => {
      const text = guidance.trim()
      const images = attachments?.images ?? []
      const files = attachments?.files ?? []
      if (!text && images.length === 0 && files.length === 0) return
      const displayText = text + (files.length ? `${text ? '\n' : ''}[📎 파일 첨부: ${files.map((file) => file.name).join(', ')}]` : '')
      const ws = sockets.get(sessionId)
      const messageId = `steer-${Date.now()}-${steerMessageIdCounter++}`
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        patch(sessionId, (s) => ({
          steerAck: 'fail',
          messages: [
            ...s.messages,
            {
              role: 'user',
              content: displayText,
              images: images.length ? images.map((image) => ({ ...image })) : undefined,
              itemId: messageId,
              delivery: 'failed',
            },
          ],
        }))
        setTimeout(() => patch(sessionId, { steerAck: null }), 3000)
        return
      }
      patch(sessionId, (s) => ({
        steerAck: 'pending',
        messages: [
          ...s.messages,
          {
            role: 'user',
            content: displayText,
            images: images.length ? images.map((image) => ({ ...image })) : undefined,
            itemId: messageId,
            delivery: 'pending',
          },
        ],
      }))
      try {
        ws.send(JSON.stringify({
          type: 'steer',
          guidance: text,
          client_message_id: messageId,
          images: images.length ? images.map((image) => image.url) : undefined,
          image_attachments: images.length ? images : undefined,
          files: files.length ? files : undefined,
        }))
      } catch {
        patch(sessionId, (s) => ({
          steerAck: 'fail',
          messages: s.messages.map((message) =>
            message.itemId === messageId ? { ...message, delivery: 'failed' } : message,
          ),
        }))
        setTimeout(() => patch(sessionId, { steerAck: null }), 3000)
      }
    },

    cancel: (sessionId) => {
      const s = get().sessions.find((x) => x.id === sessionId)
      if (s?.queued) {
        patch(sessionId, { queued: false, pendingReq: null, currentStatus: null })
        clearPersistedTaskRuntime(sessionId)
        return
      }
      if (!s?.busy || s.cancelRequested) return
      patch(sessionId, { cancelRequested: true, currentStatus: '중단 요청을 보내는 중…', error: null })
      const ws = sockets.get(sessionId)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel' }))
      } else if (s.runId) {
        // 새로고침 뒤에는 원래 WS가 없으므로 채팅·태스크 모두 세션에 영속된
        // run id를 통해 HTTP로 중단한다.
        api.ai.cancelSession(sessionId).then(({ ok }) => {
          if (!ok) {
            patch(sessionId, {
              cancelRequested: false,
              currentStatus: '실행을 찾지 못했습니다. 상태를 다시 확인해주세요.',
              error: '중단 요청을 전달하지 못했습니다.',
            })
          }
        }).catch(() => {
          patch(sessionId, {
            cancelRequested: false,
            currentStatus: '중단 요청을 전달하지 못했습니다.',
            error: '중단 요청을 전달하지 못했습니다. 잠시 후 다시 시도해주세요.',
          })
        })
      }
    },

    retryChat: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      const snapshot = session?.recovery?.request
      if (!session || session.kind !== 'chat' || !snapshot?.prompt.trim()) return
      // 재시도는 같은 세션/thread를 resume한다. UI/세션 히스토리에 같은 사용자 말풍선을
      // 하나 더 만들지 않고, 서버에도 retry 플래그로 중복 저장을 막는다.
      patch(sessionId, { error: null, recovery: null, updatedAt: Date.now() / 1000 })
      openRun(sessionId, requestParams(snapshot, true, session.scopeId, session.sectionId))
    },

    dismissRecovery: (sessionId) => patch(sessionId, { error: null, recovery: null }),

    clearFinished: (sessionId) => {
      patch(sessionId, (s) => (s.busy ? {} : { ...EMPTY_RUNTIME, messages: [] }))
    },

    startRunOrderPlan: async (rows) => {
      if (rows.length === 0) return null
      let meta: AiSessionMeta
      try {
        meta = await api.ai.createSession({ kind: 'chat', title: `전체 실행 계획 (${rows.length}개)` })
      } catch {
        return null
      }
      const session = fromMeta(meta)
      set((state) => ({ sessions: [session, ...state.sessions], activeSessionId: meta.id }))
      orderPlanRows.set(meta.id, rows)
      patch(meta.id, { isOrderPlan: true })

      // 카드 본문 요약 수집 (읽기 실패 시 제목만으로 판단)
      const summaries = await Promise.all(
        rows.map(async (r) => {
          let body = ''
          try {
            body = (await api.getContent(r.path)).body.trim().slice(0, 600)
          } catch {
            /* 제목만 사용 */
          }
          return `[${r.path}]\n제목: ${r.title}\n스코프: ${String(r.props.scope ?? '') || '(없음)'}\n내용: ${body || '(본문 없음)'}`
        }),
      )
      const prompt = `다음 ${rows.length}개의 태스크 카드를 하나씩 순서대로 실행하려 합니다. 각 카드의 내용을 검토해 최적의 실행 순서를 결정해주세요.

고려 기준:
1. 선행 조건/의존성 — 다른 카드의 기반이 되는 작업 먼저
2. 같은 스코프(코드베이스)의 작업은 충돌이 적도록 연속 배치
3. 이후 작업의 방향을 좌우하는(결과 확인이 필요한) 작업 우선

${summaries.join('\n\n')}

판단 과정을 간단히 설명한 뒤, 마지막에 반드시 아래 형식의 JSON 으로 결론을 제시하세요 (order 에는 위 대괄호 안의 경로를 정확히 그대로, 전부 한 번씩):
{"order": ["경로1", "경로2"], "reason": "이 순서로 정한 이유 한두 문장"}`

      // 사용자 버블·서버 히스토리 모두 긴 프롬프트 대신 같은 요약을 사용
      // (표시문과 실제 요청이 달라 재접속 시 원문이 노출되던 문제 방지 — display_prompt)
      const displaySummary = `실행 순서 판단 요청 — ${rows.length}개 카드:\n${rows.map((r, i) => `${i + 1}. ${r.title || r.path}`).join('\n')}`
      patch(meta.id, (cur) => ({
        messages: [...cur.messages, { role: 'user', content: displaySummary }],
        updatedAt: Date.now() / 1000,
      }))
      // display_prompt가 있는 내부 보조 요청은 서버의 명시적 기억 요청 판정 대상에서 제외된다.
      openRun(meta.id, { prompt, display_prompt: displaySummary })
      return meta.id
    },

    confirmRunOrder: async (sessionId) => {
      const s = get().sessions.find((x) => x.id === sessionId)
      const rows = orderPlanRows.get(sessionId)
      const proposal = s?.runOrderProposal
      if (!s || !rows || !proposal) return
      orderPlanRows.delete(sessionId)
      patch(sessionId, { runOrderProposal: null })
      const byPath = new Map(rows.map((r) => [r.path, r]))
      // 배치 인계: 카드에 batch_id/batch_order 를 기록해 두면, 오케스트레이터가 후속 카드 실행 시
      // 같은 배치 선행 카드들의 실행 보고·산출물 파일 목록을 [선행 작업 결과]로 자동 첨부한다.
      const batchId = `batch-${Date.now().toString(36)}`
      for (let i = 0; i < proposal.order.length; i++) {
        const row = byPath.get(proposal.order[i])
        if (!row) continue
        try {
          await setNoteProp(row.path, 'batch_id', batchId)
          await setNoteProp(row.path, 'batch_order', i + 1)
        } catch {
          /* 인계 메타 기록 실패는 실행을 막지 않음 */
        }
      }
      for (const path of proposal.order) {
        const row = byPath.get(path)
        if (!row) continue
        // 세션 생성을 순차로 해서 대기열이 제안된 순서를 그대로 따르게 한다
        await get().runTask({
          taskPath: row.path,
          title: row.title || row.path,
          scopeId: (row.props.scope as string) || undefined,
          sectionId: (row.props.section_id as string) || undefined,
          model: (row.props.model as string) || undefined,
          effort: (row.props.effort as string) || undefined,
          maxTimeSec:
            typeof row.props.max_time_min === 'number' ? (row.props.max_time_min as number) * 60 : undefined,
        })
      }
      // 마지막에 등록된(대기 중일 수 있는) 세션이 아니라, 실제로 실행 중인 첫 세션으로 포커스
      const firstBusy = [...get().sessions].reverse().find((x) => x.busy)
      if (firstBusy) set({ activeSessionId: firstBusy.id })
    },

    dismissRunOrder: (sessionId) => {
      orderPlanRows.delete(sessionId)
      patch(sessionId, { runOrderProposal: null })
    },
  }
})
