import { create } from 'zustand'
import { useAiStore } from './aiStore'
import { aiDocumentTab, aiDocumentTabId, sessionIdFromAiTab } from './aiTabs'
import { api } from './api'
import type { PluginInfo } from './api'
import type { SaveStatus, Section, TagCount, TreeNode, ViewMode } from './types'

export const SYSTEM_TERMINAL_TAB = 'system:terminal'
/** 벼리(AI) 시스템 탭 — 구 '실행'(system:runs) 탭과 플러그인 챗 탭을 통합. */
export const SYSTEM_AI_TAB = 'system:ai'

/** 상단 문서 탭 (VSCode/Obsidian/Notion 스타일). */
export type DocTab = {
  /** 유니크 id — kind:target 형태 (file:foo.md, db:tasks, view:calendar) */
  id: string
  kind: 'file' | 'erd' | 'db' | 'view' | 'ai'
  /** 파일 경로, DB 폴더 경로, 또는 뷰 이름 */
  target: string
  title: string
  icon: string
  /** ERD 탭에만 있는 실제 저장 경로. 새 다이어그램은 저장 전까지 null 이다. */
  erdPath?: string | null
  /** 새 ERD의 초기 저장 제안 폴더. */
  erdDirectory?: string | null
}

interface AppState {
  tree: TreeNode[]
  sections: Section[]
  tags: TagCount[]
  currentPath: string | null
  view: ViewMode
  saveStatus: SaveStatus
  paletteOpen: boolean
  tagFilter: string | null
  root: string | null
  recent: string[]
  /** 우측 도크 개폐 여부 (구 terminalOpen 을 대체). */
  rightDockOpen: boolean
  /** 우측 도크에서 현재 활성화된 탭 id (system:terminal 또는 플러그인이 등록한 tab id). */
  activeRightTab: string
  /** Electron에서 벼리 패널이 독립 BrowserWindow로 이동한 상태. */
  byeoriDetached: boolean
  aiTabId: string | null
  dockedAiTabId: string | null
  dockedAiTabs: DocTab[]
  closeDockedAiTab: (tabId: string) => void
  openAiSession: (sessionId: string) => void
  moveAi: (location: 'editor' | 'right', tabId?: string) => void
  dbDir: string | null
  /** 완료 요약 등에서 특정 카드 집합만 바로 검토할 때 쓰는 일시적 DB 행 필터. */
  dbRowFilter: string[] | null
  /** `view === 'plugin'`일 때 렌더할 플러그인 전용 작업 화면 id. */
  pluginViewId: string | null
  /** 코어 ERD 디자이너가 열 파일. null이면 새 다이어그램을 시작한다. */
  erdPath: string | null
  /** 새 ERD의 기본 저장 폴더. */
  erdDirectory: string | null
  /** 현재 선택된 ERD 문서 탭 id. 분할 패널 안의 ERD를 활성화할 때 사용한다. */
  erdTabId: string | null
  /** 같은 폴더에서 새 ERD를 다시 시작할 때 Workspace를 새로 초기화하는 요청 번호. */
  erdNewRequest: number
  plugins: PluginInfo[]
  /** 상단 문서 탭 목록 (열려있는 문서/DB/뷰). */
  openTabs: DocTab[]

  loadWorkspace: () => Promise<void>
  openWorkspace: (path: string) => Promise<void>
  openToday: () => Promise<void>
  refreshTree: () => Promise<void>
  refreshTags: () => Promise<void>
  refreshSections: () => Promise<void>
  saveSections: (sections: Section[]) => Promise<void>
  openFile: (path: string) => void
  restoreFromHistory: (path: string | null) => void
  closeFile: () => void
  setView: (view: ViewMode) => void
  setSaveStatus: (s: SaveStatus) => void
  setPaletteOpen: (open: boolean) => void
  setTagFilter: (tag: string | null) => void
  setRightDockOpen: (open: boolean) => void
  toggleRightDock: () => void
  setActiveRightTab: (id: string) => void
  setByeoriDetached: (detached: boolean) => void
  openRightTab: (id: string) => void
  refreshPlugins: () => Promise<void>
  /** 설치된 플러그인이 등록한 전용 작업 화면을 연다. */
  openPluginView: (id: string) => void
  /** 코어 ERD 디자이너를 연다. 파일 트리의 ERD를 선택하면 해당 파일을 다시 연다. */
  openErdDesigner: (path?: string | null, directory?: string | null) => void
  /** 지정한 폴더에서 새 ERD 설계를 시작한다. */
  createErdDiagram: (directory?: string | null) => void
  /** 분할 패널의 ERD 탭을 활성화한다. */
  activateErdTab: (tabId: string) => void
  /** 저장된 ERD의 경로와 탭 제목을 갱신한다. */
  updateErdTab: (tabId: string, path: string) => void
  openDatabase: (dir: string, rowPaths?: string[]) => void
  closeTab: (id: string) => void
  /** 상단 탭 드래그앤드롭 정렬 — fromId 탭을 toId 탭 앞으로 이동 (toId=null 이면 맨 뒤). */
  reorderTabs: (fromId: string, toId: string | null) => void
  /** 상단바에 고정된 노트 경로들 (자주 쓰는 노트 바로가기, 워크스페이스별 localStorage 저장). */
  pinnedNotes: string[]
  togglePinnedNote: (path: string) => void
  /** 탭 없는 토글 뷰(태스크 보드·프로젝트 관리·캘린더·할일)를 닫고 직전 화면으로 복귀. */
  closeBoardView: () => void
}

/** 상단바 고정 버튼으로 여닫는 보드 — 문서 탭을 만들지 않는다 (우측 도크 토글과 동일한 개념). */
const NO_TAB_BOARD_DIRS = new Set(['tasks', 'scopes'])

/** 탭 없는 토글 뷰(보드·캘린더·할일)를 열기 직전의 화면 (닫을 때 복귀 목적지). */
let boardReturnState: {
  view: ViewMode
  currentPath: string | null
  dbDir: string | null
  pluginViewId: string | null
  erdPath: string | null
  erdDirectory: string | null
  erdTabId: string | null
} | null = null

/** 지금이 상단바 토글 뷰(태스크 보드·프로젝트 관리·캘린더·할일) 화면인지. */
function isToggleViewState(view: ViewMode, dbDir: string | null): boolean {
  // ERD는 일반 문서처럼 분할 패널 안에서 여는 탭이다. 전체 화면 토글 뷰로 취급하지 않는다.
  if (view === 'calendar' || view === 'todos' || view === 'skillbook' || view === 'plugin') return true
  return view === 'database' && NO_TAB_BOARD_DIRS.has(dbDir ?? '')
}

export const useAppStore = create<AppState>((set, get) => ({
  tree: [],
  sections: [],
  tags: [],
  currentPath: null,
  view: 'editor',
  saveStatus: 'idle',
  paletteOpen: false,
  tagFilter: null,
  root: null,
  recent: [],
  rightDockOpen: false,
  activeRightTab: SYSTEM_TERMINAL_TAB,
  byeoriDetached: false,
  aiTabId: null,
  dockedAiTabId: SYSTEM_AI_TAB,
  dockedAiTabs: [aiDocumentTab(SYSTEM_AI_TAB)],
  closeDockedAiTab: (tabId) => {
    const state = get()
    const tabs = state.dockedAiTabs.filter((tab) => tab.id !== tabId)
    set({ dockedAiTabs: tabs, dockedAiTabId: state.dockedAiTabId === tabId ? tabs.at(-1)?.id ?? null : state.dockedAiTabId,
      ...(tabs.length === 0 && state.activeRightTab === SYSTEM_AI_TAB ? { rightDockOpen: false } : {}) })
  },
  openAiSession: (sessionId) => {
    if (!useAiStore.getState().sessions.some((session) => session.id === sessionId)) return
    const tabId = aiDocumentTabId(sessionId)
    get().moveAi(get().openTabs.some((tab) => tab.id === tabId) ? 'editor' : 'right', tabId)
    // The empty AI entry is replaced by the first real conversation.
    get().closeTab(SYSTEM_AI_TAB)
  },
  moveAi: (location, requestedTabId) => {
    const state = get()
    const tabId = requestedTabId ?? state.aiTabId ?? state.dockedAiTabId ?? SYSTEM_AI_TAB
    const sessionId = sessionIdFromAiTab(tabId)
    const session = useAiStore.getState().sessions.find((item) => item.id === sessionId)
    if (sessionId && !session) return
    useAiStore.setState({ activeSessionId: sessionId })
    const tab = aiDocumentTab(tabId, session?.title)
    if (location === 'editor') {
      const fromDock = state.dockedAiTabId === tabId
      const dockedAiTabs = state.dockedAiTabs.filter((item) => item.id !== tabId)
      set({ openTabs: upsertTab(state.openTabs, tab), aiTabId: tabId, view: 'ai',
        dockedAiTabs,
        ...(fromDock ? { dockedAiTabId: dockedAiTabs.at(-1)?.id ?? null, ...(dockedAiTabs.length === 0 && state.activeRightTab === SYSTEM_AI_TAB ? { rightDockOpen: false } : {}) } : {}) })
    } else {
      const openTabs = state.openTabs.filter((item) => item.id !== tabId)
      const dockedAiTabs = upsertTab(state.dockedAiTabs.filter((item) => !sessionId || item.id !== SYSTEM_AI_TAB), tab)
      set({ openTabs, dockedAiTabs, dockedAiTabId: tabId, rightDockOpen: true, activeRightTab: SYSTEM_AI_TAB,
        ...(state.aiTabId === tabId ? { aiTabId: null, ...(state.view === 'ai' ? { view: 'editor' } : {}) } : {}) })
    }
  },
  dbDir: null,
  dbRowFilter: null,
  pluginViewId: null,
  erdPath: null,
  erdDirectory: null,
  erdTabId: null,
  erdNewRequest: 0,
  plugins: [],
  openTabs: [],

  loadWorkspace: async () => {
    const info = await api.workspace()
    set({ root: info.root, recent: info.recent, pinnedNotes: loadPinnedNotes(info.root) })
  },
  pinnedNotes: [],
  togglePinnedNote: (path) => {
    set((s) => {
      const pinnedNotes = s.pinnedNotes.includes(path)
        ? s.pinnedNotes.filter((p) => p !== path)
        : [...s.pinnedNotes, path]
      savePinnedNotes(s.root, pinnedNotes)
      return { pinnedNotes }
    })
  },
  openWorkspace: async (path) => {
    await api.openWorkspace(path)
    set({ currentPath: null, tagFilter: null, saveStatus: 'idle', view: 'editor', pluginViewId: null, erdPath: null, erdDirectory: null, erdTabId: null, erdNewRequest: 0 })
    await Promise.all([get().loadWorkspace(), get().refreshTree(), get().refreshTags(), get().refreshSections()])
  },
  openToday: async () => {
    const { path, created } = await api.daily()
    if (created) await get().refreshTree()
    get().openFile(path)
  },

  refreshTree: async () => {
    const { children } = await api.tree()
    set({ tree: children })
  },
  refreshTags: async () => {
    set({ tags: await api.tags() })
  },
  refreshSections: async () => {
    const { sections } = await api.workspaceSettings.getSections()
    set({ sections })
  },
  saveSections: async (sections) => {
    set({ sections })  // 옵티미스틱
    try {
      const { sections: saved } = await api.workspaceSettings.putSections(sections)
      set({ sections: saved })
    } catch {
      // 실패 시 원복
      await get().refreshSections()
    }
  },
  openFile: (path) => {
    // path 는 워크스페이스 상대 경로("foo.md") 또는 절대 경로("/Users/.../bar.md") 둘 다 허용.
    // 절대경로는 스코프 폴더 내부 파일로 취급 — 에디터가 external endpoint 로 로드/저장.
    const s = get()
    const isSame = s.view === 'editor' && s.currentPath === path
    if (!isSame) {
      window.history.pushState({ notePath: path }, '', '#' + encodeURIComponent(path))
    }
    const title = path.split('/').pop()?.replace(/\.md$/, '') ?? path
    const tab: DocTab = { id: `file:${path}`, kind: 'file', target: path, title, icon: '📄' }
    const openTabs = upsertTab(s.openTabs, tab)
    set({ currentPath: path, view: 'editor', saveStatus: 'idle', pluginViewId: null, erdPath: null, erdDirectory: null, erdTabId: null, openTabs })
  },
  restoreFromHistory: (path) => {
    // hash 가 db:<dir> 형태이면 DB 뷰 복원, todos/calendar 이면 그 뷰, 그 외는 편집기+노트
    if (!path) {
      set({ currentPath: null, view: 'editor' })
      return
    }
    if (path.startsWith('db:')) {
      set({ view: 'database', dbDir: path.slice(3) || null, dbRowFilter: null })
      return
    }
    if (path === 'view:calendar') {
      set({ view: 'calendar' })
      return
    }
    if (path === 'view:todos') {
      set({ view: 'todos' })
      return
    }
    if (path === 'view:skillbook') {
      set({ view: 'skillbook' })
      return
    }
    if (path.startsWith('view:plugin:')) {
      const pluginViewId = path.slice('view:plugin:'.length)
      if (pluginViewId) set({ view: 'plugin', pluginViewId, currentPath: null })
      return
    }
    if (path === 'view:erd' || path.startsWith('view:erd:')) {
      const erdPath = path.startsWith('view:erd:') ? path.slice('view:erd:'.length) || null : null
      const erdDirectory = erdPath ? erdPath.split('/').slice(0, -1).join('/') || null : null
      set((state) => {
        const existing = erdPath ? state.openTabs.find((tab) => tab.kind === 'erd' && tab.erdPath === erdPath) : undefined
        const tab: DocTab = existing ?? {
          id: `erd:${erdPath ?? `new:${createTabId()}`}`,
          kind: 'erd',
          target: erdPath ?? '새 ERD',
          title: erdTitle(erdPath),
          icon: '🗺️',
          erdPath,
          erdDirectory,
        }
        return {
          view: 'erd', erdPath, erdDirectory, erdTabId: tab.id, currentPath: null,
          erdNewRequest: state.erdNewRequest + 1, openTabs: upsertTab(state.openTabs, tab),
        }
      })
      return
    }
    set({ currentPath: path, view: 'editor', saveStatus: 'idle' })
  },
  closeFile: () => set({ currentPath: null }),
  setView: (view) => {
    // calendar/todos 진입도 히스토리에 기록해서 뒤로가기 자연스럽게.
    // 이 둘은 상단바 토글 뷰 — 문서 탭을 만들지 않고, 진입 전 화면을 복귀 목적지로 기억.
    const s = get()
    if (view !== s.view && (view === 'calendar' || view === 'todos' || view === 'skillbook')) {
      if (!isToggleViewState(s.view, s.dbDir)) {
        boardReturnState = {
          view: s.view, currentPath: s.currentPath, dbDir: s.dbDir, pluginViewId: s.pluginViewId,
          erdPath: s.erdPath, erdDirectory: s.erdDirectory,
          erdTabId: s.erdTabId,
        }
      }
      window.history.pushState({ notePath: `view:${view}` }, '', '#' + encodeURIComponent(`view:${view}`))
    }
    set({ view })
  },
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setRightDockOpen: (rightDockOpen) => set({ rightDockOpen }),
  toggleRightDock: () => set({ rightDockOpen: !get().rightDockOpen }),
  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),
  setByeoriDetached: (byeoriDetached) => set({ byeoriDetached }),
  openRightTab: (id) => {
    const selectedSessionId = useAiStore.getState().activeSessionId
    const selectedAiTabId = selectedSessionId ? aiDocumentTabId(selectedSessionId) : SYSTEM_AI_TAB
    if (id === SYSTEM_AI_TAB && get().byeoriDetached && get().dockedAiTabId === selectedAiTabId && window.noteDesktop) {
      void window.noteDesktop.focusByeoriWindow()
      return
    }
    if (id === SYSTEM_AI_TAB) {
      const tabId = selectedAiTabId
      if (get().dockedAiTabId !== tabId) {
        // Restored sessions have no editor placement yet. Open them in the dock;
        // only focus the editor when this conversation already has a document tab.
        const alreadyInEditor = get().openTabs.some((tab) => tab.id === tabId)
        get().moveAi(alreadyInEditor ? 'editor' : 'right', tabId)
        return
      }
    }
    set({ rightDockOpen: true, activeRightTab: id })
  },
  refreshPlugins: async () => {
    const { plugins } = await api.plugins.list()
    set({ plugins })
  },
  openPluginView: (id) => {
    const s = get()
    const isSame = s.view === 'plugin' && s.pluginViewId === id
    if (!isSame) {
      if (!isToggleViewState(s.view, s.dbDir)) {
        boardReturnState = {
          view: s.view, currentPath: s.currentPath, dbDir: s.dbDir, pluginViewId: s.pluginViewId,
          erdPath: s.erdPath, erdDirectory: s.erdDirectory, erdTabId: s.erdTabId,
        }
      }
      const key = `view:plugin:${id}`
      window.history.pushState({ notePath: key }, '', '#' + encodeURIComponent(key))
    }
    set({ view: 'plugin', pluginViewId: id, currentPath: null, dbRowFilter: null })
  },
  openErdDesigner: (path = null, directory = null) => {
    const s = get()
    const erdPath = path || null
    const erdDirectory = directory ?? (erdPath ? erdPath.split('/').slice(0, -1).join('/') || null : null)
    const existing = erdPath ? s.openTabs.find((tab) => tab.kind === 'erd' && tab.erdPath === erdPath) : undefined
    const tab: DocTab = existing ?? {
      id: `erd:${erdPath ?? `new:${createTabId()}`}`,
      kind: 'erd',
      target: erdPath ?? '새 ERD',
      title: erdTitle(erdPath),
      icon: '🗺️',
      erdPath,
      erdDirectory,
    }
    const isSame = s.view === 'erd' && s.erdTabId === tab.id
    if (!isSame) {
      if (!isToggleViewState(s.view, s.dbDir)) {
        boardReturnState = {
          view: s.view, currentPath: s.currentPath, dbDir: s.dbDir, pluginViewId: s.pluginViewId,
          erdPath: s.erdPath, erdDirectory: s.erdDirectory, erdTabId: s.erdTabId,
        }
      }
      const key = erdPath ? `view:erd:${erdPath}` : 'view:erd'
      window.history.pushState({ notePath: key }, '', '#' + encodeURIComponent(key))
    }
    set({
      view: 'erd', erdPath, erdDirectory, erdTabId: tab.id, currentPath: null, dbRowFilter: null,
      pluginViewId: null, openTabs: upsertTab(s.openTabs, tab),
    })
  },
  createErdDiagram: (directory = null) => get().openErdDesigner(null, directory),
  activateErdTab: (tabId) => {
    const tab = get().openTabs.find((item) => item.id === tabId && item.kind === 'erd')
    if (!tab) return
    const s = get()
    if (!(s.view === 'erd' && s.erdTabId === tab.id)) {
      const key = tab.erdPath ? `view:erd:${tab.erdPath}` : 'view:erd'
      window.history.pushState({ notePath: key }, '', '#' + encodeURIComponent(key))
    }
    set({
      view: 'erd', currentPath: null, erdTabId: tab.id, erdPath: tab.erdPath ?? null,
      erdDirectory: tab.erdDirectory ?? null, dbRowFilter: null, pluginViewId: null,
    })
  },
  updateErdTab: (tabId, path) => {
    const before = get()
    if (before.erdTabId === tabId) {
      const key = `view:erd:${path}`
      window.history.replaceState({ notePath: key }, '', '#' + encodeURIComponent(key))
    }
    set((s) => {
      const current = s.openTabs.find((tab) => tab.id === tabId && tab.kind === 'erd')
      if (!current) return {}
      const erdDirectory = path.split('/').slice(0, -1).join('/') || null
      const openTabs = s.openTabs.map((tab) => tab.id === tabId
        ? { ...tab, target: path, title: erdTitle(path), erdPath: path, erdDirectory }
        : tab)
      return {
        openTabs,
        ...(s.erdTabId === tabId ? { erdPath: path, erdDirectory } : {}),
      }
    })
  },
  openDatabase: (dbDir, rowPaths) => {
    const s = get()
    const key = `db:${dbDir}`
    const isSame = s.view === 'database' && s.dbDir === dbDir
    const noTab = NO_TAB_BOARD_DIRS.has(dbDir)
    if (!isSame) {
      // 탭 없는 보드로 들어갈 때는 복귀 목적지를 기억 (보드 → 보드 이동 시에는 최초 것 유지)
      if (noTab && !(s.view === 'database' && NO_TAB_BOARD_DIRS.has(s.dbDir ?? ''))) {
        boardReturnState = {
          view: s.view, currentPath: s.currentPath, dbDir: s.dbDir, pluginViewId: s.pluginViewId,
          erdPath: s.erdPath, erdDirectory: s.erdDirectory, erdTabId: s.erdTabId,
        }
      }
      window.history.pushState({ notePath: key }, '', '#' + encodeURIComponent(key))
    }
    const title = dbDir || '전체 노트'
    const tab: DocTab = { id: `db:${dbDir}`, kind: 'db', target: dbDir, title, icon: '📊' }
    // 태스크 보드·프로젝트 관리는 상단바 고정 버튼으로 여닫는 뷰 — 문서 탭을 만들지 않는다
    const openTabs = noTab ? s.openTabs : upsertTab(s.openTabs, tab)
    set({ view: 'database', dbDir, dbRowFilter: rowPaths?.length ? rowPaths : null, erdTabId: null, openTabs })
  },
  closeBoardView: () => {
    const s = get()
    if (!isToggleViewState(s.view, s.dbDir)) return
    const back = boardReturnState
    boardReturnState = null
    if (back && !isToggleViewState(back.view, back.dbDir)) {
      if (back.view === 'ai') return get().moveAi('editor')
      if (back.view === 'editor' && back.currentPath) return get().openFile(back.currentPath)
      if (back.view === 'database' && back.dbDir != null) return get().openDatabase(back.dbDir)
      if (back.view === 'calendar' || back.view === 'todos' || back.view === 'skillbook') return get().setView(back.view)
      if (back.view === 'plugin' && back.pluginViewId) {
        set({ view: 'plugin', pluginViewId: back.pluginViewId, currentPath: null })
        return
      }
      if (back.view === 'erd') {
        set({ view: 'erd', erdPath: back.erdPath, erdDirectory: back.erdDirectory, erdTabId: back.erdTabId, currentPath: null })
        return
      }
    }
    // 복귀 목적지가 없으면 열린 탭 중 첫 번째로, 그것도 없으면 빈 화면
    const first = s.openTabs[0]
    if (first) {
      if (first.kind === 'file') return get().openFile(first.target)
      if (first.kind === 'db') return get().openDatabase(first.target)
      if (first.kind === 'ai') return get().moveAi('editor', first.id)
      return get().setView(first.target as ViewMode)
    }
    set({ view: 'editor', currentPath: null, pluginViewId: null, erdPath: null, erdDirectory: null, erdTabId: null })
  },
  closeTab: (id) => {
    const s = get()
    const idx = s.openTabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const closingTab = s.openTabs[idx]
    const openTabs = s.openTabs.filter((t) => t.id !== id)
    // 닫는 탭이 현재 활성 탭이면 인접 탭으로 스위치
    const activeId = currentActiveTabId(s)
    if (id === s.aiTabId) set({ aiTabId: null })
    if (closingTab.id === activeId) {
      const availableTabs = openTabs.filter((tab) => tab.kind !== 'ai' || !tab.target || useAiStore.getState().sessions.some((session) => session.id === tab.target))
      const next = availableTabs[Math.max(0, idx - 1)] ?? availableTabs[0]
      if (next) {
        set({ openTabs })
        // 뷰 상태를 next 로 전환
        if (next.kind === 'file') set({ currentPath: next.target, view: 'editor' })
        else if (next.kind === 'ai') get().moveAi('editor', next.id)
        else if (next.kind === 'erd') {
          set({ openTabs })
          get().activateErdTab(next.id)
        } else if (next.kind === 'db') set({ view: 'database', dbDir: next.target })
        else if (next.kind === 'view') set({ view: next.target as ViewMode })
      } else {
        // 모두 닫힘 → EmptyState 로
        set({ openTabs, currentPath: null, view: 'editor' })
      }
    } else {
      set({ openTabs })
    }
  },
  reorderTabs: (fromId, toId) => {
    if (fromId === toId) return
    set((s) => {
      const tabs = [...s.openTabs]
      const fromIdx = tabs.findIndex((t) => t.id === fromId)
      if (fromIdx < 0) return {}
      const [moved] = tabs.splice(fromIdx, 1)
      const toIdx = toId ? tabs.findIndex((t) => t.id === toId) : -1
      if (toIdx < 0) tabs.push(moved)
      else tabs.splice(toIdx, 0, moved)
      return { openTabs: tabs }
    })
  },
}))

/** 상단바 고정 노트 — 워크스페이스(root)별로 localStorage 에 저장. */
const PINNED_NOTES_KEY = 'pinned-notes'

function loadPinnedNotes(root: string | null): string[] {
  if (!root) return []
  try {
    const all = JSON.parse(localStorage.getItem(PINNED_NOTES_KEY) ?? '{}')
    return Array.isArray(all[root]) ? all[root].filter((p: unknown) => typeof p === 'string') : []
  } catch {
    return []
  }
}

function savePinnedNotes(root: string | null, paths: string[]) {
  if (!root) return
  try {
    const all = JSON.parse(localStorage.getItem(PINNED_NOTES_KEY) ?? '{}')
    all[root] = paths
    localStorage.setItem(PINNED_NOTES_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

/** 탭 목록에 upsert. 이미 같은 id 가 있으면 그대로 두고 순서 유지. */
function upsertTab(tabs: DocTab[], tab: DocTab): DocTab[] {
  if (tabs.some((t) => t.id === tab.id)) return tabs
  return [...tabs, tab]
}

function createTabId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
}

function erdTitle(path: string | null): string {
  return path?.split('/').pop()?.replace(/\.erd\.json$/, '') ?? '새 ERD'
}

/** 현재 뷰 상태로부터 활성 탭 id 계산. */
function currentActiveTabId(s: AppState): string | null {
  if (s.view === 'ai') return s.aiTabId
  if (s.view === 'editor' && s.currentPath) return `file:${s.currentPath}`
  if (s.view === 'database') return `db:${s.dbDir ?? ''}`
  if (s.view === 'erd') return s.erdTabId
  if (s.view === 'calendar' || s.view === 'todos' || s.view === 'skillbook') return `view:${s.view}`
  return null
}

/** 외부에서 활성 탭 id 를 얻기 위한 헬퍼. */
export function activeTabId(s: Pick<AppState, 'view' | 'currentPath' | 'dbDir' | 'erdTabId' | 'aiTabId'>): string | null {
  if (s.view === 'ai') return s.aiTabId
  if (s.view === 'editor' && s.currentPath) return `file:${s.currentPath}`
  if (s.view === 'database') return `db:${s.dbDir ?? ''}`
  if (s.view === 'erd') return s.erdTabId
  if (s.view === 'calendar' || s.view === 'todos' || s.view === 'skillbook') return `view:${s.view}`
  return null
}

