import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { APP_UI_FONT_FAMILY, ensureKoreanFontLoaded } from '../fontFamilies'
import { isDarkTheme, useThemeStore } from '../theme'
import { useBackdropDismiss } from '../useBackdropDismiss'
import { tr } from '../i18n'

/** mermaid 동적 로드 + 캐싱 — 초기 번들 부담 최소화. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let initializedTheme: 'default' | 'dark' | null = null

async function getMermaid(theme: 'default' | 'dark') {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  const mermaid = await mermaidPromise
  // Mermaid SVG는 앱 CSS 색상을 상속하지 않는다. 다크 테마에서는 Mermaid 자체 팔레트도
  // 함께 전환해야 라벨·화살표·배경의 대비가 유지된다.
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: APP_UI_FONT_FAMILY,
      altFontFamily: APP_UI_FONT_FAMILY,
      themeVariables: { fontFamily: APP_UI_FONT_FAMILY },
    })
    initializedTheme = theme
  }
  return mermaid
}

export async function renderMermaidForExport(source: string, id: string): Promise<string> {
  const mermaid = await getMermaid('default')
  await ensureKoreanFontLoaded()
  return (await mermaid.render(id, source)).svg
}

/** Mermaid 소스를 SVG로 렌더링하는 공용 미리보기. 노트 블록과 채팅이 같은 보안·렌더링
 * 설정을 사용하도록 한 곳에 둔다. */
export function MermaidPreview({ source, className = '' }: { source: string; className?: string }) {
  const appTheme = useThemeStore((state) => state.theme)
  const mermaidTheme = isDarkTheme(appTheme) ? 'dark' : 'default'
  const [svg, setSvg] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`)

  useEffect(() => {
    const text = source.trim()
    setSvg('')
    setErr(null)
    if (!text) {
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const [mermaid] = await Promise.all([
          getMermaid(mermaidTheme),
          ensureKoreanFontLoaded(),
        ])
        // parse 로 문법 검증 (에러 잡기 쉬움)
        await mermaid.parse(text)
        const { svg } = await mermaid.render(idRef.current, text)
        if (!cancelled) {
          setSvg(svg)
          setErr(null)
        }
      } catch (e) {
        if (!cancelled) {
          setSvg('')
          setErr((e as Error).message || String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, mermaidTheme])

  if (svg) {
    return (
      <div
        data-mermaid-source={source}
        className={`mermaid-preview flex justify-center overflow-auto px-3 py-3 ${className}`}
        // Mermaid는 strict 보안 수준으로 초기화되며, 외부 HTML은 렌더링하지 않는다.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }
  if (err) return <pre data-mermaid-source={source} className="whitespace-pre-wrap px-3 py-2 text-[11px] text-red-600">{tr("에러:")} {err}</pre>
  return <p data-mermaid-source={source} className="px-3 py-4 text-center text-[12px] text-[#9b9a97]">{tr("다이어그램을 준비하는 중…")}</p>
}

/** 문서 블록과 채팅 카드에서 공유하는 Mermaid 확대 버튼. */
export function MermaidExpandButton({ source, className = '' }: { source: string; className?: string }) {
  const [open, setOpen] = useState(false)
  if (!source.trim()) return null
  return (
    <>
      <button
        type="button"
        className={`flex h-6 w-6 items-center justify-center rounded text-[#787774] hover:bg-[#ececea] hover:text-[#37352f] ${className}`}
        onClick={() => setOpen(true)}
        title={tr("다이어그램 확대")}
        aria-label={tr("다이어그램 확대")}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
        </svg>
      </button>
      {open && <MermaidZoomDialog source={source} onClose={() => setOpen(false)} />}
    </>
  )
}

function MermaidZoomDialog({ source, onClose }: { source: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose, source)
  const kind = source.trimStart().startsWith('sequenceDiagram') ? '시퀀스 다이어그램' : 'Mermaid 다이어그램'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        setZoom((value) => Math.min(2.5, value + 0.25))
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '-') {
        event.preventDefault()
        setZoom((value) => Math.max(0.5, value - 0.25))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={dismissFromBackdrop}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${kind} 확대 보기`}
        className="flex h-[94vh] w-[96vw] flex-col overflow-hidden rounded-xl border border-[#d3d1cb] bg-white shadow-2xl"
        contentEditable={false}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#e9e9e7] bg-[#faf9f7] px-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#37352f]">{kind}  {tr("확대 보기")}</span>
          <button
            type="button"
            className="rounded px-2 py-1 text-[14px] text-[#5f5e5b] hover:bg-[#ececea]"
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            disabled={zoom <= 0.5}
            title={tr("축소")}
          >
            −
          </button>
          <button
            type="button"
            className="min-w-14 rounded px-2 py-1 text-[11px] tabular-nums text-[#5f5e5b] hover:bg-[#ececea]"
            onClick={() => setZoom(1)}
            title={tr("크기 초기화")}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-[14px] text-[#5f5e5b] hover:bg-[#ececea]"
            onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))}
            disabled={zoom >= 2.5}
            title={tr("확대")}
          >
            +
          </button>
          <span className="mx-1 h-5 w-px bg-[#e3e2e0]" />
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-[18px] text-[#787774] hover:bg-[#ececea] hover:text-[#37352f]"
            onClick={onClose}
            aria-label={tr("확대 보기 닫기")}
            title={tr("닫기")}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-[#f7f7f5]">
          <div
            className="inline-block min-h-full min-w-full p-6"
            style={{ zoom } as CSSProperties}
          >
            <MermaidPreview source={source} className="min-w-max justify-start overflow-visible" />
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}

/** mermaid 다이어그램 블록 뷰 — 편집(소스)/미리보기(SVG) 토글. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function MermaidBlockView({ block, editor }: any) {
  const source: string = block.props.source ?? ''
  const initialMode: 'edit' | 'preview' = source.trim() ? 'preview' : 'edit'
  const [mode, setMode] = useState<'edit' | 'preview'>(initialMode)
  const [draft, setDraft] = useState(source)

  useEffect(() => {
    setDraft(source)
  }, [source])

  const commit = () => {
    if (draft !== source) editor.updateBlock(block, { props: { ...block.props, source: draft } })
    setMode('preview')
  }

  return (
    <div className="my-1 w-full rounded-md border border-[#e3e2e0] bg-white" contentEditable={false}>
      <div className="flex items-center justify-between border-b border-[#efefed] px-2 py-1 text-[11px] text-[#9b9a97]">
        <span className="font-medium">🧜‍♀️ Mermaid</span>
        <div className="flex gap-1">
          {mode === 'preview' && <MermaidExpandButton source={draft} />}
          <button
            className={`rounded px-2 py-0.5 ${mode === 'edit' ? 'bg-[#f1f1ef] text-[#37352f]' : 'hover:bg-[#f1f1ef]'}`}
            onClick={() => setMode('edit')}
          >

            {tr("소스")}
          </button>
          <button
            className={`rounded px-2 py-0.5 ${mode === 'preview' ? 'bg-[#f1f1ef] text-[#37352f]' : 'hover:bg-[#f1f1ef]'}`}
            onClick={commit}
          >

            {tr("미리보기")}
          </button>
        </div>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="block w-full resize-y bg-[#fafafa] px-3 py-2 font-mono text-[12px] leading-5 text-[#37352f] outline-none"
          rows={Math.max(4, Math.min(20, draft.split('\n').length + 1))}
          value={draft}
          placeholder={tr("graph TD\n  A[시작] --> B{조건}\n  B -->|예| C[동작]\n  B -->|아니오| D[종료]")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
      ) : (
        <MermaidPreview source={draft} />
      )}
    </div>
  )
}
