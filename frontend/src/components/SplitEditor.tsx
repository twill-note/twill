import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeTabId, type DocTab, useAppStore } from '../store'
import { dialog } from '../dialog'
import Editor from './Editor'
import ErdWorkspace from '../plugins/erd-designer/Workspace'
import { discardErdTabSession, hasUnsavedErdTab, requestCloseErdTab } from '../plugins/erd-designer/session'

/**
 * 노트와 ERD 문서를 함께 배치하는 분할 트리. 이 컴포넌트는 각 패널의 탭과 렌더링을 담당한다.
 */
type PanelNode = {
  kind: 'panel'
  id: string
  tabIds: string[]
  activeTabId: string | null
}

type SplitNode = {
  kind: 'split'
  id: string
  /** horizontal = 좌우, vertical = 상하 */
  direction: 'horizontal' | 'vertical'
  /** 첫 번째 자식의 비율(%) */
  ratio: number
  first: PaneNode
  second: PaneNode
}

type PaneNode = PanelNode | SplitNode

type SplitLayout = {
  root: PaneNode
  activePanelId: string
}

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

const STORAGE_KEY = 'split-editor-layout-v1'
const MIN_PANE_RATIO = 20
const MAX_PANE_RATIO = 80

function createId(prefix: string) {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`
}

function createPanel(): PanelNode {
  return { kind: 'panel', id: createId('pane'), tabIds: [], activeTabId: null }
}

function createInitialLayout(): SplitLayout {
  const root = createPanel()
  return { root, activePanelId: root.id }
}

function isPaneNode(value: unknown): value is PaneNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<PaneNode>
  if (node.kind === 'panel') return typeof node.id === 'string' && Array.isArray(node.tabIds)
  if (node.kind === 'split') {
    const split = node as Partial<SplitNode>
    return (
      typeof split.id === 'string' &&
      (split.direction === 'horizontal' || split.direction === 'vertical') &&
      typeof split.ratio === 'number' &&
      isPaneNode(split.first) &&
      isPaneNode(split.second)
    )
  }
  return false
}

function loadLayout(): SplitLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<SplitLayout>
    if (isPaneNode(saved.root) && typeof saved.activePanelId === 'string') return saved as SplitLayout
  } catch {
    // 오래된 형식이나 손상된 값은 빈 패널 하나로 안전하게 되돌린다.
  }
  return createInitialLayout()
}

function findPanel(node: PaneNode, id: string): PanelNode | null {
  if (node.kind === 'panel') return node.id === id ? node : null
  return findPanel(node.first, id) ?? findPanel(node.second, id)
}

function leafPanels(node: PaneNode, result: PanelNode[] = []): PanelNode[] {
  if (node.kind === 'panel') result.push(node)
  else {
    leafPanels(node.first, result)
    leafPanels(node.second, result)
  }
  return result
}

function updatePanel(node: PaneNode, id: string, update: (panel: PanelNode) => PanelNode): PaneNode {
  if (node.kind === 'panel') return node.id === id ? update(node) : node
  const first = updatePanel(node.first, id, update)
  const second = updatePanel(node.second, id, update)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** 패널을 분할 노드로 바꾸는 경우처럼, 리프의 종류 자체를 교체할 때 사용한다. */
function replacePanel(node: PaneNode, id: string, replace: (panel: PanelNode) => PaneNode): PaneNode {
  if (node.kind === 'panel') return node.id === id ? replace(node) : node
  const first = replacePanel(node.first, id, replace)
  const second = replacePanel(node.second, id, replace)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function updateSplit(node: PaneNode, id: string, update: (split: SplitNode) => SplitNode): PaneNode {
  if (node.kind === 'panel') return node
  if (node.id === id) return update(node)
  const first = updateSplit(node.first, id, update)
  const second = updateSplit(node.second, id, update)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** 대상 패널을 제거하고, 남은 형제를 위로 끌어올려 빈 분할을 남기지 않는다. */
function removePanel(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === 'panel') return node.id === id ? null : node
  const first = removePanel(node.first, id)
  const second = removePanel(node.second, id)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** 탭이 마지막 하나였던 패널은 제거하고, 남은 형제를 위로 끌어올린다. */
function removeTabAndEmptyPanel(node: PaneNode, panelId: string, tabId: string): PaneNode | null {
  if (node.kind === 'panel') {
    if (node.id !== panelId) return node
    const tabIds = node.tabIds.filter((id) => id !== tabId)
    if (tabIds.length === 0) return null
    return {
      ...node,
      tabIds,
      activeTabId: node.activeTabId === tabId ? tabIds[tabIds.length - 1] : node.activeTabId,
    }
  }
  const first = removeTabAndEmptyPanel(node.first, panelId, tabId)
  const second = removeTabAndEmptyPanel(node.second, panelId, tabId)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function isSplitZone(zone: DropZone) {
  return zone !== 'center'
}

/** `beforeTabId` 앞에 탭을 놓는다. 대상이 없으면 탭 줄의 맨 뒤에 둔다. */
function placeTabBefore(tabIds: string[], tabId: string, beforeTabId: string | null): string[] {
  // 자기 자신 위에 놓는 것은 순서를 바꾸지 않는다. (제거 후 다시 찾으면 맨 뒤로 가는 것을 방지)
  if (beforeTabId === tabId) return tabIds
  const withoutTab = tabIds.filter((id) => id !== tabId)
  const beforeIndex = beforeTabId ? withoutTab.indexOf(beforeTabId) : -1
  if (beforeIndex < 0) return [...withoutTab, tabId]
  return [...withoutTab.slice(0, beforeIndex), tabId, ...withoutTab.slice(beforeIndex)]
}

export default function SplitEditor() {
  const openTabs = useAppStore((s) => s.openTabs)
  const view = useAppStore((s) => s.view)
  const currentPath = useAppStore((s) => s.currentPath)
  const dbDir = useAppStore((s) => s.dbDir)
  const erdTabId = useAppStore((s) => s.erdTabId)
  const openFile = useAppStore((s) => s.openFile)
  const activateErdTab = useAppStore((s) => s.activateErdTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const [layout, setLayout] = useState<SplitLayout>(loadLayout)

  // DB·캘린더 같은 전체 화면 뷰와 달리 ERD는 노트와 동일하게 분할 패널 안의 문서 탭이다.
  const documentTabs = useMemo(() => openTabs.filter((tab) => tab.kind === 'file' || tab.kind === 'erd'), [openTabs])
  const tabsById = useMemo(() => new Map(documentTabs.map((tab) => [tab.id, tab])), [documentTabs])
  const openDocumentTabIds = useMemo(() => new Set(documentTabs.map((tab) => tab.id)), [documentTabs])
  const selectedTabId = activeTabId({ view, currentPath, dbDir, erdTabId })

  const openDocument = useCallback((tab: DocTab) => {
    if (tab.kind === 'file') openFile(tab.target)
    else if (tab.kind === 'erd') activateErdTab(tab.id)
  }, [activateErdTab, openFile])

  // 파일 트리에서 노트 또는 ERD를 열면, 마지막으로 포커스한 패널에 그 탭을 배치한다.
  useEffect(() => {
    if (!selectedTabId || !openDocumentTabIds.has(selectedTabId)) return
    setLayout((previous) => {
      // 이미 다른 패널에서 열린 탭이면 그 패널을 다시 활성화한다. 같은 문서를 둘로
      // 복제해 동시에 저장 충돌이 나는 일을 피하고, 탭의 위치도 예측 가능하게 만든다.
      const focusedPanel = findPanel(previous.root, previous.activePanelId)
      const existingPanel = focusedPanel?.tabIds.includes(selectedTabId)
        ? focusedPanel
        : leafPanels(previous.root).find((panel) => panel.tabIds.includes(selectedTabId))
      const panel = existingPanel ?? findPanel(previous.root, previous.activePanelId) ?? leafPanels(previous.root)[0]
      if (!panel) return previous
      if (panel.activeTabId === selectedTabId && previous.activePanelId === panel.id) return previous
      const tabIds = panel.tabIds.includes(selectedTabId) ? panel.tabIds : [...panel.tabIds, selectedTabId]
      return {
        ...previous,
        activePanelId: panel.id,
        root: updatePanel(previous.root, panel.id, (current) => ({ ...current, tabIds, activeTabId: selectedTabId })),
      }
    })
  }, [selectedTabId, openDocumentTabIds])

  // 닫힌 전역 탭은 저장된 패널 레이아웃에서도 자연스럽게 제거한다.
  useEffect(() => {
    setLayout((previous) => {
      let changed = false
      const root = pruneClosedTabs(previous.root, openDocumentTabIds, () => {
        changed = true
      })
      const compacted = removeEmptyPanels(root) ?? createPanel()
      if (compacted !== root) changed = true
      if (!changed) return previous
      const activePanelId = findPanel(compacted, previous.activePanelId)
        ? previous.activePanelId
        : leafPanels(compacted)[0]?.id ?? previous.activePanelId
      return { root: compacted, activePanelId }
    })
  }, [openDocumentTabIds])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }, [layout])

  const focusPanel = useCallback((panelId: string) => {
    setLayout((previous) => (previous.activePanelId === panelId ? previous : { ...previous, activePanelId: panelId }))
  }, [])

  /** 상단 탭을 패널에 놓는다. 가운데는 이동/재정렬, 가장자리는 새 분할 패널을 만든다. */
  const dropTab = useCallback(
    (tabId: string, sourcePanelId: string, targetPanelId: string, zone: DropZone, beforeTabId: string | null = null) => {
      const tab = tabsById.get(tabId)
      const target = findPanel(layout.root, targetPanelId)
      if (!tab || !target || (isSplitZone(zone) && leafPanels(layout.root).length >= 4)) return

      setLayout((previous) => {
        const source = findPanel(previous.root, sourcePanelId) ?? leafPanels(previous.root).find((panel) => panel.tabIds.includes(tabId))

        if (zone === 'center') {
          // 다른 패널에서 온 탭은 원본에서 먼저 빼서, 대상 탭 앞/뒤 위치를 그대로 계산한다.
          // 같은 패널이면 placeTabBefore 가 제거와 삽입을 한 번에 처리한다.
          const rootWithoutSource = source && source.id !== targetPanelId
            ? removeTabAndEmptyPanel(previous.root, source.id, tabId) ?? previous.root
            : previous.root
          if (!findPanel(rootWithoutSource, targetPanelId)) return previous
          const root = updatePanel(rootWithoutSource, targetPanelId, (panel) => ({
            ...panel,
            tabIds: placeTabBefore(panel.tabIds, tabId, beforeTabId),
            activeTabId: tabId,
          }))
          return { root, activePanelId: targetPanelId }
        }

        const newPanel: PanelNode = { kind: 'panel', id: createId('pane'), tabIds: [tabId], activeTabId: tabId }
        const direction: SplitNode['direction'] = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
        const placed = replacePanel(previous.root, targetPanelId, (panel) => {
          const split: SplitNode = {
            kind: 'split',
            id: createId('split'),
            direction,
            ratio: 50,
            first: panel,
            second: newPanel,
          }
          if (zone === 'left' || zone === 'top') [split.first, split.second] = [newPanel, panel]
          return split
        })
        // 이동 시맨틱 (VS Code 동일): 분할로 옮긴 탭은 원본 패널에서 제거한다.
        // 자기 패널 가장자리 분할도 마찬가지 — 남은 탭이 없으면 분할이 자연스럽게 원상 복귀된다.
        const root = source ? removeTabAndEmptyPanel(placed, source.id, tabId) ?? placed : placed
        return { root, activePanelId: newPanel.id }
      })
      openDocument(tab)
    },
    [layout.root, openDocument, tabsById],
  )

  const resizeSplit = useCallback((splitId: string, ratio: number) => {
    const nextRatio = Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio))
    setLayout((previous) => ({
      ...previous,
      root: updateSplit(previous.root, splitId, (split) => (Math.abs(split.ratio - nextRatio) < 0.1 ? split : { ...split, ratio: nextRatio })),
    }))
  }, [])

  const activateTab = useCallback(
    (panelId: string, tab: DocTab) => {
      setLayout((previous) => ({
        ...previous,
        activePanelId: panelId,
        root: updatePanel(previous.root, panelId, (panel) => ({ ...panel, activeTabId: tab.id })),
      }))
      openDocument(tab)
    },
    [openDocument],
  )

  const closeTabInPanel = useCallback(
    async (panelId: string, tabId: string) => {
      const closing = tabsById.get(tabId)
      if (closing?.kind === 'erd') {
        // 보이는 ERD는 내부 닫기 처리로 넘겨 저장 확인을 한 번만 표시한다.
        if (requestCloseErdTab(tabId)) return
        if (hasUnsavedErdTab(tabId)) {
          const ok = await dialog.confirm('저장하지 않은 변경사항이 있습니다', {
            detail: '정말로 닫을까요?',
            danger: true,
            confirmLabel: '변경 버리기',
          })
          if (!ok) return
        }
        discardErdTabSession(tabId)
      }
      const panel = findPanel(layout.root, panelId)
      const fallbackId = panel?.tabIds.filter((id) => id !== tabId).at(-1) ?? null
      setLayout((previous) => {
        const root = removeTabAndEmptyPanel(previous.root, panelId, tabId)
        if (!root) return previous
        const activePanelId = findPanel(root, previous.activePanelId)
          ? previous.activePanelId
          : leafPanels(root)[0]?.id ?? previous.activePanelId
        return { root, activePanelId }
      })
      closeTab(tabId)
      if (layout.activePanelId === panelId && fallbackId) {
        const fallback = tabsById.get(fallbackId)
        if (fallback) openDocument(fallback)
      }
    },
    [closeTab, layout, openDocument, tabsById],
  )

  const closeTabsInPanel = useCallback(
    async (panelId: string, tabIds: string[]) => {
      const panel = findPanel(layout.root, panelId)
      if (!panel) return
      const requested = new Set(tabIds)
      const closingIds = panel.tabIds.filter((id) => requested.has(id))
      if (closingIds.length === 0) return

      const unsavedErdTabs = closingIds.filter((id) => {
        const tab = tabsById.get(id)
        return tab?.kind === 'erd' && hasUnsavedErdTab(id)
      })
      if (unsavedErdTabs.length > 0) {
        const ok = await dialog.confirm('저장하지 않은 ERD 변경사항이 있습니다', {
          detail: `${unsavedErdTabs.length}개 ERD 탭의 변경사항을 버리고 계속 닫을까요?`,
          danger: true,
          confirmLabel: '변경 버리고 닫기',
        })
        if (!ok) return
      }

      for (const id of closingIds) {
        if (tabsById.get(id)?.kind === 'erd') discardErdTabSession(id)
      }

      const closingSet = new Set(closingIds)
      const remainingIds = panel.tabIds.filter((id) => !closingSet.has(id))
      const fallbackId =
        panel.activeTabId && remainingIds.includes(panel.activeTabId)
          ? panel.activeTabId
          : remainingIds.at(-1) ?? null

      setLayout((previous) => {
        const currentPanel = findPanel(previous.root, panelId)
        if (!currentPanel) return previous
        const nextIds = currentPanel.tabIds.filter((id) => !closingSet.has(id))
        let root: PaneNode
        if (nextIds.length === 0 && leafPanels(previous.root).length > 1) {
          root = removePanel(previous.root, panelId) ?? createPanel()
        } else {
          root = updatePanel(previous.root, panelId, (current) => ({
            ...current,
            tabIds: nextIds,
            activeTabId:
              current.activeTabId && nextIds.includes(current.activeTabId)
                ? current.activeTabId
                : nextIds.at(-1) ?? null,
          }))
        }
        const activePanelId = findPanel(root, previous.activePanelId)
          ? previous.activePanelId
          : leafPanels(root)[0]?.id ?? previous.activePanelId
        return { root, activePanelId }
      })

      // 현재 활성 탭은 마지막에 닫아 중간 탭 전환을 줄이고, 남은 탭이 있으면 확실히 다시 활성화한다.
      const activeClosingId = panel.activeTabId && closingSet.has(panel.activeTabId) ? panel.activeTabId : null
      for (const id of closingIds) if (id !== activeClosingId) closeTab(id)
      if (activeClosingId) closeTab(activeClosingId)
      if (fallbackId) {
        const fallback = tabsById.get(fallbackId)
        if (fallback) openDocument(fallback)
      }
    },
    [closeTab, layout.root, openDocument, tabsById],
  )

  /** 패널 닫기는 탭을 인접 그룹으로 옮긴 뒤 해당 그룹만 제거한다. */
  const closePanel = useCallback((panelId: string) => {
    setLayout((previous) => {
      const panels = leafPanels(previous.root)
      if (panels.length <= 1) return previous
      const index = panels.findIndex((panel) => panel.id === panelId)
      const closing = panels[index]
      const target = panels[index + 1] ?? panels[index - 1]
      if (!closing || !target) return previous
      const rootWithTabs = updatePanel(previous.root, target.id, (panel) => {
        const tabIds = [...panel.tabIds]
        for (const id of closing.tabIds) if (!tabIds.includes(id)) tabIds.push(id)
        return { ...panel, tabIds, activeTabId: closing.activeTabId ?? panel.activeTabId }
      })
      const root = removePanel(rootWithTabs, panelId)
      if (!root) return previous
      return { root, activePanelId: previous.activePanelId === panelId ? target.id : previous.activePanelId }
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden bg-white" data-split-editor>
      <PaneTree
        node={layout.root}
        activePanelId={layout.activePanelId}
        canClosePanel={leafPanels(layout.root).length > 1}
        tabsById={tabsById}
        onFocusPanel={focusPanel}
        onDropTab={dropTab}
        onActivateTab={activateTab}
        onCloseTab={closeTabInPanel}
        onCloseTabs={closeTabsInPanel}
        onClosePanel={closePanel}
        onResizeSplit={resizeSplit}
      />
    </div>
  )
}

function pruneClosedTabs(node: PaneNode, validTabIds: Set<string>, changed: () => void): PaneNode {
  if (node.kind === 'panel') {
    const tabIds = node.tabIds.filter((id) => validTabIds.has(id))
    const activeTabId = node.activeTabId && validTabIds.has(node.activeTabId) ? node.activeTabId : tabIds[tabIds.length - 1] ?? null
    if (tabIds.length === node.tabIds.length && activeTabId === node.activeTabId) return node
    changed()
    return { ...node, tabIds, activeTabId }
  }
  const first = pruneClosedTabs(node.first, validTabIds, changed)
  const second = pruneClosedTabs(node.second, validTabIds, changed)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function removeEmptyPanels(node: PaneNode): PaneNode | null {
  if (node.kind === 'panel') return node.tabIds.length > 0 ? node : null
  const first = removeEmptyPanels(node.first)
  const second = removeEmptyPanels(node.second)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

type PaneTreeProps = {
  node: PaneNode
  activePanelId: string
  canClosePanel: boolean
  tabsById: Map<string, DocTab>
  onFocusPanel: (panelId: string) => void
  onDropTab: (tabId: string, sourcePanelId: string, targetPanelId: string, zone: DropZone, beforeTabId?: string | null) => void
  onActivateTab: (panelId: string, tab: DocTab) => void
  onCloseTab: (panelId: string, tabId: string) => void
  onCloseTabs: (panelId: string, tabIds: string[]) => Promise<void>
  onClosePanel: (panelId: string) => void
  onResizeSplit: (splitId: string, ratio: number) => void
}

function PaneTree(props: PaneTreeProps) {
  const { node } = props
  if (node.kind === 'panel') return <EditorPane panel={node} {...props} />

  const horizontal = node.direction === 'horizontal'
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      <div className="flex min-h-0 min-w-0" style={{ flex: `0 1 ${node.ratio}%` }}>
        <PaneTree {...props} node={node.first} />
      </div>
      <ResizeDivider direction={node.direction} onResize={(ratio) => props.onResizeSplit(node.id, ratio)} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <PaneTree {...props} node={node.second} />
      </div>
    </div>
  )
}

function ResizeDivider({ direction, onResize }: { direction: SplitNode['direction']; onResize: (ratio: number) => void }) {
  const horizontal = direction === 'horizontal'
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={horizontal ? '좌우 패널 크기 조절' : '상하 패널 크기 조절'}
      tabIndex={0}
      className={`group relative z-10 shrink-0 bg-[#e9e9e7] transition-colors hover:bg-[#4a9eff] focus:bg-[#4a9eff] ${
        horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
      onPointerDown={(event) => {
        event.preventDefault()
        const container = event.currentTarget.parentElement
        if (!container) return
        const originalUserSelect = document.body.style.userSelect
        document.body.style.userSelect = 'none'
        const update = (clientX: number, clientY: number) => {
          const rect = container.getBoundingClientRect()
          const length = horizontal ? rect.width : rect.height
          if (length <= 0) return
          const offset = horizontal ? clientX - rect.left : clientY - rect.top
          onResize((offset / length) * 100)
        }
        const move = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY)
        const stop = () => {
          document.body.style.userSelect = originalUserSelect
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
      }}
      onKeyDown={(event) => {
        const amount = event.shiftKey ? 10 : 2
        if ((horizontal && event.key === 'ArrowLeft') || (!horizontal && event.key === 'ArrowUp')) {
          event.preventDefault()
          onResize(50 - amount)
        }
        if ((horizontal && event.key === 'ArrowRight') || (!horizontal && event.key === 'ArrowDown')) {
          event.preventDefault()
          onResize(50 + amount)
        }
      }}
    />
  )
}

function EditorPane({
  panel,
  activePanelId,
  canClosePanel,
  tabsById,
  onFocusPanel,
  onDropTab,
  onActivateTab,
  onCloseTab,
  onCloseTabs,
  onClosePanel,
}: PaneTreeProps & { panel: PanelNode }) {
  const [dropZone, setDropZone] = useState<DropZone | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: DocTab } | null>(null)
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabScroll, setTabScroll] = useState({
    left: false,
    right: false,
    overflow: false,
    scrollLeft: 0,
    maxScrollLeft: 0,
    thumbWidth: 100,
    thumbLeft: 0,
  })
  const pinnedNotes = useAppStore((s) => s.pinnedNotes)
  const togglePinnedNote = useAppStore((s) => s.togglePinnedNote)
  const tabs = panel.tabIds.map((id) => tabsById.get(id)).filter((tab): tab is DocTab => Boolean(tab))
  const activeTab = panel.activeTabId ? tabsById.get(panel.activeTabId) ?? null : null
  const activeDocumentTabId = activeTab?.id
  const isActivePanel = panel.id === activePanelId
  // 탭 제목 변경(예: ERD 저장 후 이름 변경)도 스크롤 제어 표시를 다시 계산한다.
  const tabScrollKey = tabs.map((tab) => `${tab.id}:${tab.title}`).join('\u0000')

  const updateTabScroll = useCallback(() => {
    const element = tabScrollRef.current
    if (!element) return
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
    const overflow = maxScrollLeft > 1
    const minThumbWidth = Math.min(100, (32 / Math.max(1, element.clientWidth)) * 100)
    // 실제 탭 비율을 반영하되, 화면에 보이는 손잡이는 최소 32px을 유지한다.
    const thumbWidth = overflow
      ? Math.max(minThumbWidth, (element.clientWidth / element.scrollWidth) * 100)
      : 100
    const thumbLeft = overflow ? (element.scrollLeft / maxScrollLeft) * (100 - thumbWidth) : 0
    const next = {
      left: element.scrollLeft > 1,
      right: element.scrollLeft < maxScrollLeft - 1,
      overflow,
      scrollLeft: element.scrollLeft,
      maxScrollLeft,
      thumbWidth,
      thumbLeft,
    }
    setTabScroll((current) =>
      current.left === next.left &&
      current.right === next.right &&
      current.overflow === next.overflow &&
      Math.abs(current.scrollLeft - next.scrollLeft) < 0.5 &&
      Math.abs(current.maxScrollLeft - next.maxScrollLeft) < 0.5 &&
      Math.abs(current.thumbWidth - next.thumbWidth) < 0.1 &&
      Math.abs(current.thumbLeft - next.thumbLeft) < 0.1
        ? current
        : next,
    )
  }, [])

  useEffect(() => {
    const element = tabScrollRef.current
    if (!element) return
    updateTabScroll()
    element.addEventListener('scroll', updateTabScroll, { passive: true })
    const observer = new ResizeObserver(updateTabScroll)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', updateTabScroll)
      observer.disconnect()
    }
  }, [canClosePanel, tabScrollKey, updateTabScroll])

  // 새로 선택하거나 다른 패널에서 옮긴 탭은 가려진 상태로 남지 않게 한다.
  useEffect(() => {
    const element = tabScrollRef.current
    if (!element || !activeDocumentTabId) return
    const tabElement = Array.from(element.querySelectorAll<HTMLElement>('[data-document-tab-id]'))
      .find((candidate) => candidate.dataset.documentTabId === activeDocumentTabId)
    tabElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeDocumentTabId])

  const scrollTabs = (direction: -1 | 1) => {
    const element = tabScrollRef.current
    if (!element) return
    element.scrollBy({ left: direction * Math.max(120, element.clientWidth * 0.7), behavior: 'smooth' })
  }

  const swipeTabsTo = (track: HTMLDivElement, clientX: number) => {
    const element = tabScrollRef.current
    if (!element || !tabScroll.overflow) return
    const rect = track.getBoundingClientRect()
    const thumbWidth = (rect.width * tabScroll.thumbWidth) / 100
    const travel = Math.max(1, rect.width - thumbWidth)
    const thumbLeft = Math.min(travel, Math.max(0, clientX - rect.left - thumbWidth / 2))
    element.scrollLeft = (thumbLeft / travel) * tabScroll.maxScrollLeft
  }

  const getDropBeforeTabId = (event: React.DragEvent<HTMLElement>, tab: DocTab) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientX - rect.left > rect.width / 2
    if (!after) return { beforeTabId: tab.id, side: 'before' as const }
    return { beforeTabId: tabs[tabs.findIndex((item) => item.id === tab.id) + 1]?.id ?? null, side: 'after' as const }
  }

  const resolveDropZone = (event: React.DragEvent<HTMLElement>): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const edgeX = Math.min(96, Math.max(56, rect.width * 0.25))
    const edgeY = Math.min(96, Math.max(56, rect.height * 0.25))
    if (x <= edgeX) return 'left'
    if (x >= rect.width - edgeX) return 'right'
    if (y <= edgeY) return 'top'
    if (y >= rect.height - edgeY) return 'bottom'
    return 'center'
  }

  return (
    <section
      // flex-col 필수: 탭 바(상단)와 에디터 본문(하단)의 세로 스택. 빠지면 탭 바가
      // 왼쪽에 세로 기둥으로 서는 깨진 레이아웃이 된다.
      // 활성 패널 표시는 분할이 실제로 있을 때만 — 패널 하나뿐일 때 상시 파란 테두리는 소음.
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-white ${
        canClosePanel && isActivePanel ? 'ring-1 ring-inset ring-[#4a9eff]/45' : ''
      }`}
      onMouseDown={() => onFocusPanel(panel.id)}
      aria-label="편집 패널"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('text/doc-tab')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropZone(resolveDropZone(event))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null)
      }}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData('text/doc-tab')
        const sourcePanelId = event.dataTransfer.getData('text/doc-tab-source')
        const zone = resolveDropZone(event)
        setDropZone(null)
        if (!tabsById.has(tabId) || !sourcePanelId) return
        event.preventDefault()
        onDropTab(tabId, sourcePanelId, panel.id, zone)
      }}
    >
      <div
        className="relative flex h-9 shrink-0 min-w-0 items-center border-b border-[#e9e9e7] bg-[#f7f7f5]"
        // 탭 줄 위에 드롭 = VS Code 처럼 "이 그룹으로 이동" (섹션의 가장자리 판정('top' 분할)이
        // 탭 줄까지 먹지 않도록 여기서 가로챈다)
      >
        <div className="relative h-full min-w-0 flex-1">
          <div
            ref={tabScrollRef}
            className="scrollbar-none flex h-full w-full min-w-0 items-center overflow-x-auto"
            onWheel={(event) => {
              // 탭 줄 위의 일반 휠도 좌우 탐색으로 쓸 수 있게 한다.
              if (event.deltaY === 0 || event.deltaX !== 0) return
              event.currentTarget.scrollLeft += event.deltaY
              event.preventDefault()
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('text/doc-tab')) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setDropZone('center')
              setTabDropTarget(null)
            }}
            onDrop={(event) => {
              const tabId = event.dataTransfer.getData('text/doc-tab')
              const sourcePanelId = event.dataTransfer.getData('text/doc-tab-source')
              setDropZone(null)
              setTabDropTarget(null)
              if (!tabsById.has(tabId) || !sourcePanelId) return
              event.preventDefault()
              event.stopPropagation()
              // 탭 사이의 빈 공간으로 놓으면 이 패널의 마지막 탭 뒤에 둔다.
              onDropTab(tabId, sourcePanelId, panel.id, 'center')
            }}
          >
            <div className="flex h-full min-w-max items-center">
            {tabs.map((tab) => {
              const active = tab.id === activeTab?.id
              const tabDropSide = tabDropTarget?.id === tab.id ? tabDropTarget.side : null
              return (
                <div
                  key={tab.id}
                  draggable
                  data-document-tab-id={tab.id}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/doc-tab', tab.id)
                    event.dataTransfer.setData('text/doc-tab-source', panel.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes('text/doc-tab')) return
                    const { side } = getDropBeforeTabId(event, tab)
                    event.preventDefault()
                    event.stopPropagation()
                    event.dataTransfer.dropEffect = 'move'
                    setDropZone('center')
                    setTabDropTarget((current) => current?.id === tab.id && current.side === side ? current : { id: tab.id, side })
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setTabDropTarget((current) => current?.id === tab.id ? null : current)
                    }
                  }}
                  onDrop={(event) => {
                    const tabId = event.dataTransfer.getData('text/doc-tab')
                    const sourcePanelId = event.dataTransfer.getData('text/doc-tab-source')
                    const { beforeTabId } = getDropBeforeTabId(event, tab)
                    setDropZone(null)
                    setTabDropTarget(null)
                    if (!tabsById.has(tabId) || !sourcePanelId) return
                    event.preventDefault()
                    event.stopPropagation()
                    onDropTab(tabId, sourcePanelId, panel.id, 'center', beforeTabId)
                  }}
                  onDragEnd={() => {
                    setDropZone(null)
                    setTabDropTarget(null)
                  }}
                  onContextMenu={(event) => {
                    // 우클릭 → 상단바 고정/해제 메뉴
                    event.preventDefault()
                    setTabMenu({ x: event.clientX, y: event.clientY, tab })
                  }}
                  className={`group flex h-full shrink-0 items-center gap-1 border-r border-[#e9e9e7] px-2.5 text-[12px] ${
                    active ? 'bg-white text-[#37352f]' : 'text-[#7d7c78] hover:bg-[#ececea]'
                  } ${tabDropSide === 'before' ? 'border-l-2 border-l-[#4a9eff]' : ''} ${tabDropSide === 'after' ? 'border-r-2 border-r-[#4a9eff]' : ''}`}
                >
                  <button className="flex max-w-[200px] items-center gap-1 truncate" onClick={() => onActivateTab(panel.id, tab)} title={`${tab.target} — 우클릭: 상단바 고정`}>
                    {pinnedNotes.includes(tab.target) && <span className="text-[9px]">📌</span>}
                    <span className="text-[13px]">{tab.icon}</span>
                    <span className="truncate">{tab.title}</span>
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${
                      active ? 'text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]' : 'text-[#9b9a97] opacity-0 group-hover:opacity-100 hover:bg-[#e0e0de]'
                    }`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onCloseTab(panel.id, tab.id)
                    }}
                    title="탭 닫기"
                    aria-label={`${tab.title} 탭 닫기`}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            </div>
          </div>
          {tabScroll.overflow && (
            <div
              role="scrollbar"
              aria-label="열린 탭 좌우 스크롤"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                tabScroll.maxScrollLeft > 0
                  ? Math.round((tabScroll.scrollLeft / tabScroll.maxScrollLeft) * 100)
                  : 0
              }
              aria-valuetext={`${Math.round(
                tabScroll.maxScrollLeft > 0 ? (tabScroll.scrollLeft / tabScroll.maxScrollLeft) * 100 : 0,
              )}% 위치`}
              tabIndex={0}
              className="tab-swipebar absolute inset-x-0 bottom-0 z-20 h-2 cursor-ew-resize rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-[#4a9eff]"
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                swipeTabsTo(event.currentTarget, event.clientX)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  swipeTabsTo(event.currentTarget, event.clientX)
                }
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onPointerCancel={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  scrollTabs(-1)
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  scrollTabs(1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  if (tabScrollRef.current) tabScrollRef.current.scrollLeft = 0
                } else if (event.key === 'End') {
                  event.preventDefault()
                  if (tabScrollRef.current) tabScrollRef.current.scrollLeft = tabScroll.maxScrollLeft
                }
              }}
            >
              <span
                className="tab-swipebar__thumb absolute bottom-0 h-[2px] rounded-full"
                style={{ left: `${tabScroll.thumbLeft}%`, width: `${tabScroll.thumbWidth}%` }}
              />
            </div>
          )}
        </div>
        {(tabScroll.left || tabScroll.right) && (
          <div className="flex h-full shrink-0 border-l border-[#e9e9e7] bg-[#f7f7f5]">
            <button
              className="h-full px-2 text-[14px] text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f] disabled:cursor-not-allowed disabled:opacity-35"
              onClick={() => scrollTabs(-1)}
              disabled={!tabScroll.left}
              title="왼쪽 탭 보기"
              aria-label="왼쪽 탭 보기"
            >
              ‹
            </button>
            <button
              className="h-full border-l border-[#e9e9e7] px-2 text-[14px] text-[#7d7c78] hover:bg-[#ececea] hover:text-[#37352f] disabled:cursor-not-allowed disabled:opacity-35"
              onClick={() => scrollTabs(1)}
              disabled={!tabScroll.right}
              title="오른쪽 탭 보기"
              aria-label="오른쪽 탭 보기"
            >
              ›
            </button>
          </div>
        )}
        {canClosePanel && (
          <button
            className="h-full shrink-0 border-l border-[#e9e9e7] px-2 text-[12px] text-[#9b9a97] hover:bg-[#ececea] hover:text-[#37352f]"
            onClick={() => onClosePanel(panel.id)}
            title="이 패널의 탭을 인접 패널에 합치고 패널 닫기"
            aria-label="패널 닫기"
          >
            ×
          </button>
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1" onMouseDown={() => onFocusPanel(panel.id)}>
        {activeTab ? (
          activeTab.kind === 'erd' ? <ErdWorkspace tab={activeTab} /> : <Editor path={activeTab.target} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[#9b9a97]">
            <span className="text-2xl">▧</span>
            <p className="text-[13px]">비어 있는 편집 패널입니다</p>
            <p className="text-[12px]">파일 트리나 상단 탭에서 노트를 열면 이 패널에 표시됩니다.</p>
          </div>
        )}
      </div>
      {dropZone && <DropGuide zone={dropZone} />}

      {/* 탭 우클릭 메뉴 — 상단바 고정/해제 · 탭 닫기 */}
      {tabMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setTabMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setTabMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-44 rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg"
            style={{
              left: Math.min(tabMenu.x, window.innerWidth - 180),
              top: Math.min(tabMenu.y, window.innerHeight - 160),
            }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f1f1ef]"
              onClick={() => {
                togglePinnedNote(tabMenu.tab.target)
                setTabMenu(null)
              }}
            >
              <span>📌</span>
              {pinnedNotes.includes(tabMenu.tab.target) ? '상단바 고정 해제' : '상단바에 고정'}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={() => {
                onCloseTab(panel.id, tabMenu.tab.id)
                setTabMenu(null)
              }}
            >
              <span>✕</span> 탭 닫기
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:cursor-not-allowed disabled:text-[#c8c7c4]"
              disabled={tabs.length <= 1}
              onClick={() => {
                const keepId = tabMenu.tab.id
                setTabMenu(null)
                void onCloseTabs(panel.id, tabs.filter((tab) => tab.id !== keepId).map((tab) => tab.id))
              }}
            >
              <span>⊟</span> 기타 닫기
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={() => {
                setTabMenu(null)
                void onCloseTabs(panel.id, tabs.map((tab) => tab.id))
              }}
            >
              <span>⊠</span> 모두 닫기
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function DropGuide({ zone }: { zone: DropZone }) {
  const guideClass: Record<DropZone, string> = {
    center: 'inset-[22%] rounded-lg border-2 border-[#4a9eff] bg-[#4a9eff]/10',
    left: 'inset-y-3 left-3 w-[24%] rounded-l-lg border-2 border-[#4a9eff] bg-[#4a9eff]/12',
    right: 'inset-y-3 right-3 w-[24%] rounded-r-lg border-2 border-[#4a9eff] bg-[#4a9eff]/12',
    top: 'inset-x-3 top-3 h-[24%] rounded-t-lg border-2 border-[#4a9eff] bg-[#4a9eff]/12',
    bottom: 'inset-x-3 bottom-3 h-[24%] rounded-b-lg border-2 border-[#4a9eff] bg-[#4a9eff]/12',
  }
  const label: Record<DropZone, string> = {
    center: '이 패널로 이동',
    left: '왼쪽으로 분할',
    right: '오른쪽으로 분할',
    top: '위쪽으로 분할',
    bottom: '아래쪽으로 분할',
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-20 bg-[#4a9eff]/[0.03]" aria-hidden="true">
      <div className={`absolute flex items-center justify-center text-[12px] font-medium text-[#216fbe] ${guideClass[zone]}`}>
        {label[zone]}
      </div>
    </div>
  )
}
