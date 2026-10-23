import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { type DocTab, useAppStore } from '../store'
import { actionForEvent, displayCombo, useShortcutStore } from '../shortcuts'
import { tr } from '../i18n'
import { useBackdropDismiss } from '../useBackdropDismiss'

const normalize = (value: string) => value.normalize('NFC').toLocaleLowerCase().trim()

export default function OpenDocuments() {
  const { tabs, currentPath, erdTabId, dbDir, view } = useAppStore(useShallow(state => ({
    tabs: state.openTabs, currentPath: state.currentPath, erdTabId: state.erdTabId, dbDir: state.dbDir, view: state.view,
  })))
  const binding = useShortcutStore(state => state.bindings.openDocuments)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [order, setOrder] = useState<string[]>([])
  const recent = useRef<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const activeId = view === 'erd' ? erdTabId : view === 'editor' && currentPath ? `file:${currentPath}` : view === 'database' ? `db:${dbDir}` : null
  useEffect(() => {
    if (activeId) recent.current = [activeId, ...recent.current.filter(id => id !== activeId)]
    const valid = new Set(tabs.map(tab => tab.id))
    recent.current = recent.current.filter(id => valid.has(id))
  }, [activeId, tabs])

  const close = () => { setOpen(false); previousFocus.current?.focus({ preventScroll: true }) }
  const backdrop = useBackdropDismiss<HTMLDivElement>(close, open)
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || actionForEvent(event) !== 'openDocuments') return
      event.preventDefault(); event.stopPropagation()
      if (open) { input.current?.focus(); input.current?.select(); return }
      const ids = [...new Set([...recent.current, ...tabs.map(tab => tab.id)])]
        .filter(id => tabs.some(tab => tab.id === id && ['file', 'erd', 'db'].includes(tab.kind)))
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOrder(ids); setQuery(''); setSelected(ids[0] === activeId && ids.length > 1 ? 1 : 0); setOpen(true)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [activeId, open, tabs])
  useEffect(() => { if (open) input.current?.focus() }, [open])
  const results = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean)
    return order.flatMap(id => {
      const tab = tabs.find(tab => tab.id === id)
      return tab && terms.every(term => normalize(`${tab.title} ${tab.target}`).includes(term)) ? [tab] : []
    })
  }, [order, query, tabs])
  const index = Math.min(selected, Math.max(0, results.length - 1))
  useEffect(() => { if (open) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, open, results])
  const select = (tab: DocTab) => {
    setOpen(false)
    const state = useAppStore.getState()
    if (tab.kind === 'erd') state.activateErdTab(tab.id)
    else if (tab.kind === 'db') state.openDatabase(tab.target)
    else state.openFile(tab.target)
  }
  if (!open) return null
  return <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/20 pt-[15vh]" onClick={backdrop}>
    <div role="dialog" aria-modal="true" aria-label={tr('열린 문서')} className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between px-4 pt-3 text-[12px] text-[#787774]"><span>{tr('열린 문서')}</span><span>{displayCombo(binding)}</span></div>
      <input ref={input} role="combobox" aria-expanded="true" aria-controls="open-documents-list" aria-activedescendant={results.length ? `open-document-${index}` : undefined}
        aria-label={tr('열린 문서 검색')} placeholder={tr('문서 제목 검색…')} value={query}
        className="w-full border-b border-[#efefed] px-4 py-3 text-[15px] outline-none"
        onChange={event => { setQuery(event.target.value); setSelected(0) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          if (event.key === 'Tab') event.preventDefault()
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            setSelected(results.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0)
          }
          if (event.key === 'Enter') { event.preventDefault(); if (results[index]) select(results[index]) }
        }} />
      <div ref={list} id="open-documents-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
        {results.map((tab, i) => <button key={tab.id} id={`open-document-${i}`} role="option" aria-selected={i === index} tabIndex={-1}
          className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === index ? 'bg-[#e8e7e4]' : 'hover:bg-[#f7f7f5]'}`}
          onMouseEnter={() => setSelected(i)} onClick={() => select(tab)}>
          <span>{tab.icon}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-[#37352f]">{tab.title}</span><span className="block truncate text-[11px] text-[#9b9a97]">{tab.target}</span></span>
        </button>)}
        {!results.length && <p role="status" className="px-4 py-6 text-center text-[13px] text-[#9b9a97]">{tr(order.length ? '검색 결과가 없습니다' : '열린 문서가 없습니다')}</p>}
      </div>
    </div>
  </div>
}
