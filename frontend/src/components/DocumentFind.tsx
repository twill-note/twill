import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { tr } from '../i18n'

/** DOM ranges paint matches without changing BlockNote content or triggering saves. */
export function documentMatches(root: HTMLElement, query: string, selector = '.bn-inline-content'): Range[] {
  if (!query) return []
  const ranges: Range[] = []
  // Text blocks keep matches across bold/link spans, but never across paragraphs.
  for (const block of root.querySelectorAll<HTMLElement>(selector)) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement?.closest(selector) === block) nodes.push(walker.currentNode as Text)
    }
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

const CHAT_TEXT = ['p', 'li', 'pre', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].map(tag => `.chat-md ${tag}`).join(', ')

export default function DocumentFind({ scope, body, scroll, kind = 'document', onOpenChange }: {
  scope: RefObject<HTMLDivElement | null>
  body: RefObject<HTMLDivElement | null>
  scroll: RefObject<HTMLDivElement | null>
  kind?: 'document' | 'chat'
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const [navigation, setNavigation] = useState(0)
  const jumpRequested = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const id = `find${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const close = () => {
    setOpen(false)
    const target = kind === 'chat' ? scope.current?.querySelector('textarea') : body.current?.querySelector<HTMLElement>('[contenteditable="true"]')
    target?.focus({ preventScroll: true })
  }
  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      const root = scope.current
      if (!root || !root.getClientRects().length) return
      const target = event.target instanceof Element ? event.target : null
      const activePanel = root.closest('[data-active-document-panel="true"]')
      const otherInput = target?.closest('input, textarea, [contenteditable="true"], [data-ai-conversation]')
      if (!root.contains(event.target as Node) && (!activePanel || otherInput)) return
      event.preventDefault()
      event.stopPropagation()
      jumpRequested.current = true
      setOpen(true)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [scope])

  useEffect(() => {
    const root = body.current
    if (!open || !root) { setMatches([]); return }
    const update = () => {
      const next = documentMatches(root, query, kind === 'chat' ? CHAT_TEXT : '.bn-inline-content')
      setMatches(next)
      setIndex(value => Math.min(value, Math.max(0, next.length - 1)))
    }
    setIndex(0)
    update()
    let timer: ReturnType<typeof setTimeout>
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(update, 100) })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [open, query, body, kind])

  useEffect(() => {
    if (!open) return
    CSS.highlights.set(id, new Highlight(...matches))
    const current = matches[index]
    CSS.highlights.set(`${id}current`, new Highlight(...(current ? [current] : [])))
    if (current && scroll.current && jumpRequested.current) {
      jumpRequested.current = false
      const rect = current.getBoundingClientRect()
      const viewport = scroll.current.getBoundingClientRect()
      if (rect.top < viewport.top || rect.bottom > viewport.bottom) {
        scroll.current.scrollTop += rect.top - viewport.top - viewport.height / 2
      }
    }
    return () => { CSS.highlights.delete(id); CSS.highlights.delete(`${id}current`) }
  }, [matches, index, open, id, scroll, navigation])

  const move = (direction: number) => {
    jumpRequested.current = true
    setIndex(value => matches.length ? (value + direction + matches.length) % matches.length : 0)
    setNavigation(value => value + 1)
  }
  if (!open) return null
  const label = kind === 'chat' ? tr('대화에서 찾기') : tr('문서에서 찾기')
  return <div role="search" aria-label={label} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e3e2e0] bg-[#fbfbfa] px-3 py-2 text-[12px] text-[#37352f]"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target === input.current) { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
    }}>
    <style>{`::highlight(${id}) { background: #ffe08a; color: #242424; } ::highlight(${id}current) { background: #ee8b32; color: #171717; }`}</style>
    <input ref={input} aria-label={kind === 'chat' ? tr('대화 검색어') : tr('문서 검색어')} placeholder={label} value={query} onChange={event => { jumpRequested.current = true; setQuery(event.target.value) }} className="min-w-20 flex-1 rounded border border-[#e3e2e0] bg-white px-2 py-1 outline-none focus:ring-1" />
    <span role="status" aria-live="polite">{query ? `${matches.length ? index + 1 : 0} / ${matches.length}` : '0 / 0'}</span>
    <button type="button" aria-label={tr('이전 결과')} title="Shift+Enter" disabled={!matches.length} onClick={() => move(-1)}>↑</button>
    <button type="button" aria-label={tr('다음 결과')} title="Enter" disabled={!matches.length} onClick={() => move(1)}>↓</button>
    <button type="button" aria-label={tr('검색 닫기')} title="Esc" onClick={close}>✕</button>
  </div>
}
