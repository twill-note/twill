import AiPlacement from './components/AiPlacement'
import CodexUpdateNotice from './components/CodexUpdateNotice'
import { useEffect } from 'react'
import AiToasts from './components/AiToasts'
import CalendarView from './components/CalendarView'
import CommandPalette from './components/CommandPalette'
import DatabaseView from './components/DatabaseView'
import DialogHost from './components/Dialog'
import DesktopTitleBar from './components/DesktopTitleBar'
import DesktopTooltip from './components/DesktopTooltip'
import RightDock from './components/RightDock'
import Sidebar from './components/Sidebar'
import SkillBookView from './components/SkillBookView'
import SplitEditor from './components/SplitEditor'
import TabBar from './components/TabBar'
import TodoView from './components/TodoView'
import { initPlugins } from './plugins/manager'
import { dbApi } from './dbschema'
import { actionForEvent, type ShortcutAction } from './shortcuts'
import { useAiStore } from './aiStore'
import { SYSTEM_AI_TAB, useAppStore } from './store'
import { useTranslation } from 'react-i18next'
import { tr } from './i18n'

export default function App() {
  // Subscribe at the application root so source-keyed copy in all child screens refreshes on language changes.
  useTranslation()
  const { view, root, workspaceReady, refreshTree, setPaletteOpen, openToday, openRightTab, refreshPlugins } = useAppStore()

  useEffect(() => {
    refreshTree().catch(() => {
      /* 백엔드 미기동 시 EmptyState 안내 */
    })
  }, [refreshTree])

  useEffect(() => {
    // 설치 상태인 built-in 플러그인의 프론트 확장을 로드
    initPlugins()
      .then(() => refreshPlugins().catch(() => {}))
      .catch(() => {})
  }, [refreshPlugins])

  useEffect(() => {
    const desktop = window.noteDesktop
    if (!desktop) return

    const syncDetachedWindow = (open: boolean) => {
      const state = useAppStore.getState()
      const wasDetached = state.byeoriDetached
      state.setByeoriDetached(open)
      if (open) {
        if (state.activeRightTab === SYSTEM_AI_TAB) state.setRightDockOpen(false)
        return
      }
      if (!wasDetached) return
      // 분리 창에서 새로 시작한 실행·대화를 기본 창 스토어에 다시 합친다.
      void useAiStore.getState().loadSessions()
      state.openRightTab(SYSTEM_AI_TAB)
    }

    const showByeoriDock = () => {
      const state = useAppStore.getState()
      state.setByeoriDetached(false)
      void useAiStore.getState().loadSessions()
      state.openRightTab(SYSTEM_AI_TAB)
    }

    const openMainDocument = ({ kind, path }: { kind: 'note' | 'erd'; path: string }) => {
      const state = useAppStore.getState()
      if (kind === 'erd') state.openErdDesigner(path)
      else state.openFile(path)
    }

    const disposeWindowState = desktop.onByeoriWindowChange(syncDetachedWindow)
    const disposeShowDock = desktop.onShowByeoriDock(showByeoriDock)
    const disposeOpenDocument = desktop.onOpenMainDocument(openMainDocument)
    desktop.isByeoriWindowOpen().then((open) => {
      const state = useAppStore.getState()
      state.setByeoriDetached(open)
      if (open && state.activeRightTab === SYSTEM_AI_TAB) state.setRightDockOpen(false)
    }).catch(() => {})

    return () => {
      disposeWindowState()
      disposeShowDock()
      disposeOpenDocument()
    }
  }, [])

  // 파일시스템 변경 이벤트 구독 → 외부(터미널/탐색기)에서 만든 파일·폴더도 트리에 자동 반영
  useEffect(() => {
    let ws: WebSocket | null = null
    let debounce: number | undefined
    let retry: number | undefined
    let disposed = false

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${window.location.host}/api/events/ws`)
      ws.onmessage = (message) => {
        try {
          window.dispatchEvent(new CustomEvent('twill:data-changed', { detail: JSON.parse(message.data) }))
        } catch {
          // Older backends may send a non-JSON ping; filesystem refresh below remains safe.
        }
        window.clearTimeout(debounce)
        debounce = window.setTimeout(() => {
          const { refreshTree, refreshTags } = useAppStore.getState()
          refreshTree().catch(() => {})
          refreshTags().catch(() => {})
        }, 250)
      }
      ws.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(debounce)
      window.clearTimeout(retry)
      ws?.close()
    }
  }, [])

  // 브라우저 뒤로/앞으로 가기 → 이전/다음 노트로 이동 (사이트 이탈 방지)
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const fromState = (e.state as { notePath?: string } | null)?.notePath
      const fromHash = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : null
      useAppStore.getState().restoreFromHistory(fromState ?? fromHash)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    /** 상단바 탭 단축키 실행 — 바인딩은 설정(⚙) > 단축키에서 재지정 가능. */
    const runShortcutAction = (action: ShortcutAction) => {
      const state = useAppStore.getState()
      const toggleDock = (tabId: string) => {
        if (state.rightDockOpen && state.activeRightTab === tabId) state.setRightDockOpen(false)
        else state.openRightTab(tabId)
      }
      switch (action) {
        case 'search':
          setPaletteOpen(true)
          return
        case 'taskBoard':
        case 'scopes': {
          const dir = action === 'taskBoard' ? 'tasks' : 'scopes'
          if (state.view === 'database' && state.dbDir === dir) {
            state.closeBoardView()
            return
          }
          const ensure = action === 'taskBoard' ? dbApi.ensureTaskBoard : dbApi.ensureScopesBoard
          ensure(dir)
            .then((r) => state.openDatabase(r.dir))
            .catch(() => {})
          return
        }
        case 'todayNote':
          openToday().catch(() => {})
          return
        case 'calendar':
        case 'todos':
          if (state.view === action) state.closeBoardView()
          else state.setView(action)
          return
        case 'ai':
          toggleDock(SYSTEM_AI_TAB)
          return
        case 'terminal':
          return
      }
    }

    const onKey = (e: KeyboardEvent) => {
      // 설정 가능한 앱 단축키
      const action = actionForEvent(e)
      if (action) {
        e.preventDefault()
        runShortcutAction(action)
        return
      }

      // Alt+1~9: 고정된 노트 n번째 열기 (고정 순서 기반이라 재지정 대상 아님)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const digit = /^Digit([1-9])$/.exec(e.code)
        if (digit) {
          const state = useAppStore.getState()
          const path = state.pinnedNotes[Number(digit[1]) - 1]
          if (path) {
            e.preventDefault()
            state.openFile(path)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPaletteOpen, openToday, openRightTab])

  return (
    <div className="flex h-full flex-col bg-white">
      <DesktopTitleBar />
      <CodexUpdateNotice />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className={view === 'editor' || view === 'erd' || view === 'ai' ? 'min-h-0 flex-1' : 'hidden'}>
            {workspaceReady && <SplitEditor key={root} />}
          </div>
          <div className={view === 'editor' || view === 'erd' || view === 'ai' ? 'hidden' : 'min-h-0 flex-1 overflow-auto'}>
            {view === 'plugin' ? (
              <MissingPluginView />
            ) : view === 'calendar' ? (
              <CalendarView />
            ) : view === 'todos' ? (
              <TodoView />
            ) : view === 'skillbook' ? (
              <SkillBookView />
            ) : view === 'database' ? (
              <DatabaseView />
            ) : null}
          </div>
        </main>
        {workspaceReady && <RightDock />}
      </div>
      {workspaceReady && <AiPlacement key={root} />}
      <CommandPalette />
      <DialogHost />
      <AiToasts />
      <DesktopTooltip />
    </div>
  )
}

function MissingPluginView() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[#9b9a97]">
      <span className="text-4xl">🧩</span>
      <p className="text-[14px]">{tr("플러그인 화면을 불러올 수 없습니다")}</p>
      <p className="text-[12px]">{tr("설정에서 플러그인 설치 상태를 확인한 뒤 다시 열어보세요")}</p>
    </div>
  )
}
