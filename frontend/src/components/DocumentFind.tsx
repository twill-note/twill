import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { tr } from '../i18n'

/** DOM ranges paint matches without changing BlockNote content or triggering saves. */
export function documentMatches(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const ranges: Range[] = []
  // Text blocks keep matches across bold/link spans, but never across paragraphs.
  for (const block of root.querySelectorAll<HTMLElement>('.bn-inline-content')) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map(node => node.data).join('')
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
      const start = match.index
      const end = start + match[0].length
      let offset = 0
      const range = document.createRange()
      for (const node of nodes) {
        const next = offset + node.length
        if (start >= offset && start < next) range.setStart(node, start - offset)
        if (end > offset && end <= next) { range.setEnd(node, end - offset); break }
        offset = next
      }
      ranges.push(range)
    }
  }
  return ranges
}

export default function DocumentFind({ scope, body, scroll }: {
  scope: RefObject<HTMLDivElement | null>
  body: RefObject<HTMLDivElement | null>
  scroll: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const id = `find${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const close = () => { setOpen(false); body.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus() }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      const root = scope.current
      if (!root) return
      const target = event.target instanceof Element ? event.target : null
      const activePanel = root.closest('[data-active-document-panel="true"]')
      const otherInput = target?.closest('input, textarea, [contenteditable="true"], [data-ai-conversation]')
      if (!root.contains(event.target as Node) && (!activePanel || otherInput)) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(true)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [scope])

  useEffect(() => {
    const root = body.current
    if (!open || !root) { setMatches([]); return }
    const update = () => { setMatches(documentMatches(root, query)); setIndex(0) }
    update()
    let timer: ReturnType<typeof setTimeout>
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(update, 100) })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [open, query, body])

  useEffect(() => {
    if (!open) return
    CSS.highlights.set(id, new Highlight(...matches))
    const current = matches[index]
    CSS.highlights.set(`${id}current`, new Highlight(...(current ? [current] : [])))
    if (current && scroll.current) {
      const rect = current.getBoundingClientRect()
      const viewport = scroll.current.getBoundingClientRect()
      if (rect.top < viewport.top || rect.bottom > viewport.bottom) {
        scroll.current.scrollTop += rect.top - viewport.top - viewport.height / 2
      }
    }
    return () => { CSS.highlights.delete(id); CSS.highlights.delete(`${id}current`) }
  }, [matches, index, open, id, scroll])

  const move = (direction: number) => setIndex(value => matches.length ? (value + direction + matches.length) % matches.length : 0)
  if (!open) return <button type="button" className="self-end px-3 py-1 text-[11px] text-[#9b9a97] hover:text-[#37352f]" onClick={() => { setOpen(true); requestAnimationFrame(() => input.current?.focus()) }}>{tr('문서에서 찾기')} ⌘/Ctrl+F</button>
  return <div role="search" aria-label={tr('문서에서 찾기')} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e3e2e0] bg-[#fbfbfa] px-3 py-2 text-[12px] text-[#37352f]"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target === input.current) { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
    }}>
    <style>{`::highlight(${id}) { background: #ffe08a; color: #242424; } ::highlight(${id}current) { background: #ee8b32; color: #171717; }`}</style>
    <input ref={input} aria-label={tr('문서 검색어')} placeholder={tr('문서에서 찾기')} value={query} onChange={event => setQuery(event.target.value)} className="min-w-20 flex-1 rounded border border-[#e3e2e0] bg-white px-2 py-1 outline-none focus:ring-1" />
    <span role="status" aria-live="polite">{query ? `${matches.length ? index + 1 : 0} / ${matches.length}` : '0 / 0'}</span>
    <button type="button" aria-label={tr('이전 결과')} title="Shift+Enter" disabled={!matches.length} onClick={() => move(-1)}>↑</button>
    <button type="button" aria-label={tr('다음 결과')} title="Enter" disabled={!matches.length} onClick={() => move(1)}>↓</button>
    <button type="button" aria-label={tr('검색 닫기')} title="Esc" onClick={close}>✕</button>
  </div>
}
