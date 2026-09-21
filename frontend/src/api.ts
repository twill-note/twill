import type {
  BrowseResult,
  FileContent,
  Frontmatter,
  ImportResult,
  NoteLinks,
  NoteMeta,
  NoteRow,
  SearchResult,
  Section,
  TagCount,
  TemplateInfo,
  TodoGroup,
  TreeNode,
  WorkspaceInfo,
} from './types'
import type { ErdDiagram } from './plugins/erd-designer/types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type QuickMemoSaveRequest = {
  content: string
  id: string
  date: string
  captured_at: string
}

export type QuickMemoSaveResult = {
  status: 'SAVED' | 'ALREADY_SAVED' | 'BUSY' | 'CONFLICT' | 'WRITE_FAILED' | 'INVALID_INPUT'
  path: string | null
  date: string | null
  captured_at: string | null
  created: boolean
  success: boolean
}

/** 서버가 현재 워크스페이스에서 실제로 확인한 채팅 내부 문서 링크 대상. */
export type WorkspaceDocumentLinkTarget = {
  kind: 'note' | 'erd'
  path: string
}

export type SkillBookSource = 'app_skill' | 'system_manual'

export type SkillBookSummary = {
  id: string
  name: string
  description: string
  source: SkillBookSource
  read_only: boolean
  entry_file: string
  valid: boolean
}

export type SkillBookComponent = {
  path: string
  kind: 'markdown' | 'text' | 'image' | 'binary' | 'directory'
  size: number
  mtime: number
  read_only: boolean
  editable: boolean
}

export type SkillBookDetail = {
  summary: SkillBookSummary
  components: SkillBookComponent[]
  validation_errors: string[]
}

export type SkillBookContent = {
  id: string
  path: string
  kind: SkillBookComponent['kind']
  size: number
  mtime: number
  read_only: boolean
  editable: boolean
  frontmatter: Record<string, unknown>
  content: string | null
  mime_type: string
  detail?: SkillBookDetail
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') detail = data.detail
      else if (data.detail && typeof data.detail.message === 'string') detail = data.detail.message
      else if (data.detail) detail = JSON.stringify(data.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json()
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  tree: () => request<{ children: TreeNode[] }>('/api/files/tree'),

  /** Codex 경로 표기와 Markdown href를 현재 워크스페이스의 실제 문서로만 확인한다. */
  documentLinkTarget: (href: string) =>
    request<{ target: WorkspaceDocumentLinkTarget | null }>(
      `/api/files/document-link?href=${encodeURIComponent(href)}`,
    ),

  /** 워크스페이스 밖 임의 경로를 트리로 반환 (스코프 브라우저용). */
  treeAt: (path: string, depth = 2) =>
    request<{ root: string; children: TreeNode[] }>(
      `/api/files/tree-at?path=${encodeURIComponent(path)}&depth=${depth}`,
    ),

  /** 스코프 폴더 하위 CRUD (등록된 스코프 안에서만 허용). */
  treeAtScope: (path: string, depth = 3) =>
    request<{ root: string; children: TreeNode[] }>(
      `/api/files/tree-at-scope?path=${encodeURIComponent(path)}&depth=${depth}`,
    ),
  createExternal: (path: string, type: 'file' | 'dir', templateBody = '') =>
    request<{ path: string; type: string }>(
      '/api/files/create-external',
      json('POST', { path, type, template_body: templateBody }),
    ),
  getContentExternal: (path: string) =>
    request<FileContent & { external: true }>(
      `/api/files/content-external?path=${encodeURIComponent(path)}`,
    ),
  saveContentExternal: (path: string, frontmatter: Frontmatter, body: string, mtime: number | null, force = false) =>
    request<{ mtime: number }>('/api/files/content-external', json('PUT', { path, frontmatter, body, mtime, force })),
  deleteExternal: (path: string) =>
    request<{ deleted: string }>(`/api/files/external?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  renameExternal: (path: string, newName: string) =>
    request<{ path: string }>('/api/files/rename-external', json('POST', { path, new_name: newName })),

  createEntry: (path: string, type: 'file' | 'dir', date?: string, template?: string) =>
    request<{ path: string; type: string }>('/api/files', json('POST', { path, type, date, template })),

  getContent: (path: string) =>
    request<FileContent>(`/api/files/content?path=${encodeURIComponent(path)}`),

  saveContent: (path: string, frontmatter: Frontmatter, body: string, mtime: number | null, force = false) =>
    request<{ mtime: number }>('/api/files/content', json('PUT', { path, frontmatter, body, mtime, force })),

  rename: (path: string, newName: string) =>
    request<{ path: string }>('/api/files/rename', json('POST', { path, new_name: newName })),

  move: (path: string, destDir: string) =>
    request<{ path: string }>('/api/files/move', json('POST', { path, dest_dir: destDir })),

  remove: (path: string) =>
    request<{ trashed_to: string }>(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),

  calendar: (year: number, month: number) =>
    request<Record<string, number>>(`/api/notes/calendar?year=${year}&month=${month}`),

  notesByDate: (date: string) => request<NoteMeta[]>(`/api/notes?date=${date}`),

  notesByTag: (tag: string) => request<NoteMeta[]>(`/api/notes?tag=${encodeURIComponent(tag)}`),

  notesDb: (dir: string) => request<NoteRow[]>(`/api/notes/db?dir=${encodeURIComponent(dir)}`),

  search: (q: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),

  tags: () => request<TagCount[]>('/api/tags'),

  reindex: () => request<{ indexed: number }>('/api/reindex', { method: 'POST' }),

  importFiles: (files: File[], destDir: string) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    form.append('dest_dir', destDir)
    return request<ImportResult>('/api/files/import', { method: 'POST', body: form })
  },

  todos: (includeDone = false) => request<TodoGroup[]>(`/api/todos?include_done=${includeDone}`),

  toggleTodo: (path: string, line: number, text: string) =>
    request<{ done: boolean; mtime: number }>('/api/todos/toggle', json('POST', { path, line, text })),

  daily: (date?: string) =>
    request<{ path: string; created: boolean }>('/api/notes/daily', json('POST', { date })),

  quickMemos: {
    save: (payload: QuickMemoSaveRequest) =>
      request<QuickMemoSaveResult>('/api/quick-memos', json('POST', payload)),
  },

  templates: () => request<TemplateInfo[]>('/api/templates'),

  backlinks: (path: string) =>
    request<NoteLinks>(`/api/notes/backlinks?path=${encodeURIComponent(path)}`),

  resolveNote: (name: string) =>
    request<{ path: string | null; title: string | null }>(`/api/notes/resolve?name=${encodeURIComponent(name)}`),

  workspace: () => request<WorkspaceInfo>('/api/workspace'),

  openWorkspace: (path: string) =>
    request<{ root: string; indexed: number }>('/api/workspace/open', json('POST', { path })),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/workspace/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  reveal: (path: string) => request<{ opened: string }>('/api/workspace/reveal', json('POST', { path })),

  uploadAsset: async (file: File): Promise<string> => {
    const form = new FormData()
    form.append('file', file)
    const { url } = await request<{ url: string }>('/api/assets', { method: 'POST', body: form })
    return url
  },

  plugins: {
    list: () => request<{ plugins: PluginInfo[] }>('/api/plugins'),
    install: (id: string) =>
      request<{ id: string; installed: boolean }>(`/api/plugins/${encodeURIComponent(id)}/install`, { method: 'POST' }),
    uninstall: (id: string) =>
      request<{ id: string; installed: boolean }>(`/api/plugins/${encodeURIComponent(id)}/uninstall`, { method: 'POST' }),
  },

  /** ERD 디자이너 코어 API. 다이어그램은 워크스페이스의 어느 폴더에나 저장할 수 있다. */
  erdDesigner: {
    list: () => request<{ diagrams: ErdDiagramSummary[] }>('/api/erd/diagrams'),
    get: (path: string) =>
      request<{ path: string; diagram: ErdDiagram }>(
        `/api/erd/diagrams/content?path=${encodeURIComponent(path)}`,
      ),
    save: (path: string, diagram: ErdDiagram, syncTitle: boolean) =>
      request<{ path: string; diagram: ErdDiagram }>(
        '/api/erd/diagrams/content',
        json('PUT', { path, diagram, sync_title: syncTitle }),
      ),
  },

  workspaceSettings: {
    get: () => request<WorkspaceSettings>('/api/workspace/settings'),
    put: (settings: WorkspaceSettings) =>
      request<WorkspaceSettings>('/api/workspace/settings', json('PUT', settings)),
    resolveScope: (id: string) =>
      request<{ id: string; label: string; path: string; exists: boolean }>(
        `/api/workspace/scope-resolve?id=${encodeURIComponent(id)}`,
      ),
    ensureSpecialNote: (kind: 'agents' | 'memories') =>
      request<{ path: string; created: boolean }>(
        '/api/workspace/ensure-special-note',
        json('POST', { kind }),
      ),
    listScopes: () => request<{ scopes: WorkspaceScopeEntry[] }>('/api/workspace/scopes'),
    addFolder: (path: string, project = '') =>
      request<{ path: string; note_path: string; created: boolean }>(
        '/api/workspace/add-folder',
        json('POST', { path, project }),
      ),
    removeFolder: (path: string) =>
      request<{ path: string; removed: boolean }>(
        '/api/workspace/remove-folder',
        json('POST', { path }),
      ),
    /** 사이드바 프로젝트 (서버의 기존 sections 계약과 호환). */
    getSections: () => request<{ sections: Section[] }>('/api/workspace/sections'),
    putSections: (sections: Section[]) =>
      request<{ sections: Section[] }>(
        '/api/workspace/sections',
        json('PUT', { sections }),
      ),
    createProjectSection: (name: string) =>
      request<{ section: Section }>('/api/workspace/sections/project', json('POST', { name })),
    /** 기존 문서·태스크·대화를 유지한 채 프로젝트의 코드·분석 경로만 연결한다. */
    setProjectPath: (sectionId: string, path: string) =>
      request<{
        section: Section
        path: string
        agents_path: string
        agents_created: boolean
      }>(
        `/api/workspace/sections/${encodeURIComponent(sectionId)}/project-path`,
        json('PUT', { path }),
      ),
    renameProject: (sectionId: string, name: string) =>
      request<{ section: Section }>(
        `/api/workspace/sections/${encodeURIComponent(sectionId)}/name`,
        json('PUT', { name }),
      ),
    /** 프로젝트 관리 행에서 바꾼 이름을 연결된 사이드바 프로젝트에도 반영한다. */
    renameScopeProject: (scopeId: string, name: string) =>
      request<{ section: Section }>(
        `/api/workspace/scopes/${encodeURIComponent(scopeId)}/name`,
        json('PUT', { name }),
      ),
    /** 프로젝트 경로의 실제 AGENTS.md를 보장하고 내부 편집기용 절대 경로를 반환한다. */
    ensureScopeAgents: (scopeId: string) =>
      request<WorkspaceScopeAgents>(
        `/api/workspace/scopes/${encodeURIComponent(scopeId)}/ensure-agents`,
        { method: 'POST' },
      ),
    /** 프로젝트 관리 행 삭제 전, 연결된 섹션·태스크·실행 중 작업 영향을 확인한다. */
    previewScopeDeletion: (scopeId: string) =>
      request<WorkspaceScopeDeletionPreview>(
        `/api/workspace/scopes/${encodeURIComponent(scopeId)}/deletion-preview`,
      ),
    /** 프로젝트 행을 휴지통으로 옮기고 연결된 참조를 서버 트랜잭션으로 해제한다. */
    deleteScope: (scopeId: string) =>
      request<WorkspaceScopeDeletionResult>(
        `/api/workspace/scopes/${encodeURIComponent(scopeId)}`,
        { method: 'DELETE' },
      ),
  },

  skills: {
    list: () => request<{ skills: SkillMeta[] }>('/api/skills'),
    body: (path: string) =>
      request<{ path: string; body: string; name: string }>(
        `/api/skills/${encodeURI(path)}/body`,
      ),
  },

  skillbook: {
    list: (query = '', source: 'all' | SkillBookSource = 'all') => {
      const params = new URLSearchParams()
      if (query.trim()) params.set('query', query.trim())
      if (source !== 'all') params.set('source', source)
      const suffix = params.size ? `?${params.toString()}` : ''
      return request<SkillBookSummary[]>(`/api/skillbook${suffix}`)
    },
    detail: (id: string) =>
      request<SkillBookDetail>(`/api/skillbook/${encodeURIComponent(id)}`),
    content: (id: string, path?: string) =>
      request<SkillBookContent>(
        `/api/skillbook/${encodeURIComponent(id)}/content${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      ),
    saveContent: (
      id: string,
      path: string,
      content: string,
      frontmatter: Record<string, unknown>,
      mtime: number,
    ) =>
      request<SkillBookContent>(
        `/api/skillbook/${encodeURIComponent(id)}/content?path=${encodeURIComponent(path)}`,
        json('PUT', { content, frontmatter, mtime }),
      ),
    replaceAsset: async (id: string, path: string, file: File, mtime: number) => {
      const body = new FormData()
      body.append('file', file)
      body.append('mtime', String(mtime))
      return request<SkillBookContent>(
        `/api/skillbook/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(path)}`,
        { method: 'PUT', body },
      )
    },
    create: (name: string, description: string) =>
      request<SkillBookDetail>('/api/skillbook', json('POST', { name, description })),
    remove: (id: string) =>
      request<{ id: string; trash_path: string }>(
        `/api/skillbook/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    assetUrl: (id: string, path: string) =>
      `/api/skillbook/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(path)}`,
  },

  /** 벼리(오케스트레이터) — 세션·모델·엔진 상태. 실행 스트림은 aiStore 의 WS 가 담당. */
  ai: {
    status: () => request<AiEngineStatus>('/api/ai/status'),
    models: () => request<{ models: AiModel[] }>('/api/ai/models'),
    usageLimits: () => request<AiUsageLimits>('/api/ai/usage-limits'),
    runtimeInfo: () => request<AiRuntimeInfo>('/api/ai/runtime-info'),
    gitMetadataAccess: () => request<AiGitMetadataAccess>('/api/ai/git-metadata-access'),
    setGitMetadataAccess: (enabled: boolean) =>
      request<AiGitMetadataAccess>('/api/ai/git-metadata-access', json('PUT', { enabled })),
    listSessions: () => request<{ sessions: AiSessionMeta[] }>('/api/ai/sessions'),
    createSession: (payload: {
      kind: 'chat' | 'task'
      title?: string
      task_path?: string
      /** 카드에서 시작한 일반 대화의 원본 카드 경로. 태스크 실행은 task_path를 사용한다. */
      source_task_path?: string
      scope_id?: string
      section_id?: string
      model?: string
      effort?: string
    }) => request<AiSessionMeta>('/api/ai/sessions', json('POST', payload)),
    updateSession: (id: string, patch: { title?: string; model?: string | null; effort?: string | null }) =>
      request<AiSessionMeta>(`/api/ai/sessions/${encodeURIComponent(id)}`, json('PATCH', patch)),
    cancelSession: (id: string) =>
      request<{ ok: boolean }>(`/api/ai/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    deleteSessions: () =>
      request<{ deleted: number }>('/api/ai/sessions', { method: 'DELETE' }),
    deleteSession: (id: string) =>
      request<{ deleted: boolean }>(`/api/ai/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 전체 실행 전 — 카드 내용을 보고 AI 가 실행 순서를 결정. */
    planRunOrder: (paths: string[]) =>
      request<{ order: string[]; reason: string; planned_by: 'ai' | 'fallback' | 'trivial' }>(
        '/api/ai/run-order',
        json('POST', { paths }),
      ),
    runWs: (): WebSocket => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      return new WebSocket(`${proto}://${window.location.host}/api/ai/run`)
    },
  },
}

export type AiEngineStatus = {
  available: boolean
  logged_in: boolean
  detail: string
  engine: string | null
}

/** 사용자가 명시적으로 허용한, 이 기기의 Codex Git 메타데이터 쓰기 규칙 상태. */
export type AiGitMetadataAccess = {
  enabled: boolean
  /** 동일 파일을 앱이 안전하게 설치/해제할 수 있는지 여부. */
  managed: boolean
  server_restarted?: boolean
}

export type AiModel = {
  id: string
  model: string
  displayName: string
  description: string
  isDefault: boolean
  defaultEffort: string
  supportedEfforts: string[]
}

export type AiUsageLimitWindow = {
  used_percent: number
  resets_at: number | null
  window_duration_mins: number | null
}

/** Codex app-server가 계정 기준으로 반환하는 5시간·주간 사용량 스냅샷. */
export type AiUsageLimits = {
  available: boolean
  blocked: boolean
  reached_type: string | null
  plan_type: string | null
  primary: AiUsageLimitWindow | null
  secondary: AiUsageLimitWindow | null
  reason?: string
}

export type AiRuntimePrompt = {
  id: string
  stage: string
  title: string
  source: string
  included: boolean
  content: string
}

export type AiRuntimeInfo = {
  common_instructions: string
  prompts: AiRuntimePrompt[]
  conditional_inputs: Array<{ title: string; when: string; description: string }>
  tooling: {
    engine: { id: string | null; name: string }
    items: Array<{ title: string; value: string; description: string }>
  }
}

export type AiSessionMeta = {
  id: string
  kind: 'chat' | 'task'
  title: string
  task_path: string | null
  /** 카드에서 시작한 세션에만 있는 불변 출처 스냅샷. 과거/일반 세션에는 없다. */
  source_task?: AiTaskSource | null
  /** 서버가 최신 카드 위치를 해석해 덧붙이는 표시용 상태. */
  source_task_status?: AiTaskSourceStatus | null
  scope_id: string | null
  /** 삭제된 프로젝트를 쓰던 과거 세션의 표시용 마지막 프로젝트 이름. 새 실행에는 사용하지 않는다. */
  last_scope_label?: string | null
  section_id?: string | null
  thread_id: string | null
  engine_id: string | null
  model: string | null
  effort: string | null
  created_at: number
  updated_at: number
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    ts: number
    images?: Array<{ url: string; name?: string; alt?: string }>
  }>
  /** 서버가 브라우저 연결과 무관하게 계속 수행 중인 태스크 실행. */
  active_run?: AiSessionActiveRun | null
  /** 태스크 카드에서 읽어온 현재 배치·상태 메타. */
  task_status?: string
  batch_id?: string
  batch_order?: number
  last_run?: AiSessionLastRun | null
  memory_saved?: AiMemorySaveResult | null
  memory_error?: { run_id: string; message: string } | null
}

export type AiMemorySaveResult = {
  saved: boolean
  already_saved?: boolean
  run_id: string
  bullets: string[]
  path: string | null
}

export type AiTaskSource = {
  card_id: string
  /** 대화를 시작한 당시의 카드 경로·제목 — 삭제 뒤에도 유지된다. */
  path: string
  title: string
  /** 마지막으로 카드가 존재했을 때의 위치·제목. */
  last_path?: string
  last_title?: string
  scope_id?: string | null
  section_id?: string | null
}

export type AiTaskSourceStatus = {
  state: 'available' | 'deleted'
  /** available일 때만 현재 카드 경로. */
  path: string | null
  /** available이면 최신 제목, deleted이면 마지막으로 확인한 제목. */
  title: string
  /** 최신 카드/섹션으로 다시 해석한 프로젝트. 세션의 고정 스냅샷과는 별개다. */
  scope_id?: string | null
  section_id?: string | null
  /** 최신 카드 프로젝트와 세션 시작 시 고정한 프로젝트가 다른지. */
  scope_mismatch?: boolean
  /** 최신 카드의 프로젝트를 해석할 수 없을 때의 해결 안내. */
  scope_error?: string | null
}

export type AiSessionActiveRun = {
  run_id: string
  /** 일반 채팅 실행에는 대상 태스크가 없다. */
  task_path: string | null
  started_at: number
  run_log_path: string | null
}

export type AiSessionLastRun = {
  run_id: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  message: string
  run_log_path: string | null
  task_path: string
  task_status: string
  completed_at: number
}

export type SkillMeta = {
  path: string
  name: string
  aliases: string[]
  description: string
  draft: boolean
}

export type WorkspaceScope = {
  id: string
  label: string
  path: string
}

/** /api/workspace/scopes 통합 목록 항목 (SCOPES DB + 레거시 .workspace.json). */
export type WorkspaceScopeEntry = {
  id: string
  label: string
  path: string
  has_path: boolean
  project: string
  note_path: string
}

export type WorkspaceScopeAgents = {
  scope_id: string
  label: string
  path: string
  created: boolean
  internal?: boolean
}

export type WorkspaceScopeDeletionPreview = {
  scope_id: string
  label: string
  section_count: number
  task_count: number
  active_task_count: number
  blocking_tasks: Array<{ path: string; title: string; state: string }>
  can_delete: boolean
}

export type WorkspaceScopeDeletionResult = {
  scope_id: string
  label: string
  trashed_to: string
  sections_removed: number
  task_scopes_released: number
  sessions_released: number
}

export type WorkspaceCodexDefaults = {
  instructions_ref: string
  memories_ref: string
  default_model: string
  default_effort: string
}

export type WorkspaceSettings = {
  name: string
  scopes: WorkspaceScope[]
  codex: WorkspaceCodexDefaults
  explorer: {
    show_all_files: boolean
  }
}

export type PluginInfo = {
  id: string
  name: string
  version: string
  description: string
  permissions: string[]
  ui: {
    rightPanel?: { id: string; title: string; icon?: string }
    selectionActions?: Array<{ id: string; label: string; icon?: string }>
    slashItems?: Array<{ id: string; title: string; aliases?: string[] }>
    commands?: Array<{ id: string; title: string }>
  }
  installed: boolean
}

export type ErdDiagramSummary = {
  path: string
  title: string
  dialect: 'mariadb' | 'postgres' | 'mysql' | 'sqlite' | 'generic'
  updated: number
  tables: number
  relations: number
}
