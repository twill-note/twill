import { useState } from 'react'
import { dialog } from '../dialog'
import { dbApi } from '../dbschema'
import { displayCombo, useShortcutStore } from '../shortcuts'
import { useAppStore, activeTabId, type DocTab } from '../store'

/**
 * 메인 화면 상단 바.
 *
 * · 좌측 고정: 📋 태스크 보드(Alt+T) · 🌐 프로젝트 관리(Alt+P) · ☀️ 오늘의 노트(Ctrl+D)
 * · 이어서: 📌 고정된 노트 탭 (Alt+1~9, 우클릭으로 고정 해제) — 자주 쓰는 노트 바로가기
 * · 가운데: 전체 화면 뷰 탭(DB·캘린더·할 일), 드래그 정렬
 * · 우측 도구는 화면 오른쪽 세로 레일에서 열고 닫음
 * · 파일(노트) 탭은 SplitEditor 의 편집기 그룹마다 표시 — 여기서는 그리지 않는다.
 */
export default function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs)
  const view = useAppStore((s) => s.view)
  const currentPath = useAppStore((s) => s.currentPath)
  const dbDir = useAppStore((s) => s.dbDir)
  const erdTabId = useAppStore((s) => s.erdTabId)
  const pinnedNotes = useAppStore((s) => s.pinnedNotes)
  const togglePinnedNote = useAppStore((s) => s.togglePinnedNote)
  const openFile = useAppStore((s) => s.openFile)
  const openDatabase = useAppStore((s) => s.openDatabase)
  const openToday = useAppStore((s) => s.openToday)
  const setView = useAppStore((s) => s.setView)
  const closeTab = useAppStore((s) => s.closeTab)
  const closeBoardView = useAppStore((s) => s.closeBoardView)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const bindings = useShortcutStore((s) => s.bindings)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [pinMenu, setPinMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  // 가운데 탭 줄에는 일반 DB 탭만 — 파일은 편집기 그룹, 캘린더/할일/보드류는 고정 토글 버튼 담당
  const viewTabs = openTabs.filter((t) => t.kind === 'db' && t.target !== 'tasks' && t.target !== 'scopes')
  const activeId = activeTabId({ view, currentPath, dbDir, erdTabId })
  const taskBoardActive = view === 'database' && dbDir === 'tasks'
  const scopesActive = view === 'database' && dbDir === 'scopes'

  const activate = (t: DocTab) => {
    if (t.kind === 'db') openDatabase(t.target)
    else if (t.kind === 'view') setView(t.target as 'calendar' | 'todos' | 'editor' | 'database')
  }

  const noteLabel = (path: string) => path.split('/').pop()?.replace(/\.md$/, '') ?? path

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-[#e9e9e7] bg-[#f7f7f5]">
      {/* 좌측 고정: 태스크 보드 · 프로젝트 관리 · 오늘의 노트 */}
      <button
        className={`flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] ${
          taskBoardActive ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
        }`}
        onClick={() => void toggleBoard('tasks', taskBoardActive)}
        title={`태스크 보드 ${taskBoardActive ? '닫기' : '열기'} (${displayCombo(bindings.taskBoard)})`}
      >
        📋
      </button>
      <button
        className={`flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] ${
          scopesActive ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
        }`}
        onClick={() => void toggleBoard('scopes', scopesActive)}
        title={`프로젝트 관리 ${scopesActive ? '닫기' : '열기'} (${displayCombo(bindings.scopes)}) — 코드베이스 경로 관리`}
      >
        🌐
      </button>
      <button
        className="flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]"
        onClick={() => openToday().catch((e) => dialog.alert((e as Error).message))}
        title={`오늘의 노트 (${displayCombo(bindings.todayNote)}) — 없으면 생성`}
      >
        ☀️
      </button>
      <button
        className={`flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] ${
          view === 'calendar' ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
        }`}
        onClick={() => (view === 'calendar' ? closeBoardView() : setView('calendar'))}
        title={`캘린더 ${view === 'calendar' ? '닫기' : '열기'} (${displayCombo(bindings.calendar)})`}
      >
        📅
      </button>
      <button
        className={`flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] ${
          view === 'todos' ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
        }`}
        onClick={() => (view === 'todos' ? closeBoardView() : setView('todos'))}
        title={`할 일 ${view === 'todos' ? '닫기' : '열기'} (${displayCombo(bindings.todos)})`}
      >
        ✅
      </button>
      <button
        className={`flex h-full shrink-0 items-center border-r border-[#e9e9e7] px-2.5 text-[14px] ${
          view === 'skillbook' ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
        }`}
        onClick={() => (view === 'skillbook' ? closeBoardView() : setView('skillbook'))}
        title={`스킬북 ${view === 'skillbook' ? '닫기' : '열기'}`}
      >
        📚
      </button>
      {/* 📌 고정된 노트 — 자주 쓰는 노트 바로가기 (우클릭: 고정 해제, Alt+1~9) */}
      {pinnedNotes.map((path, i) => {
        const active = view === 'editor' && currentPath === path
        return (
          <button
            key={path}
            className={`flex h-full max-w-[160px] shrink-0 items-center gap-1 border-r border-[#e9e9e7] px-2 text-[12px] ${
              active ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
            }`}
            onClick={() => openFile(path)}
            onContextMenu={(e) => {
              e.preventDefault()
              setPinMenu({ x: e.clientX, y: e.clientY, path })
            }}
            title={`${path}${i < 9 ? ` (Alt+${i + 1})` : ''} — 우클릭: 고정 해제`}
          >
            <span className="text-[10px]">📌</span>
            <span className="truncate">{noteLabel(path)}</span>
          </button>
        )
      })}

      {/* 전체 화면 뷰 탭 (DB·캘린더·할 일) — 드래그로 순서 이동 */}
      <div
        className="scrollbar-none flex h-full min-w-0 flex-1 items-center overflow-x-auto"
        onWheel={(e) => {
          if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {viewTabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/view-tab', t.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('text/view-tab')) {
                  e.preventDefault()
                  setDragOverId(t.id)
                }
              }}
              onDragLeave={() => setDragOverId((d) => (d === t.id ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                const fromId = e.dataTransfer.getData('text/view-tab')
                if (fromId && fromId !== t.id) reorderTabs(fromId, t.id)
                setDragOverId(null)
              }}
              onDragEnd={() => setDragOverId(null)}
              className={`group flex h-full shrink-0 items-center gap-1 border-r border-[#e9e9e7] px-2.5 text-[12px] ${
                active ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea]'
              } ${dragOverId === t.id ? 'border-l-2 border-l-[#4a9eff]' : ''}`}
            >
              <button className="flex max-w-[200px] items-center gap-1 truncate" onClick={() => activate(t)} title={t.target}>
                <span className="text-[13px]">{t.icon}</span>
                <span className="truncate">{t.title}</span>
              </button>
              <button
                className={`ml-1 rounded px-1 text-[10px] ${
                  active
                    ? 'text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]'
                    : 'text-[#9b9a97] opacity-0 hover:bg-[#e0e0de] group-hover:opacity-100'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                title="탭 닫기"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      {/* 고정 노트 우클릭 메뉴 */}
      {pinMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setPinMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setPinMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-40 rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
            style={{ left: Math.min(pinMenu.x, window.innerWidth - 170), top: Math.min(pinMenu.y, window.innerHeight - 80) }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => {
                togglePinnedNote(pinMenu.path)
                setPinMenu(null)
              }}
            >
              <span>📌</span> 고정 해제
            </button>
          </div>
        </>
      )}
    </div>
  )

  /** 태스크 보드/프로젝트 관리 토글 — 탭을 만들지 않고 영역만 여닫는다 (닫으면 직전 화면 복귀). */
  async function toggleBoard(dir: 'tasks' | 'scopes', isActive: boolean) {
    if (isActive) {
      closeBoardView()
      return
    }
    try {
      const r = dir === 'tasks' ? await dbApi.ensureTaskBoard('tasks') : await dbApi.ensureScopesBoard('scopes')
      openDatabase(r.dir)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

}
