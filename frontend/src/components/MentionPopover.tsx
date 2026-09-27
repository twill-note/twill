import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { SearchResult } from '../types'
import { tr } from '../i18n'

/**
 * @-mention 자동완성 팝오버.
 * 텍스트 입력 컴포넌트가 다음 상태를 알리면 이 컴포넌트가 팝오버 표시:
 *   · 활성 여부 (커서 앞에 `@` 이 있는지)
 *   · 현재 쿼리 (`@` 이후 텍스트)
 *   · 앵커 요소 (팝오버 위치 기준)
 *
 * 부모는 onSelect(path) 콜백으로 자동완성에서 고른 경로를 받아 텍스트에 삽입하고,
 * 해당 노트 본문을 이번 질문의 컨텍스트로 명시적으로 등록한다.
 */

export type MentionState = {
  active: boolean
  query: string
  /** textarea 요소 (팝오버 배치 기준) */
  anchor: HTMLTextAreaElement | HTMLInputElement | null
}

interface Props {
  state: MentionState
  onSelect: (path: string) => void
  onDismiss: () => void
}

export default function MentionPopover({ state, onSelect, onDismiss }: Props) {
  const [results, setResults] = useState<SearchResult[]>([])
  const [tree, setTree] = useState<string[] | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const popRef = useRef<HTMLDivElement>(null)

  // 트리에서 모든 노트 경로를 한 번 수집 (빈 쿼리 fallback 용)
  useEffect(() => {
    let cancelled = false
    api.tree().then((r) => {
      if (cancelled) return
      const acc: string[] = []
      const walk = (nodes: typeof r.children): void => {
        for (const n of nodes) {
          if (n.type === 'file' && !n.db) acc.push(n.path)
          if (n.children) walk(n.children)
        }
      }
      walk(r.children)
      setTree(acc)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 쿼리 변경 시 결과 갱신
  useEffect(() => {
    if (!state.active) return
    const q = state.query.trim()
    if (!q) {
      // 쿼리 없으면 트리에서 최근 20개
      setResults((tree ?? []).slice(0, 20).map((path) => ({
        path,
        title: pathTitle(path),
        snippet: '',
      } as SearchResult)))
      return
    }
    let cancelled = false
    api.search(q).then((r) => {
      if (cancelled) return
      setResults(r.slice(0, 20))
    }).catch(() => {
      // 검색 실패 시 트리에서 로컬 필터
      const lower = q.toLowerCase()
      const filtered = (tree ?? [])
        .filter((p) => p.toLowerCase().includes(lower))
        .slice(0, 20)
        .map((path) => ({ path, title: pathTitle(path), snippet: '' } as SearchResult))
      setResults(filtered)
    })
    return () => {
      cancelled = true
    }
  }, [state.active, state.query, tree])

  useEffect(() => {
    setHighlighted(0)
  }, [state.query])

  // 팝오버 위치: 앵커 textarea 아래
  useLayoutEffect(() => {
    if (!state.active || !state.anchor) return
    const rect = state.anchor.getBoundingClientRect()
    const desiredW = 340
    const viewportW = window.innerWidth
    let left = rect.left
    if (left + desiredW > viewportW - 8) left = Math.max(8, viewportW - desiredW - 8)
    // 위쪽에 배치 (챗 입력창은 화면 하단에 있음)
    const top = rect.top - 8
    setPos({ top, left })
  }, [state.active, state.anchor, results.length])

  // 키보드 네비게이션 — 부모의 keydown 이벤트를 listen. 대신 여기서 window 리스너 사용해서
  // textarea 의 Enter/Escape 등을 가로챔.
  useEffect(() => {
    if (!state.active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted((h) => Math.min(h + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = results[highlighted]
        if (pick) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(pick.path)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss()
      }
    }
    // capture 단계에서 처리해서 textarea 기본 Enter 동작 차단
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [state.active, results, highlighted, onSelect, onDismiss])

  if (!state.active || results.length === 0) return null

  return (
    <div
      ref={popRef}
      className="fixed z-50 w-[340px] max-h-[300px] overflow-y-auto rounded-md border border-[#e3e2e0] bg-white shadow-lg"
      style={{
        top: pos.top,
        left: pos.left,
        transform: 'translateY(-100%)',
      }}
    >
      <div className="border-b border-[#efefed] px-2 py-1 text-[10px] text-[#9b9a97]">
        @{state.query || tr("검색어")} — 선택하면 노트 본문 첨부 · ↑↓ 이동 · Enter 선택 · Esc 취소
      </div>
      {results.map((r, i) => (
        <button
          key={r.path}
          className={`flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left ${
            i === highlighted ? 'bg-[#f1f1ef]' : 'hover:bg-[#f7f7f5]'
          }`}
          onMouseEnter={() => setHighlighted(i)}
          onClick={() => onSelect(r.path)}
        >
          <div className="flex w-full items-center gap-1">
            <span className="text-[11px]">📄</span>
            <span className="truncate text-[12px] font-medium text-[#37352f]">{r.title || pathTitle(r.path)}</span>
          </div>
          <span className="truncate text-[10px] text-[#9b9a97]">{r.path}</span>
        </button>
      ))}
    </div>
  )
}

function pathTitle(p: string): string {
  return p.split('/').pop()?.replace(/\.md$/, '') ?? p
}
