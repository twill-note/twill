import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { Section, TreeNode } from '../types'
import { dialog } from '../dialog'
import { displayCombo, IS_MAC } from '../shortcuts'
import ProjectPathDialog from './ProjectPathDialog'
import { useAiStore } from '../aiStore'
import { notifyWorkspaceScopesChanged } from '../workspaceScopeEvents'
import { useBackdropDismiss } from '../useBackdropDismiss'
import ProjectAiTasks from './ProjectAiTasks'
import { sessionProjectId } from '../aiProjectGroups'
import { tr } from '../i18n'

interface MenuState {
  x: number
  y: number
  node: TreeNode | null // null = 루트 빈 공간
  section?: Section | null // 프로젝트 헤더 우클릭
}

/** 자동 미할당 프로젝트 id — 사용자가 만든 프로젝트와 충돌 없게 예약. */
const UNASSIGNED_ID = '__unassigned__'
const COPY_PATH_COMBO = 'Mod+Shift+KeyC'
const REVEAL_IN_EXPLORER_COMBO = 'Mod+KeyE'
const COPY_PATH_SHORTCUT = displayCombo(COPY_PATH_COMBO)
const REVEAL_IN_EXPLORER_SHORTCUT = displayCombo(REVEAL_IN_EXPLORER_COMBO)

type TreeShortcutEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

function isModShortcut(event: TreeShortcutEvent, combo: string): boolean {
  const parts = combo.split('+')
  const code = parts[parts.length - 1]
  return event.code === code && event.shiftKey === parts.includes('Shift') && (IS_MAC
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey)
}

function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const child = findTreeNode(node.children ?? [], path)
    if (child) return child
  }
  return null
}

/** 노트 루트와 트리의 상대 경로를 현재 OS 형식의 절대 경로로 합친다. */
function absoluteWorkspacePath(root: string | null, path: string): string {
  if (!root) return path
  const separator = root.includes('\\') ? '\\' : '/'
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedPath = separator === '\\' ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/')
  return `${normalizedRoot}${separator}${normalizedPath}`
}

export default function FileTree() {
  const {
    tree,
    sections,
    currentPath,
    erdPath,
    root,
    openFile,
    openErdDesigner,
    createErdDiagram,
    refreshTree,
    refreshTags,
    refreshSections,
    saveSections,
    closeFile,
    openDatabase,
  } = useAppStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [rootExpanded, setRootExpandedState] = useState<boolean>(() => localStorage.getItem('filetree.root-expanded') !== '0')
  const setRootExpanded = (v: boolean) => {
    setRootExpandedState(v)
    localStorage.setItem('filetree.root-expanded', v ? '1' : '0')
  }
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const previousErdPath = useRef<string | null>(erdPath)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ dir: string; type: 'file' | 'dir' } | null>(null)
  const [addingSection, setAddingSection] = useState(false)
  const [pathDialog, setPathDialog] = useState<{ project: Section; creation: boolean } | null>(null)
  const [templating, setTemplating] = useState<{ dir: string } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragOverSection, setDragOverSection] = useState<string | null>(null)
  const sessions = useAiStore((s) => s.sessions)
  const [sessionsError, setSessionsError] = useState('')

  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try {
        await useAiStore.getState().loadSessions()
        if (!disposed) setSessionsError('')
      } catch { if (!disposed) setSessionsError('AI 작업 목록을 불러오지 못했습니다.') }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [root])

  const projectSessions = new Map<string, typeof sessions>()
  for (const session of sessions) {
    const projectId = sessionProjectId(session, sections) ?? UNASSIGNED_ID
    const items = projectSessions.get(projectId) ?? []
    items.push(session)
    projectSessions.set(projectId, items)
  }

  useEffect(() => {
    refreshSections().catch(() => {})
  }, [refreshSections])

  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // 제목 기반 저장이 ERD 파일을 바꾸면 활성 경로는 전역 스토어에서 즉시 갱신된다.
  // 키보드 조작을 위한 트리의 로컬 선택도 이전 ERD를 가리켰을 때만 함께 옮긴다.
  useEffect(() => {
    const previous = previousErdPath.current
    if (previous && erdPath && selectedPath === previous) setSelectedPath(erdPath)
    previousErdPath.current = erdPath
  }, [erdPath, selectedPath])

  // 메뉴가 실제로 렌더링된 크기를 측정해서 뷰포트 밖으로 나가면 위/왼쪽으로 밀어냄.
  // 고정 높이를 가정하면(예: 섹션이 많아서 메뉴가 길어질 때) 하단이 잘리는 문제가 있었음.
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null)
      return
    }
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = menu.x
    let top = menu.y
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin)
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin)
    setMenuPos({ left, top })
  }, [menu])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectNode = (path: string) => {
    setSelectedPath(path)
    treeRef.current?.focus()
  }

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(absoluteWorkspacePath(root, path))
    } catch {
      dialog.alert('경로를 클립보드에 복사하지 못했습니다')
    }
  }

  const revealInSystemExplorer = (node: TreeNode | null) => {
    const target = !node ? '' : node.type === 'dir' ? node.path : parentOf(node.path)
    return api.reveal(target).catch((e) => dialog.alert((e as Error).message))
  }

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selectedPath) return
    if (isModShortcut(event, COPY_PATH_COMBO)) {
      event.preventDefault()
      event.stopPropagation()
      void copyPath(selectedPath)
      return
    }
    if (isModShortcut(event, REVEAL_IN_EXPLORER_COMBO)) {
      const node = findTreeNode(tree, selectedPath)
      if (!node) return
      event.preventDefault()
      event.stopPropagation()
      void revealInSystemExplorer(node)
    }
  }

  // ─────────────────────────────────────────────────────────
  // 프로젝트 계산: 루트 자식들을 프로젝트 순서대로 배치, 나머지는 "Root" 로.
  // ─────────────────────────────────────────────────────────
  const rootByPath = new Map(tree.map((n) => [n.path, n]))
  const assigned = new Set<string>()
  const displaySections: {
    id: string
    name: string
    expanded: boolean
    nodes: TreeNode[]
    projectPath?: string | null
    system?: boolean
  }[] = []
  for (const s of sections) {
    const nodes: TreeNode[] = []
    for (const p of s.items) {
      const n = rootByPath.get(p)
      if (n && !assigned.has(p)) {
        nodes.push(n)
        assigned.add(p)
      }
    }
    displaySections.push({
      id: s.id,
      name: s.name,
      expanded: s.expanded,
      nodes,
      projectPath: s.project_path,
    })
  }
  const unassigned = tree.filter((n) => !assigned.has(n.path))
  if (unassigned.length > 0 || projectSessions.has(UNASSIGNED_ID) || sections.length === 0) {
    displaySections.push({
      id: UNASSIGNED_ID, name: 'Root', expanded: rootExpanded, nodes: unassigned,
      system: true,
    })
  }

  const handleCreate = async (name: string) => {
    if (!creating) return
    const trimmed = name.trim()
    setCreating(null)
    if (!trimmed) return
    try {
      const path = creating.dir ? `${creating.dir}/${trimmed}` : trimmed
      const res = await api.createEntry(path, creating.type)
      await refreshTree()
      if (creating.dir) setExpanded((prev) => new Set(prev).add(creating.dir))
      if (creating.type === 'file') openFile(res.path)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const handleRename = async (node: TreeNode, name: string) => {
    setRenaming(null)
    const trimmed = name.trim()
    if (!trimmed || trimmed === node.name) return
    try {
      const res = await api.rename(node.path, trimmed)
      // 프로젝트에 등록된 문서 경로도 갱신
      const oldPath = node.path
      const newPath = res.path.endsWith('.md') && node.type === 'dir' ? res.path.replace(/\.md$/, '') : res.path
      const updated = sections.map((s) => ({
        ...s,
        items: s.items.map((p) => (p === oldPath ? newPath : p)),
      }))
      if (updated.some((s, i) => s.items.some((p, j) => p !== sections[i].items[j]))) {
        await saveSections(updated)
      }
      await refreshTree()
      await refreshTags()
      if (selectedPath === oldPath) setSelectedPath(res.path)
      if (currentPath === node.path) openFile(res.path)
      else if (currentPath?.startsWith(node.path + '/')) closeFile()
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const handleDelete = async (node: TreeNode) => {
    const ok = await dialog.confirm(`"${node.name}"을(를) 휴지통으로 이동할까요?`, {
      danger: true,
      confirmLabel: '휴지통으로 이동',
    })
    if (!ok) return
    try {
      await api.remove(node.path)
      // 프로젝트에서도 제거
      const updated = sections.map((s) => ({
        ...s,
        items: s.items.filter((p) => p !== node.path),
      }))
      if (updated.some((s, i) => s.items.length !== sections[i].items.length)) {
        await saveSections(updated)
      }
      await refreshTree()
      await refreshTags()
      if (selectedPath === node.path) setSelectedPath(null)
      if (currentPath === node.path || currentPath?.startsWith(node.path + '/')) closeFile()
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const handleDrop = async (destDir: string, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)

    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length > 0) {
      try {
        const res = await api.importFiles(dropped, destDir)
        await refreshTree()
        await refreshTags()
        if (destDir) setExpanded((prev) => new Set(prev).add(destDir))
        if (res.skipped.length > 0)
          dialog.alert('.md 파일만 추가할 수 있습니다', { detail: `제외됨: ${res.skipped.join(', ')}` })
        if (res.created.length === 1) openFile(res.created[0])
      } catch (e2) {
        dialog.alert((e2 as Error).message)
      }
      return
    }

    const src = e.dataTransfer.getData('text/note-path')
    if (!src) return
    const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
    if (srcParent === destDir || src === destDir || destDir.startsWith(src + '/')) return
    try {
      const res = await api.move(src, destDir)
      await refreshTree()
      if (selectedPath === src) setSelectedPath(res.path)
      if (currentPath === src) openFile(res.path)
      else if (currentPath?.startsWith(src + '/')) closeFile()
    } catch (e2) {
      dialog.alert((e2 as Error).message)
    }
  }

  // ─────────────────────────────────────────────────────────
  // 프로젝트 관리
  // ─────────────────────────────────────────────────────────
  const addSection = async (name: string) => {
    setAddingSection(false)
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      // 코드 경로보다 프로젝트와 독립 문서 저장소를 먼저 만든다.
      const { section } = await api.workspaceSettings.createProjectSection(trimmed)
      notifyWorkspaceScopesChanged()
      await refreshSections()
      await refreshTree()
      const projectDir = section.items[0]
      if (projectDir) setExpanded((prev) => new Set(prev).add(projectDir))
      setPathDialog({ project: section, creation: true })
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const renameSection = async (sid: string, name: string) => {
    setRenamingSection(null)
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await api.workspaceSettings.renameProject(sid, trimmed)
      await refreshSections()
      notifyWorkspaceScopesChanged()
    } catch (reason) {
      dialog.alert((reason as Error).message)
    }
  }

  const deleteSection = async (sid: string) => {
    const target = sections.find((s) => s.id === sid)
    if (!target) return
    try {
      if (!target.scope_id) {
        const ok = await dialog.confirm(`프로젝트 "${target.name}"을(를) 삭제할까요?`, {
          detail: '프로젝트의 폴더와 노트는 그대로 유지되며 "Root" 로 이동합니다.',
          confirmLabel: '프로젝트 삭제',
          danger: true,
        })
        if (ok) await saveSections(sections.filter((s) => s.id !== sid))
        return
      }

      const preview = await api.workspaceSettings.previewScopeDeletion(target.scope_id)
      if (!preview.can_delete) {
        const blockers = preview.blocking_tasks.map((task) => `• ${task.title} — ${task.state}`).join('\n')
        await dialog.alert('실행 중인 태스크가 있어 프로젝트를 삭제할 수 없습니다.', { detail: blockers })
        return
      }
      const impact = [
        '프로젝트의 문서 폴더와 노트, 연결된 외부 코드 경로는 삭제하지 않습니다.',
        `연결된 태스크 ${preview.task_count}개의 프로젝트 지정은 해제됩니다.`,
        '기존 AI 대화와 실행 기록은 유지됩니다.',
      ].join('\n')
      const ok = await dialog.confirm(`프로젝트 "${target.name}"을(를) 삭제할까요?`, {
        detail: impact,
        confirmLabel: '프로젝트 삭제',
        danger: true,
      })
      if (!ok) return
      await api.workspaceSettings.deleteScope(target.scope_id)
      await refreshSections()
      await useAiStore.getState().loadSessions()
      notifyWorkspaceScopesChanged()
    } catch (reason) {
      dialog.alert((reason as Error).message)
    }
  }

  const toggleSection = (sid: string) => {
    if (sid === UNASSIGNED_ID) {
      setRootExpanded(!rootExpanded)
      return
    }
    saveSections(sections.map((s) => (s.id === sid ? { ...s, expanded: !s.expanded } : s)))
  }

  const moveToSection = async (nodePath: string, targetSid: string | null) => {
    // targetSid=null → Root로 (모든 프로젝트에서 제거)
    const cleaned = sections.map((s) => ({ ...s, items: s.items.filter((p) => p !== nodePath) }))
    if (targetSid === null || targetSid === UNASSIGNED_ID) {
      await saveSections(cleaned)
      return
    }
    const next = cleaned.map((s) => (s.id === targetSid ? { ...s, items: [...s.items, nodePath] } : s))
    await saveSections(next)
  }

  const connectProjectPath = async (project: Section, path: string) => {
    await api.workspaceSettings.setProjectPath(project.id, path)
    await refreshSections()
    notifyWorkspaceScopesChanged()
    setPathDialog(null)
  }

  const dropOnSection = async (sid: string, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverSection(null)
    const src = e.dataTransfer.getData('text/note-path')
    if (!src) return
    // 루트 직계만 프로젝트에 배정 가능
    const isRootItem = !src.includes('/')
    if (!isRootItem) {
      // 서브 항목: 이동 후 프로젝트 배정은 다음 refreshTree 사이클에서
      // 여기서는 무시 (프로젝트 경계로 드롭한 경우엔 이동시키지 않음)
      return
    }
    await moveToSection(src, sid === UNASSIGNED_ID ? null : sid)
  }

  const renderNodes = (nodes: TreeNode[], depth: number) => (
    <>
      {nodes.map((node) => {
        const visibleChildren = node.children ?? []
        const hasChildren = visibleChildren.length > 0
        const isExpanded = expanded.has(node.path)
        const creatingHere = creating && creating.dir === childDirOf(node)
        return (
          <div key={node.path}>
            {renaming === node.path ? (
              <InlineInput
                depth={depth}
                defaultValue={node.name}
                onSubmit={(v) => handleRename(node, v)}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <div
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/note-path', node.path)}
                onDragOver={(e) => {
                  if (node.type === 'dir') {
                    e.preventDefault()
                    setDragOver(node.path)
                  }
                }}
                onDragLeave={() => setDragOver((d) => (d === node.path ? null : d))}
                onDrop={(e) => node.type === 'dir' && handleDrop(node.path, e)}
                onClick={() => {
                  // 기타 형식은 표시와 우클릭 관리만 지원한다. 좌클릭은 선택 상태도 바꾸지 않는다.
                  if (node.type === 'other') return
                  selectNode(node.path)
                  if (node.type === 'dir') toggle(node.path)
                  else if (node.type === 'erd') openErdDesigner(node.path)
                  else openFile(node.path)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  selectNode(node.path)
                  setMenu({ x: e.clientX, y: e.clientY, node })
                }}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-[3px] text-[13px] leading-5 select-none
                  ${(currentPath === node.path || erdPath === node.path) ? 'bg-[#e8e7e4] font-medium text-[#37352f]' : selectedPath === node.path ? 'bg-[#efefed] text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#efefed]'}
                  ${dragOver === node.path ? 'ring-1 ring-blue-400' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={node.path}
              >
                <span
                  className="w-4 shrink-0 text-center text-[10px] text-[#9b9a97] hover:text-[#37352f]"
                  onClick={(e) => {
                    if (node.type === 'file' && hasChildren) {
                      e.stopPropagation()
                      toggle(node.path)
                    }
                  }}
                >
                  {node.type === 'dir' || hasChildren ? (isExpanded ? '▾' : '▸') : ''}
                </span>
                <span className="shrink-0">
                  {node.special === 'agents' ? '🎯' : node.special === 'memories' ? '🧠' : node.type === 'dir' ? '📁' : node.type === 'erd' ? '🗄️' : node.type === 'other' ? '📎' : (node.icon ?? '📄')}
                </span>
                <span className="truncate">{node.type === 'file' ? node.name.replace(/\.md$/, '') : node.type === 'erd' ? node.name.replace(/\.erd\.json$/, '') : node.name}</span>
                {node.db && (
                  <span
                    className="ml-1 shrink-0 rounded bg-[#e7f5ef] px-1 text-[9px] font-medium text-[#0f7a48]"
                    title={tr("데이터베이스 (행은 DB 뷰에서만 표시)")}
                  >
                    DB
                  </span>
                )}
                {node.special === 'agents' && (
                  <span
                    className="ml-1 shrink-0 rounded bg-[#fef3c7] px-1 text-[9px] font-medium text-[#92400e]"
                    title={tr("노트 워크스페이스 AGENTS.md (Codex가 현재 작업 경로에서 자동 탐색)")}
                  >
                    AGENTS
                  </span>
                )}
                {node.special === 'memories' && (
                  <span
                    className="ml-1 shrink-0 rounded bg-[#ede9fe] px-1 text-[9px] font-medium text-[#6f5aa8]"
                    title={tr("AI 메모리 노트 (필요할 때 검색하고 직접 검토·편집)")}
                  >
                    MEM
                  </span>
                )}
              </div>
            )}
            {(isExpanded || creatingHere) && (node.type === 'dir' || hasChildren || creatingHere) && (
              <div>
                {isExpanded && renderNodes(visibleChildren, depth + 1)}
                {creatingHere && (
                  <InlineInput
                    depth={depth + 1}
                    placeholder={creating!.type === 'file' ? tr("새 노트 이름") : tr("새 폴더 이름")}
                    onSubmit={handleCreate}
                    onCancel={() => setCreating(null)}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )

  return (
    <div
      ref={treeRef}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto px-1 py-2"
      onKeyDown={handleTreeKeyDown}
      onContextMenu={(e) => {
        e.preventDefault()
        setSelectedPath(null)
        setMenu({ x: e.clientX, y: e.clientY, node: null })
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => handleDrop('', e)}
    >
      {/* 파일 트리 헤더: 프로젝트 추가 · 새 폴더 · 새 노트 */}
      <div className="mb-1 flex items-center justify-between px-2 pt-0.5 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">{tr("파일")}</span>
        <div className="flex gap-0.5">
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#e8e7e4] hover:text-[#37352f]"
            title={tr("새 프로젝트 추가")}
            onClick={() => setAddingSection(true)}
          >

            {tr("+ 프로젝트")}
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#e8e7e4] hover:text-[#37352f]"
            title={tr("루트에 새 폴더")}
            onClick={() => setCreating({ dir: '', type: 'dir' })}
          >
            📁+
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#e8e7e4] hover:text-[#37352f]"
            title={tr("루트에 새 노트")}
            onClick={() => setCreating({ dir: '', type: 'file' })}
          >
            📄+
          </button>
        </div>
      </div>

      {addingSection && (
        <InlineInput
          depth={0}
          placeholder={tr("새 프로젝트 이름 (예: 쇼핑몰, 사내 도구…)")}
          onSubmit={addSection}
          onCancel={() => setAddingSection(false)}
        />
      )}

      {/* 프로젝트 목록 */}
      {displaySections.map((s) => {
        return (
        <div key={s.id} className="mb-1">
          {renamingSection === s.id ? (
            <InlineInput
              depth={0}
              defaultValue={s.name}
              onSubmit={(v) => renameSection(s.id, v)}
              onCancel={() => setRenamingSection(null)}
            />
          ) : (
            <div
              className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97] select-none
                ${dragOverSection === s.id ? 'rounded bg-[#e0e0de]' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverSection(s.id)
              }}
              onDragLeave={() => setDragOverSection((v) => (v === s.id ? null : v))}
              onDrop={(e) => dropOnSection(s.id, e)}
              onContextMenu={(e) => {
                if (s.system) return
                e.preventDefault()
                e.stopPropagation()
                setSelectedPath(null)
                setMenu({ x: e.clientX, y: e.clientY, node: null, section: sections.find((x) => x.id === s.id) })
              }}
            >
              <button
                className="flex flex-1 items-center gap-1 text-left hover:text-[#5f5e5b]"
                onClick={() => toggleSection(s.id)}
              >
                <span className="w-2 text-[9px]">{s.expanded ? '▾' : '▸'}</span>
                <span className="truncate">{s.name}</span>
                <span className="ml-1 text-[10px] text-[#c9c8c4]">{s.nodes.length}</span>
                {s.projectPath ? (
                  <span
                    className="ml-1 shrink-0 text-[9px] font-normal normal-case tracking-normal text-[#6f8f76]"
                    title={`코드·분석 경로 연결됨: ${s.projectPath}`}
                  >
                    🔗
                  </span>
                ) : null}
              </button>
              {!s.system && (
                <>
                  <button
                    className="rounded px-1 text-[11px] text-[#c9c8c4] hover:text-[#5f5e5b]"
                    title={tr("프로젝트 옵션")}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.target as HTMLElement).getBoundingClientRect()
                      setMenu({ x: r.right, y: r.bottom, node: null, section: sections.find((x) => x.id === s.id) })
                    }}
                  >
                    ⋯
                  </button>
                </>
              )}
            </div>
          )}
          {s.expanded && (
            <div>
              {renderNodes(s.nodes, 0)}
              {s.nodes.length === 0 && (
                <p className="px-3 py-1 text-[11px] text-[#c9c8c4]">

                  {tr("(비어있음 — 폴더/노트를 여기로 드래그)")}
                </p>
              )}
              <ProjectAiTasks key={`${root}:${s.id}`} projectId={s.id} sessions={projectSessions.get(s.id) ?? []} error={sessionsError} />
            </div>
          )}
        </div>
        )
      })}

      {/* 루트에서 바로 새 항목 만들기 (프로젝트 밖) */}
      {creating && creating.dir === '' && (
        <InlineInput
          depth={0}
          placeholder={creating.type === 'file' ? tr("새 노트 이름") : tr("새 폴더 이름")}
          onSubmit={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}
      {tree.length === 0 && !creating && (
        <p className="px-3 py-2 text-[12px] text-[#9b9a97]">

          {tr("우클릭으로 첫 노트를 만들어 보세요")}
        </p>
      )}

      {/* 하단 빈 공간 — 트리가 짧아도 "새 노트/폴더" 우클릭 메뉴를 띄울 여지 정도만 확보.
          메뉴 위치는 이제 실제 렌더 크기를 측정해 clamp 하므로 큰 여백이 필요 없음. */}
      <div
        className="min-h-[40px]"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setSelectedPath(null)
          setMenu({ x: e.clientX, y: e.clientY, node: null })
        }}
      />


      {templating && (
        <TemplateModal
          dir={templating.dir}
          onClose={() => setTemplating(null)}
          onCreated={async (path) => {
            setTemplating(null)
            await refreshTree()
            await refreshTags()
            openFile(path)
          }}
        />
      )}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] max-h-[80vh] overflow-y-auto rounded-lg border border-[#e3e2e0] bg-white py-1 text-[13px] shadow-lg"
          style={{
            left: (menuPos ?? { left: menu.x, top: menu.y }).left,
            top: (menuPos ?? { left: menu.x, top: menu.y }).top,
            visibility: menuPos ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 프로젝트 헤더 우클릭 메뉴 */}
          {menu.section && (
            <>
              <MenuItem
                label={tr("✏️ 프로젝트 이름 변경")}
                onClick={() => {
                  setRenamingSection(menu.section!.id)
                  setMenu(null)
                }}
              />
              <MenuItem
                label={menu.section.project_path ? tr("🔗 프로젝트 경로 변경") : tr("🔗 프로젝트 경로 지정")}
                onClick={() => {
                  setPathDialog({ project: menu.section!, creation: false })
                  setMenu(null)
                }}
              />
              <MenuItem
                label={tr("🗑️ 프로젝트 삭제")}
                danger
                onClick={() => {
                  deleteSection(menu.section!.id)
                  setMenu(null)
                }}
              />
            </>
          )}

          {/* 트리 노드/빈공간 우클릭 메뉴 */}
          {!menu.section && (
            <>
              <MenuItem
                label={tr("🗂️ 새 프로젝트")}
                onClick={() => {
                  setAddingSection(true)
                  setMenu(null)
                }}
              />
              <div className="my-1 border-t border-[#eeeeec]" />
              {menu.node && (
                <MenuItem
                  label={`📋 경로 복사 (${COPY_PATH_SHORTCUT})`}
                  onClick={() => {
                    void copyPath(menu.node!.path)
                    setMenu(null)
                  }}
                />
              )}
              <MenuItem
                label={tr("📄 새 노트")}
                onClick={() => {
                  const dir = !menu.node ? '' : menu.node.type === 'dir' ? menu.node.path : parentOf(menu.node.path)
                  if (menu.node?.type === 'dir') setExpanded((prev) => new Set(prev).add(menu.node!.path))
                  setCreating({ dir, type: 'file' })
                  setMenu(null)
                }}
              />
              <MenuItem
                label={tr("📁 새 폴더")}
                onClick={() => {
                  const dir = !menu.node ? '' : menu.node.type === 'dir' ? menu.node.path : parentOf(menu.node.path)
                  if (menu.node?.type === 'dir') setExpanded((prev) => new Set(prev).add(menu.node!.path))
                  setCreating({ dir, type: 'dir' })
                  setMenu(null)
                }}
              />
              {menu.node?.type === 'dir' && (
                <MenuItem
                  label={tr("🗄️ 새 테이블")}
                  onClick={() => {
                    createErdDiagram(menu.node!.path)
                    setMenu(null)
                  }}
                />
              )}
              {menu.node?.type === 'file' && (
                <MenuItem
                  label={tr("🗒️ 새 하위 노트")}
                  onClick={() => {
                    const dir = childDirOf(menu.node!)
                    setExpanded((prev) => new Set(prev).add(menu.node!.path))
                    setCreating({ dir, type: 'file' })
                    setMenu(null)
                  }}
                />
              )}
              <MenuItem
                label={tr("📋 템플릿으로 새 노트")}
                onClick={() => {
                  const dir = !menu.node ? '' : childDirOf(menu.node)
                  if (menu.node) setExpanded((prev) => new Set(prev).add(menu.node!.path))
                  setTemplating({ dir })
                  setMenu(null)
                }}
              />
              {(!menu.node || menu.node.type === 'dir') && (
                <MenuItem
                  label={tr("📊 테이블로 보기")}
                  onClick={() => {
                    openDatabase(menu.node?.path ?? '')
                    setMenu(null)
                  }}
                />
              )}
              {/* 프로젝트 배정: 루트 직계 항목만 가능 */}
              {menu.node && !menu.node.path.includes('/') && (
                <>
                  <div className="my-1 border-t border-[#eeeeec]" />
                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-[#9b9a97]">{tr("프로젝트")}</div>
                  {sections.map((sec) => {
                    const inThisSection = sec.items.includes(menu.node!.path)
                    return (
                      <MenuItem
                        key={sec.id}
                        label={`${inThisSection ? '✓' : '  '} ${sec.name}`}
                        onClick={() => {
                          moveToSection(menu.node!.path, sec.id)
                          setMenu(null)
                        }}
                      />
                    )
                  })}
                  <MenuItem
                    label={tr('Root (프로젝트에서 빼기)')}
                    onClick={() => {
                      moveToSection(menu.node!.path, null)
                      setMenu(null)
                    }}
                  />
                  {sections.length === 0 && (
                    <p className="px-3 py-1 text-[11px] text-[#c9c8c4]">

                      {tr("(아직 프로젝트 없음 — 상단 + 프로젝트 추가)")}
                    </p>
                  )}
                </>
              )}
              <div className="my-1 border-t border-[#eeeeec]" />
              <MenuItem
                label={`🗂️ 시스템 탐색기에서 보기 (${REVEAL_IN_EXPLORER_SHORTCUT})`}
                onClick={() => {
                  void revealInSystemExplorer(menu.node)
                  setMenu(null)
                }}
              />
              {menu.node && (
                <>
                  <div className="my-1 border-t border-[#eeeeec]" />
                  <MenuItem
                    label={tr("✏️ 이름 변경")}
                    onClick={() => {
                      setRenaming(menu.node!.path)
                      setMenu(null)
                    }}
                  />
                  <MenuItem
                    label={tr("🗑️ 삭제 (휴지통)")}
                    danger
                    onClick={() => {
                      handleDelete(menu.node!)
                      setMenu(null)
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      )}
      {pathDialog && (
        <ProjectPathDialog
          projectName={pathDialog.project.name}
          initialPath={pathDialog.project.project_path}
          creation={pathDialog.creation}
          onClose={() => setPathDialog(null)}
          onSelect={(path) => connectProjectPath(pathDialog.project, path)}
        />
      )}
    </div>
  )
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** 이 노드 아래에 새 항목을 만들 때의 디렉토리. 파일이면 동반 폴더(노션식 하위 노트) 경로. */
function childDirOf(node: TreeNode): string {
  if (node.type === 'dir') return node.path
  if (node.type === 'erd' || node.type === 'other') return parentOf(node.path)
  return node.path.replace(/\.md$/, '')
}

function TemplateModal({
  dir,
  onClose,
  onCreated,
}: {
  dir: string
  onClose: () => void
  onCreated: (path: string) => void
}) {
  const [templates, setTemplates] = useState<{ name: string; path: string }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose, dir)

  useEffect(() => {
    api.templates().then((t) => {
      setTemplates(t)
      if (t.length > 0) setSelected(t[0].path)
    })
  }, [])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || !selected) return
    try {
      const res = await api.createEntry(dir ? `${dir}/${trimmed}` : trimmed, 'file', undefined, selected)
      onCreated(res.path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const createTemplate = async () => {
    const tplName = await dialog.prompt('새 템플릿 이름', {
      placeholder: '예: 회의록, 장애 보고',
      confirmLabel: '만들기',
    })
    if (!tplName?.trim()) return
    try {
      const res = await api.createEntry(`templates/${tplName.trim()}`, 'file')
      onCreated(res.path) // 에디터에서 바로 템플릿 내용 작성
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh]" onClick={dismissFromBackdrop}>
      <div
        className="w-[440px] max-w-[90vw] overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[#efefed] px-4 py-3">
          <h3 className="text-[15px] font-semibold text-[#37352f]">{tr("📋 템플릿으로 새 노트")}</h3>
          <p className="mt-0.5 text-[12px] text-[#9b9a97]">{tr("위치:")} {dir || tr("(루트)")}</p>
        </div>
        {templates.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-[#9b9a97]">

            {tr("아직 템플릿이 없습니다.")}
            <br />

            {tr("아래 \"새 템플릿 만들기\"로 첫 템플릿을 작성해 보세요.")}
          </p>
        ) : (
          <div className="px-4 py-3">
            <div className="mb-3 max-h-40 overflow-y-auto rounded border border-[#efefed]">
              {templates.map((t) => (
                <button
                  key={t.path}
                  className={`block w-full px-3 py-1.5 text-left text-[13px] ${
                    selected === t.path ? 'bg-[#f1f1ef] font-medium text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#fbfbfa]'
                  }`}
                  onClick={() => setSelected(t.path)}
                >
                  📋 {t.name}
                </button>
              ))}
            </div>
            <input
              autoFocus
              className="w-full rounded border border-[#e3e2e0] px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400"
              placeholder={tr("새 노트 이름")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
                if (e.key === 'Escape') onClose()
              }}
            />
            {error && <p className="mt-1.5 text-[12px] text-red-500">{error}</p>}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[#efefed] px-4 py-3">
          <button
            className="rounded px-2 py-1.5 text-[13px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
            onClick={createTemplate}
            title={tr("templates/ 폴더에 새 템플릿 노트를 만들고 에디터에서 작성")}
          >

            {tr("➕ 새 템플릿 만들기")}
          </button>
          <div className="flex gap-2">
            <button className="rounded border border-[#e3e2e0] px-3 py-1.5 text-[13px] hover:bg-[#f1f1ef]" onClick={onClose}>

              {tr("취소")}
            </button>
            {templates.length > 0 && (
              <button
                className="rounded bg-[#37352f] px-3 py-1.5 text-[13px] text-white hover:bg-[#565452] disabled:opacity-50"
                disabled={!name.trim() || !selected}
                onClick={create}
              >

                {tr("만들기")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`block w-full px-3 py-1.5 text-left hover:bg-[#f1f1ef] ${danger ? 'text-red-600' : 'text-[#37352f]'}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function InlineInput({
  depth,
  defaultValue = '',
  placeholder,
  onSubmit,
  onCancel,
}: {
  depth: number
  defaultValue?: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      placeholder={placeholder}
      className="my-0.5 w-[calc(100%-16px)] rounded border border-blue-400 bg-white px-2 py-[2px] text-[13px] outline-none"
      style={{ marginLeft: 8 + depth * 14 }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => {
        // 값이 있으면 제출, 없으면 취소
        if (e.target.value.trim() && e.target.value.trim() !== defaultValue) onSubmit(e.target.value)
        else onCancel()
      }}
    />
  )
}
