import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import { useAiStore } from '../aiStore'
import { usePluginRegistry } from '../plugins/registry'
import { SYSTEM_AI_TAB, SYSTEM_TERMINAL_TAB, useAppStore } from '../store'
import { isRepeatedClick } from '../useBackdropDismiss'
import { AiPanelHost } from './AiPlacement'
import { isAiTab, sessionIdFromAiTab } from '../aiTabs'
import { TERMINAL_ENABLED } from '../features'
import { AI_ICON } from '../shortcuts'
function AiDockHost() {
  const tabId = useAppStore((s) => s.dockedAiTabId)
  const tabs = useAppStore((s) => s.dockedAiTabs)
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 overflow-x-auto border-b border-[#e9e9e7] bg-[#f7f7f5]" role="tablist" aria-label={tr("AI 대화 탭")}>
      {tabs.map((tab) => <div key={tab.id} data-ai-dock-tab-id={tab.id} draggable
        className={`group flex shrink-0 items-center gap-1 border-r border-[#e9e9e7] px-2 text-[12px] ${tab.id === tabId ? 'bg-white text-[#37352f]' : 'text-[#7d7c78]'}`}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/doc-tab', tab.id)
          event.dataTransfer.setData('text/doc-tab-source', 'right-dock')
          event.dataTransfer.setData('application/x-twill-ai', '1')
          event.dataTransfer.effectAllowed = 'move'
        }}>
        <button role="tab" aria-selected={tab.id === tabId} title={tr(tab.title)} className="max-w-40 truncate py-2"
          onClick={() => useAppStore.getState().moveAi('right', tab.id)}>✦ {tab.title}</button>
        <button title={tr("탭 닫기")} aria-label={`${tab.title} 탭 닫기`} className="rounded px-1 text-[#9b9a97] hover:bg-[#e9e9e7]"
          onClick={() => useAppStore.getState().closeDockedAiTab(tab.id)}>×</button>
      </div>)}
    </div>
    <div className="min-h-0 flex-1">
      {tabs.map((tab) => <div key={tab.id} className={tab.id === tabId ? 'h-full' : 'hidden'}>
        <AiPanelHost tabId={tab.id} onFocus={() => useAiStore.setState({ activeSessionId: sessionIdFromAiTab(tab.id) })} />
      </div>)}
    </div>
  </div>
}
import TerminalPanel from './TerminalPanel'
import { tr } from '../i18n'

const MIN_WIDTH = 320
const RAIL_WIDTH = 40

type TabSpec = {
  id: string
  title: string
  icon?: string
  component: ComponentType
}

const TERMINAL_TAB: TabSpec = {
  id: SYSTEM_TERMINAL_TAB,
  title: '터미널',
  icon: '>_',
  component: TerminalPanel,
}

// Twill AI = 구 '실행' 탭 + 챗 탭 통합. 세션(대화·태스크 실행)이 패널 안 탭으로 관리됨.
const AI_TAB: TabSpec = {
  id: SYSTEM_AI_TAB,
  title: 'Twill AI',
  icon: AI_ICON,
  component: AiDockHost,
}

function ToolIcon({ tab, compact = false }: { tab: TabSpec; compact?: boolean }) {
  const size = compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'
  if (tab.id === SYSTEM_TERMINAL_TAB) {
    return (
      <svg viewBox="0 0 20 20" className={size} fill="none" stroke="currentColor" strokeWidth="1.45" aria-hidden="true">
        <path d="m4 5.5 4.5 4.5L4 14.5M10.5 14.5H16" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return <span className={`${compact ? 'text-[12px]' : 'text-[15px]'} leading-none`} aria-hidden="true">{tab.icon || '•'}</span>
}

export default function RightDock() {
  const {
    rightDockOpen,
    activeRightTab,
    byeoriDetached,
    dockedAiTabId,
    setRightDockOpen,
    setActiveRightTab,
    setByeoriDetached,
    openRightTab,
  } = useAppStore()
  const pluginTabs = usePluginRegistry((state) => state.rightTabs)
  const aiBusyCount = useAiStore((state) => state.sessions.filter((session) => session.busy).length)
  const aiQueuedCount = useAiStore((state) => state.sessions.filter((session) => session.queued).length)
  const dockedTitle = useAiStore((state) => state.sessions.find((session) => session.id === sessionIdFromAiTab(dockedAiTabId ?? ''))?.title)
  const width = useAppStore((state) => state.rightDockWidth)
  const [detachError, setDetachError] = useState<string | null>(null)
  const [aiDropOver, setAiDropOver] = useState(false)
  // 닫았다 다시 열어도 터미널 세션 등 이미 사용한 도구의 컴포넌트는 유지한다.
  const [activated, setActivated] = useState<Set<string>>(() => new Set([SYSTEM_AI_TAB]))

  const tabs = useMemo<TabSpec[]>(() => [AI_TAB, ...(TERMINAL_ENABLED ? [TERMINAL_TAB] : []), ...pluginTabs], [pluginTabs])
  const activeTool = tabs.find((tab) => tab.id === activeRightTab) ?? AI_TAB

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeRightTab)) setActiveRightTab(SYSTEM_AI_TAB)
  }, [tabs, activeRightTab, setActiveRightTab])

  useEffect(() => {
    if (rightDockOpen) {
      setActivated((previous) => previous.has(activeRightTab) ? previous : new Set(previous).add(activeRightTab))
    }
  }, [rightDockOpen, activeRightTab])

  const onResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const onMove = (pointerEvent: PointerEvent) => {
      const max = Math.floor(window.innerWidth * 0.7)
      const requested = window.innerWidth - RAIL_WIDTH - pointerEvent.clientX
      useAppStore.setState({ rightDockWidth: Math.min(max, Math.max(MIN_WIDTH, requested)) })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const detachByeori = useCallback(async (point?: { x: number; y: number }) => {
    const desktop = window.noteDesktop
    if (!desktop) return
    setDetachError(null)
    try {
      const opened = await desktop.openByeoriWindow(point)
      if (!opened) throw new Error('분리 창 생성 실패')
      setByeoriDetached(true)
      setRightDockOpen(false)
    } catch {
      setDetachError('Twill AI 창을 열지 못했습니다. 다시 시도해주세요.')
    }
  }, [setByeoriDetached, setRightDockOpen])

  const startByeoriDrag = (event: React.DragEvent) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/doc-tab', dockedAiTabId ?? useAppStore.getState().aiTabId ?? SYSTEM_AI_TAB)
    event.dataTransfer.setData('text/doc-tab-source', 'right-dock')
    event.dataTransfer.setData('application/x-twill-ai', '1')
  }

  const finishByeoriDrag = (event: React.DragEvent) => {
    const outside = event.clientX <= 0 || event.clientY <= 0 ||
      event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
    if (!outside) return
    const dropPoint = event.screenX !== 0 || event.screenY !== 0
      ? { x: event.screenX, y: event.screenY }
      : undefined
    void detachByeori(dropPoint)
  }

  const toggleTool = (tabId: string) => {
    if (tabId === SYSTEM_AI_TAB && byeoriDetached) {
      void window.noteDesktop?.focusByeoriWindow()
      return
    }
    if (rightDockOpen && activeRightTab === tabId) {
      setRightDockOpen(false)
      return
    }
    openRightTab(tabId)
  }

  return (
    <div className={`relative flex h-full shrink-0 ${aiDropOver ? 'ring-2 ring-inset ring-[#4a9eff]' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-twill-ai')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setAiDropOver(true)
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAiDropOver(false) }}
      onDrop={(event) => {
        setAiDropOver(false)
        const tabId = event.dataTransfer.getData('text/doc-tab')
        if (!isAiTab(tabId)) return
        event.preventDefault()
        useAppStore.getState().moveAi('right', tabId)
      }}
    >
      {aiDropOver && <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#4a9eff]/10"><span className="rounded bg-white px-2 py-1 text-[11px] text-[#2f6fd0] shadow">{tr("여기에 AI 배치")}</span></div>}
      <aside
        id="right-tool-panel"
        className={`relative h-full shrink-0 flex-col border-l border-[#e9e9e7] bg-white ${rightDockOpen ? 'flex' : 'hidden'}`}
        style={{ width, maxWidth: '70vw' }}
        aria-label={`${tr(activeTool.title)} ${tr('패널')}`}
      >
        <div
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-[#4a9eff]/60"
          onPointerDown={onResizeStart}
          title={tr("패널 너비 조절")}
        />
        <div className="flex h-9 shrink-0 items-center border-b border-[#e9e9e7] bg-[#f7f7f5] px-2.5">
          <div className={`flex min-w-0 flex-1 items-center gap-2 text-[12px] font-medium text-[#37352f] ${activeTool.id === SYSTEM_AI_TAB ? 'cursor-grab' : ''}`}
            draggable={activeTool.id === SYSTEM_AI_TAB && !byeoriDetached}
            onDragStart={startByeoriDrag}
            onDragEnd={finishByeoriDrag}
            title={activeTool.id === SYSTEM_AI_TAB ? tr("드래그하여 문서와 함께 배치") : undefined}>
            <ToolIcon tab={activeTool} compact />
            <span className="truncate" title={dockedTitle}>{activeTool.id === SYSTEM_AI_TAB ? dockedTitle ?? tr(activeTool.title) : tr(activeTool.title)}</span>
            {activeTool.id === SYSTEM_AI_TAB && aiBusyCount > 0 && (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-normal text-[#2f6fd0]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4a9eff]" />
                {aiBusyCount}{tr("개 실행 중")}
              </span>
            )}
          </div>
          {window.noteDesktop && activeTool.id === SYSTEM_AI_TAB && !byeoriDetached && (
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]"
              title={tr("새 창에서 열기")}
              aria-label={tr("Twill AI를 새 창에서 열기")}
              onClick={() => void detachByeori()}
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
                <rect x="2.5" y="4.5" width="9" height="8" rx="1.25" />
                <path d="M7 2.5h6.5V9M9.5 6.5l4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]"
            title={tr("닫기")}
            aria-label={`${tr(activeTool.title)} ${tr('패널')} ${tr('닫기')}`}
            onClick={() => setRightDockOpen(false)}
          >
            ✕
          </button>
        </div>
        {detachError && (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[#fbcaca] bg-[#fdf2f2] px-2.5 py-1.5 text-[11px] text-[#c92a2a]">
            <span className="min-w-0 flex-1">{detachError}</span>
            <button type="button" className="rounded px-1 hover:bg-[#f8dede]" onClick={() => setDetachError(null)} aria-label={tr("오류 닫기")}>✕</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => {
            if (!activated.has(tab.id)) return null
            const Component = tab.component
            return (
              <div key={tab.id} className={tab.id === activeRightTab ? 'h-full' : 'hidden'}>
                {tab.id === SYSTEM_AI_TAB && byeoriDetached ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[#7d7c78]">
                    <p className="text-[12px] font-medium text-[#37352f]">{tr("Twill AI가 별도 창에서 열려 있습니다")}</p>
                    <button
                      type="button"
                      className="rounded-md border border-[#e3e2e0] bg-white px-2.5 py-1 text-[11px] hover:bg-[#f7f7f5]"
                      onClick={() => void window.noteDesktop?.focusByeoriWindow()}
                    >

                      {tr("별도 창 보기")}
                    </button>
                  </div>
                ) : (
                  <Component />
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <nav
        className="flex h-full w-10 shrink-0 flex-col items-center border-l border-[#e3e2e0] bg-[#f7f7f5] py-1"
        aria-label={tr("우측 도구")}
      >
        {tabs.map((tab) => {
          const selected = rightDockOpen && activeRightTab === tab.id
          const aiStatusCount = aiBusyCount > 0 ? aiBusyCount : aiQueuedCount
          return (
            <button
              key={tab.id}
              type="button"
              className={`relative m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4a9eff] ${
                selected
                  ? 'bg-white text-[#37352f]'
                  : 'text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f]'
              }`}
              title={tr(tab.title)}
              aria-label={tab.id === SYSTEM_AI_TAB && aiBusyCount > 0 ? `${tr(tab.title)}, ${aiBusyCount} ${tr('개 실행 중')}` : tr(tab.title)}
              aria-pressed={selected}
              aria-controls="right-tool-panel"
              draggable={Boolean(tab.id === SYSTEM_AI_TAB && !byeoriDetached)}
              onClick={(event) => {
                if (!isRepeatedClick(event)) toggleTool(tab.id)
              }}
              onDragStart={(event) => {
                if (tab.id !== SYSTEM_AI_TAB || byeoriDetached) {
                  event.preventDefault()
                  return
                }
                startByeoriDrag(event)
              }}
              onDragEnd={(event) => {
                if (tab.id === SYSTEM_AI_TAB && !byeoriDetached) finishByeoriDrag(event)
              }}
            >
              {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-[#4a9eff]" aria-hidden="true" />}
              <ToolIcon tab={tab} />
              {tab.id === SYSTEM_AI_TAB && aiStatusCount > 0 && (
                <span
                  className={`absolute right-0.5 top-0.5 flex min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] font-bold leading-3 text-white ${
                    aiBusyCount > 0 ? 'bg-[#4a9eff]' : 'bg-[#d6a33c]'
                  }`}
                  aria-hidden="true"
                >
                  {aiStatusCount > 9 ? '9+' : aiStatusCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
