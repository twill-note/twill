export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir' | 'erd' | 'other'
  icon?: string
  /** true 이면 이 노드는 DB 폴더 (자식들은 DB 뷰에서만 표시됨). */
  db?: boolean
  /** 워크스페이스 루트의 특별 노트 마커. UI 배지 및 orchestrator 자동 주입 대상 식별. */
  special?: 'agents' | 'memories'
  children?: TreeNode[]
}

/** 사이드바 프로젝트. 기존 sections 저장 형식은 호환을 위해 유지한다. */
export interface Section {
  id: string
  name: string
  expanded: boolean
  /** 워크스페이스 루트 직계 항목의 경로 (파일 또는 폴더). */
  items: string[]
  /** 섹션 생성 시 자동으로 등록되는 프로젝트 관리(스코프) 노트의 id.
   *  스코프의 실제 경로(path)는 사용자가 프로젝트 관리에서 직접 채워야 함 (자동 주입 아님). */
  scope_id?: string | null
  /** 연결된 코드·분석 폴더. null이면 문서 전용 프로젝트이며 오류 상태가 아니다. */
  project_path?: string | null
}

export interface Frontmatter {
  title: string
  date: string | null
  tags: string[]
  icon?: string | null
  cover?: string | null
  /** 앱이 모르는 frontmatter 키 — 저장 시 그대로 보존 */
  extra?: Record<string, unknown>
}

export interface FileContent {
  path: string
  frontmatter: Frontmatter
  body: string
  mtime: number
}

export interface NoteMeta {
  path: string
  title: string
  date: string | null
  tags: string[]
}

export interface SearchResult extends NoteMeta {
  snippet: string
}

export interface TagCount {
  tag: string
  count: number
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'
/** `erd`는 플러그인 설치와 무관하게 제공되는 기본 DB 설계 화면이다. */
export type ViewMode = 'ai' | 'editor' | 'calendar' | 'todos' | 'skillbook' | 'database' | 'plugin' | 'erd'

export interface NoteRow {
  path: string
  title: string
  date: string | null
  tags: string[]
  icon: string
  props: Record<string, unknown>
  updated_at: number
}

export interface TodoItem {
  line: number
  text: string
  done: boolean
}

export interface TodoGroup {
  path: string
  title: string
  date: string | null
  items: TodoItem[]
}

export interface OutgoingLink {
  target: string
  path: string | null
  title: string
}

export interface NoteLinks {
  incoming: NoteMeta[]
  outgoing: OutgoingLink[]
  children: NoteMeta[]
}

export interface TemplateInfo {
  name: string
  path: string
}

export interface WorkspaceInfo {
  root: string
  recent: string[]
  home: string
}

export interface BrowseResult {
  path: string
  parent: string | null
  home: string
  dirs: { name: string; path: string }[]
}

export interface ImportResult {
  created: string[]
  skipped: string[]
}
