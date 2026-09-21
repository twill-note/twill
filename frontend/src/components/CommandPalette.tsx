import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import { usePluginRegistry } from '../plugins/registry'
import type { SearchResult } from '../types'
import { useBackdropDismiss } from '../useBackdropDismiss'

type CommandPaletteItem = { kind: 'command'; id: string; title: string; onInvoke: () => void }
type NotePaletteItem = { kind: 'note'; result: SearchResult }
type PaletteItem = CommandPaletteItem | NotePaletteItem

export default function CommandPalette() {
  const { paletteOpen, setPaletteOpen, openFile } = useAppStore()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [active, setActive] = useState(0)
  const pluginCommands = usePluginRegistry((s) => s.commands)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(() => setPaletteOpen(false), paletteOpen)

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setResults([])
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [paletteOpen])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!query.trim()) {
      setResults([])
      return
    }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await api.search(query)
        setResults(r)
        setActive(0)
      } catch {
        setResults([])
      }
    }, 200)
  }, [query])

  if (!paletteOpen) return null

  const queryText = query.trim().toLowerCase()
  const commandItems: CommandPaletteItem[] = pluginCommands
    .filter((command) => !queryText || command.title.toLowerCase().includes(queryText))
    .map((command) => ({
      kind: 'command' as const,
      id: `${command.pluginId}:${command.id}`,
      title: command.title,
      onInvoke: command.onInvoke,
    }))
  const items: PaletteItem[] = [...commandItems, ...results.map((result) => ({ kind: 'note' as const, result }))]

  const select = (item: PaletteItem) => {
    if (item.kind === 'command') item.onInvoke()
    else openFile(item.result.path)
    setPaletteOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[15vh]"
      onClick={dismissFromBackdrop}
    >
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full border-b border-[#efefed] px-4 py-3 text-[15px] outline-none placeholder:text-[#c8c7c4]"
          placeholder="노트 검색… (제목·본문)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPaletteOpen(false)
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, Math.max(0, items.length - 1)))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            }
            if (e.key === 'Enter' && items[active]) select(items[active])
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto">
          {commandItems.length > 0 && (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">플러그인 명령</p>
              {commandItems.map((item, i) => (
                <button
                  key={item.id}
                  className={`block w-full px-4 py-2.5 text-left ${i === active ? 'bg-[#f1f1ef]' : 'hover:bg-[#fbfbfa]'}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(item)}
                >
                  <span className="text-[14px] font-medium text-[#37352f]">⌘ {item.title}</span>
                </button>
              ))}
            </>
          )}
          {results.map((r, i) => {
            const index = commandItems.length + i
            return (
            <button
              key={r.path}
              className={`block w-full px-4 py-2.5 text-left ${index === active ? 'bg-[#f1f1ef]' : 'hover:bg-[#fbfbfa]'}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => select({ kind: 'note', result: r })}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[14px] font-medium text-[#37352f]">📄 {r.title}</span>
                {r.date && <span className="shrink-0 text-[11px] text-[#9b9a97]">{r.date}</span>}
              </div>
              <div className="truncate text-[12px] text-[#787774]">
                <Highlight text={r.snippet} query={query} />
              </div>
              <div className="truncate text-[11px] text-[#c8c7c4]">{r.path}</div>
            </button>
          )})}
          {query.trim() && items.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-[#9b9a97]">검색 결과가 없습니다</p>
          )}
          {!query.trim() && commandItems.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-[#9b9a97]">
              키워드를 입력하면 전체 노트에서 검색합니다
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-yellow-200 px-0.5">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}
