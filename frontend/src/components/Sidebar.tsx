import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { NoteMeta } from '../types'
import { dialog } from '../dialog'
import { displayCombo, useShortcutStore } from '../shortcuts'
import ConversationList from './ConversationList'
import FileTree from './FileTree'
import FolderPicker from './FolderPicker'
import WorkspaceSettingsDialog from './WorkspaceSettingsDialog'

// 기존 고정 폭(w-64 = 256px)보다 좁아지지 않도록 한다.
const MIN_WIDTH = 256

export default function Sidebar() {
  const { setPaletteOpen, tags, refreshTags, refreshTree, tagFilter, setTagFilter, openFile, root, loadWorkspace } =
    useAppStore()
  const [tagNotes, setTagNotes] = useState<NoteMeta[]>([])
  const [reindexing, setReindexing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [width, setWidth] = useState(MIN_WIDTH)
  const [tagsCollapsed, setTagsCollapsed] = useState(() => localStorage.getItem('sidebar.tags-collapsed') === '1')
  const searchShortcut = useShortcutStore((state) => state.bindings.search)

  useEffect(() => {
    refreshTags()
    loadWorkspace().catch(() => {})
  }, [refreshTags, loadWorkspace])

  const rootName = root ? root.split('/').filter(Boolean).pop() : null

  useEffect(() => {
    if (tagFilter) api.notesByTag(tagFilter).then(setTagNotes)
    else setTagNotes([])
  }, [tagFilter])

  const handleReindex = async () => {
    setReindexing(true)
    try {
      const { indexed } = await api.reindex()
      await Promise.all([refreshTree(), refreshTags()])
      dialog.alert(`새로고침 완료: ${indexed}개 노트`)
    } finally {
      setReindexing(false)
    }
  }

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const onMove = (ev: PointerEvent) => {
      const max = Math.floor(window.innerWidth * 0.7)
      setWidth(Math.min(max, Math.max(MIN_WIDTH, ev.clientX)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const toggleTags = () => {
    setTagsCollapsed((collapsed) => {
      const next = !collapsed
      localStorage.setItem('sidebar.tags-collapsed', next ? '1' : '0')
      return next
    })
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-[#e9e9e7] bg-[#f7f7f5]"
      style={{ width }}
    >
      <div
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-[#4a9eff]/60"
        onPointerDown={onResizeStart}
        title="패널 너비 조절"
      />
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h1 className="truncate text-[14px] font-semibold text-[#37352f]" title={root ?? undefined}>
          📝 {rootName ?? '내 노트'}
        </h1>
        <div className="flex shrink-0 gap-0.5">
          <button
            className="rounded px-1.5 py-0.5 text-[12px] text-[#9b9a97] hover:bg-[#efefed]"
            title="폴더 열기"
            onClick={() => setPickerOpen(true)}
          >
            📂
          </button>
          {/* 이모지 아이콘으로 통일 (⟳·⚙ 텍스트 글리프는 다른 버튼과 스타일이 달라 이질감) */}
          <button
            className="rounded px-1.5 py-0.5 text-[12px] text-[#9b9a97] hover:bg-[#efefed]"
            title="새로고침"
            onClick={handleReindex}
            disabled={reindexing}
          >
            {reindexing ? '⏳' : '🔄'}
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-[12px] text-[#9b9a97] hover:bg-[#efefed]"
            title="설정"
            onClick={() => setSettingsOpen(true)}
            data-testid="workspace-settings-button"
          >
            ⚙️
          </button>
        </div>
      </div>
      {pickerOpen && <FolderPicker onClose={() => setPickerOpen(false)} />}
      {settingsOpen && <WorkspaceSettingsDialog onClose={() => setSettingsOpen(false)} />}

      <button
        className="mx-3 mt-1 flex items-center gap-2 rounded-md border border-[#e3e2e0] bg-white px-2.5 py-1.5 text-[13px] text-[#9b9a97] hover:bg-[#fbfbfa]"
        onClick={() => setPaletteOpen(true)}
      >
        🔍 검색…
        <kbd className="ml-auto rounded bg-[#f1f1ef] px-1.5 text-[11px] text-[#9b9a97]">
          {displayCombo(searchShortcut)}
        </kbd>
      </button>



      {tagFilter ? (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[12px] font-medium text-[#37352f]">#{tagFilter}</span>
            <button className="text-[12px] text-[#9b9a97] hover:text-[#37352f]" onClick={() => setTagFilter(null)}>
              ✕ 닫기
            </button>
          </div>
          {tagNotes.map((n) => (
            <button
              key={n.path}
              className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-[#5f5e5b] hover:bg-[#efefed]"
              onClick={() => openFile(n.path)}
              title={n.path}
            >
              📄 {n.title}
              {n.date && <span className="ml-1 text-[11px] text-[#9b9a97]">{n.date}</span>}
            </button>
          ))}
          {tagNotes.length === 0 && <p className="px-2 text-[12px] text-[#9b9a97]">노트 없음</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <FileTree />
        </div>
      )}

      <ConversationList />

      {tags.length > 0 && (
        <div className="border-t border-[#e9e9e7] px-3 py-2">
          <button
            className="flex w-full items-center gap-1 text-left text-[11px] font-medium tracking-wide text-[#9b9a97] hover:text-[#5f5e5b]"
            onClick={toggleTags}
            aria-expanded={!tagsCollapsed}
            title="태그"
          >
            <span aria-hidden="true">{tagsCollapsed ? '▸' : '▾'}</span>
            태그
          </button>
          {!tagsCollapsed && (
            <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
              {tags.map(({ tag, count }) => (
                <button
                  key={tag}
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    tagFilter === tag
                      ? 'bg-[#37352f] text-white'
                      : 'bg-[#ececea] text-[#5f5e5b] hover:bg-[#e0e0de]'
                  }`}
                  onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                >
                  #{tag} {count}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
