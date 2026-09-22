import { notifyAiEngineChanged, offerAppRestart, subscribeAiEngineChanged } from '../aiMaintenance'
import {
  isValidElement,
  memo,
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  api,
  type AiEngineStatus,
  type AiModel,
  type AiUsageLimits,
  type AiUsageLimitWindow,
  type WorkspaceDocumentLinkTarget,
  type WorkspaceScopeEntry,
} from '../api'
import { aiBus } from '../aiBus'
import { useAiStore, type AiSession, type AiMessage, type ChatImage } from '../aiStore'
import { isMemorySavedForRun } from '../aiMemory'
import { useAppStore } from '../store'
import { dialog } from '../dialog'
import ImageAnnotator from './ImageAnnotator'
import MentionPopover, { type MentionState } from './MentionPopover'
import { MermaidExpandButton, MermaidPreview } from './MermaidBlock'
import { subscribeWorkspaceScopesChanged } from '../workspaceScopeEvents'

// 배열을 렌더 때마다 새로 만들면 ReactMarkdown도 매번 새 플러그인 설정으로 판단한다.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm]

/**
 * 벼리 패널 — 구 '실행' 탭(RunPanel)과 '벼리' 챗(codex 플러그인 RightPanel)을 통합한 시스템 탭.
 *
 * · 세션 하나 = 상단 탭 하나 (챗 세션 · 태스크 실행 세션 공용)
 * · 스트림 우선순위: 답변(주 콘텐츠) > 다음 대화가 오기 전까지만 보이는 도구 블록
 *   > 진행 중에만 보이는 사고 과정 > 대화 영역 하단의 Working 상태
 * · 실행 중에도 다음 질문 초안을 계속 작성할 수 있고, steer 는 명시적 액션으로만 보낸다.
 */

/** 사고 과정 표시 — 라벨 없이 사고 문구만 잠깐 흘려보여준다.
 *  토글로 남지 않음: 뒤에 답변(또는 다음 사고)이 생기는 순간 부모가 렌더 자체를 제거한다.
 *  (전체 기록이 필요하면 태스크 실행의 run log 노트에서 확인.) */
function ReasoningView({ content, streaming }: { content: string; streaming?: boolean }) {
  if (!content && !streaming) return null
  return (
    <div className="overflow-hidden rounded-md border-l-2 border-[#c8b6ff] bg-[#faf7ff] px-3 py-2 transition-all duration-500">
      {content ? (
        <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-[11px] italic leading-relaxed text-[#6f5aa8]">
          {content.length > 600 ? '…' + content.slice(-600) : content}
          {streaming && <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-[#6f5aa8] align-middle" />}
        </p>
      ) : (
        <div className="flex items-center gap-1 py-0.5">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#c8b6ff]" />
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#c8b6ff]" style={{ animationDelay: '0.2s' }} />
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#c8b6ff]" style={{ animationDelay: '0.4s' }} />
        </div>
      )}
    </div>
  )
}

function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode }
    return nodeText(props.children)
  }
  return ''
}

/** AI 응답의 코드·다이어그램 원문을 아이콘 한 번으로 복사한다. */
function ChatCopyButton({ value, className = '' }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      void dialog.alert('클립보드 복사에 실패했습니다.')
    }
  }

  return (
    <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-current shadow-none transition-opacity hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#7a5eb0] ${copied ? 'opacity-100' : 'opacity-50 hover:opacity-100'} ${className}`}
      onClick={() => void copy()}
      aria-label={copied ? '코드 복사됨' : '코드 복사'}
      title={copied ? '복사됨' : '코드 복사'}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}

function ChatCodeBlock({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLPreElement>) {
  const source = nodeText(children).replace(/\n$/, '')
  return (
    <div className="group relative my-2 min-w-0">
      <pre {...props} className={`!my-0 pr-10 ${className}`}>{children}</pre>
      {source && (
        <ChatCopyButton
          value={source}
          className="absolute right-1.5 top-1.5 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  )
}

/** 채팅 코드 펜스의 언어 이름을 Mermaid 소스로 정규화한다.
 * ` ```sequenceDiagram `처럼 다이어그램 종류를 언어에 직접 적은 응답도 지원한다. */
function mermaidSourceFromCodeBlock(children: React.ReactNode): string | null {
  const codeNode = Array.isArray(children) ? children.find(isValidElement) : children
  if (!isValidElement(codeNode)) return null
  const props = codeNode.props as { className?: unknown; children?: React.ReactNode }
  const className = typeof props.className === 'string' ? props.className : ''
  const language = className.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  const body = nodeText(props.children).replace(/\n$/, '')
  if (!body.trim()) return null
  if (language === 'mermaid') return body
  if (language === 'sequence' || language === 'sequencediagram') return `sequenceDiagram\n${body}`
  return null
}

function ChatMermaidDiagram({ source }: { source: string }) {
  const kind = source.trimStart().startsWith('sequenceDiagram') ? '시퀀스 다이어그램' : 'Mermaid 다이어그램'
  return (
    <div className="chat-mermaid my-2 rounded-lg border shadow-sm">
      <div className="chat-mermaid-header flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px]">
        <span className="font-medium">{kind}</span>
        <div className="flex shrink-0 items-center gap-1">
          <ChatCopyButton value={source} />
          <MermaidExpandButton
            source={source}
            className="chat-mermaid-source-toggle hover:bg-black/10 hover:text-current"
          />
          <details className="shrink-0">
            <summary className="chat-mermaid-source-toggle cursor-pointer select-none">코드</summary>
            <pre className="chat-mermaid-source absolute right-0 z-10 mt-1 max-h-56 max-w-[min(30rem,calc(100vw-3rem))] overflow-auto rounded-md border p-2 text-left text-[10px] shadow-lg">
              <code>{source}</code>
            </pre>
          </details>
        </div>
      </div>
      <MermaidPreview source={source} />
    </div>
  )
}

/** 웹 URL은 기존처럼 새 탭으로 열고, 그 밖의 경로는 서버의 문서 검증 결과에만 따른다. */
function isExternalWebHref(href: string | undefined): boolean {
  return Boolean(href && /^(?:https?:)?\/\//i.test(href.trim()))
}

function ChatDocumentLink({
  href,
  children,
  onClick,
  root,
  workspaceTree,
  openFile,
  openErdDesigner,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  root: string | null
  /** 파일 생성·삭제와 루트 전환 뒤에 검증을 다시 요청하는 갱신 신호. */
  workspaceTree: readonly unknown[]
  openFile: (path: string) => void
  openErdDesigner: (path?: string | null, directory?: string | null) => void
}) {
  const [target, setTarget] = useState<WorkspaceDocumentLinkTarget | null>(null)
  const externalWebHref = isExternalWebHref(href)

  useEffect(() => {
    setTarget(null)
    if (!root || !href?.trim() || externalWebHref) return
    let cancelled = false
    api.documentLinkTarget(href)
      .then(({ target: next }) => {
        if (!cancelled) setTarget(next)
      })
      .catch(() => {
        // 연결 오류일 때도 경로를 외부/내부 링크로 추측하지 않고 평문으로 둔다.
        if (!cancelled) setTarget(null)
      })
    return () => {
      cancelled = true
    }
  }, [externalWebHref, href, root, workspaceTree])

  if (externalWebHref) {
    return (
      <a {...props} href={href} onClick={onClick} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  }

  // file://·외부 경로·../ 우회·없는 문서는 anchor를 전혀 만들지 않는다. 따라서
  // 브라우저가 로컬 파일을 열거나 hash 이동을 시도할 수 없고, 원문은 그대로 읽힌다.
  if (!target) return <span {...props}>{children}</span>

  return (
    <a
      {...props}
      href={`#${encodeURIComponent(target.kind === 'erd' ? `view:erd:${target.path}` : target.path)}`}
      title={`${target.kind === 'erd' ? 'ERD 열기' : '문서 열기'}: ${target.path}`}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        // 렌더 시 확인한 결과가 파일 삭제/루트 전환 사이에 낡을 수 있으므로, 클릭 직전에
        // 같은 서버 규칙으로 한 번 더 검증한다.
        void api.documentLinkTarget(href ?? '').then(({ target: latest }) => {
          if (!latest) {
            setTarget(null)
            return
          }
          if (latest.kind === 'erd') openErdDesigner(latest.path)
          else openFile(latest.path)
        }).catch(() => setTarget(null))
      }}
    >
      {children}
    </a>
  )
}

function ChatImageButton({
  image,
  variant,
  onPreview,
}: {
  image: ChatImage
  variant: 'user' | 'assistant'
  onPreview: (image: ChatImage) => void
}) {
  const [failed, setFailed] = useState(false)
  const label = image.alt || image.name || (variant === 'assistant' ? 'AI가 생성한 이미지' : '첨부 이미지')
  const generated = variant === 'assistant'

  if (failed) {
    return (
      <span
        className={
          generated
            ? 'flex min-h-28 w-full max-w-[34rem] items-center justify-center rounded-xl border border-[#e3e2e0] bg-[#f7f7f5] px-4 text-[11px] text-[#9b9a97]'
            : 'flex h-14 w-14 items-center justify-center rounded-lg border border-[#e3e2e0] bg-[#f7f7f5] text-[10px] text-[#9b9a97]'
        }
        title={label}
      >
        이미지 오류
      </span>
    )
  }

  return (
    <button
      type="button"
      className={
        generated
          ? 'group relative block w-full max-w-[34rem] overflow-hidden rounded-xl border border-[#deddda] bg-[#f7f7f5] shadow-sm transition hover:border-[#b9b7b2] hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a9eff]'
          : 'group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-white/30 bg-[#f1f1ef] shadow-sm transition hover:ring-2 hover:ring-[#b9cfff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a9eff]'
      }
      onClick={() => onPreview(image)}
      aria-label={`${label} 확대해서 보기`}
      title="클릭하여 크게 보기"
    >
      <img
        src={image.url}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={
          generated
            ? 'block max-h-[440px] w-full object-contain'
            : 'h-full w-full object-cover transition-transform duration-200 group-hover:scale-105'
        }
      />
      {generated && (
        <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          크게 보기
        </span>
      )}
    </button>
  )
}

function ChatImageGallery({
  images,
  variant,
  onPreview,
}: {
  images: ChatImage[] | undefined
  variant: 'user' | 'assistant'
  onPreview: (image: ChatImage) => void
}) {
  if (!images?.length) return null
  return (
    <div
      className={
        variant === 'user'
          ? 'mb-1.5 flex max-w-full flex-wrap justify-end gap-1.5'
          : 'mb-2 flex max-w-full flex-wrap items-start gap-2'
      }
    >
      {images.map((image, index) => (
        <ChatImageButton
          key={`${image.url}-${index}`}
          image={image}
          variant={variant}
          onPreview={onPreview}
        />
      ))}
    </div>
  )
}

function ChatImageLightbox({ image, onClose }: { image: ChatImage; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        event.preventDefault()
        closeRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  const label = image.alt || image.name || '이미지 미리보기'
  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="flex max-h-full max-w-full flex-col overflow-hidden rounded-xl border border-white/15 bg-[#171717] shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-3 py-2 text-white">
          <span className="min-w-0 flex-1 truncate text-[12px] text-white/80">{image.name || label}</span>
          <button
            ref={closeRef}
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-[14px] text-white hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            onClick={onClose}
            aria-label="이미지 미리보기 닫기"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 items-center justify-center bg-black p-2">
          <img src={image.url} alt={label} className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-3rem)] object-contain" />
        </div>
      </div>
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({
  m,
  root,
  workspaceTree,
  openFile,
  openErdDesigner,
  onPreviewImage,
  displayContent,
}: {
  m: AiMessage
  root: string | null
  workspaceTree: readonly unknown[]
  openFile: (path: string) => void
  openErdDesigner: (path?: string | null, directory?: string | null) => void
  onPreviewImage: (image: ChatImage) => void
  /** 순서 계획 세션에서만 결론 JSON을 제거한 표시용 원문. */
  displayContent?: string
}) {
  // 스트리밍 Markdown 파싱은 낮은 우선순위로 미뤄 입력 이벤트가 먼저 화면에 반영되게 한다.
  const content = displayContent ?? m.content
  const deferredContent = useDeferredValue(content)
  const markdownComponents = useMemo(
    () => ({
      a: ({ node: _node, ...props }: { node?: unknown } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <ChatDocumentLink
          {...props}
          root={root}
          workspaceTree={workspaceTree}
          openFile={openFile}
          openErdDesigner={openErdDesigner}
        />
      ),
      pre: ({ children, ...props }: { children?: React.ReactNode }) => {
        // 스트리밍 중에는 닫히지 않은 코드 펜스가 자주 생기므로 원문을 유지한다.
        // 완료 뒤에만 다이어그램으로 교체해 문법 오류 깜빡임을 없앤다.
        const source = m.streaming ? null : mermaidSourceFromCodeBlock(children)
        return source ? <ChatMermaidDiagram source={source} /> : <ChatCodeBlock {...props}>{children}</ChatCodeBlock>
      },
      img: ({ node: _node, src, alt }: { node?: unknown } & ImgHTMLAttributes<HTMLImageElement>) =>
        typeof src === 'string' && src ? (
          <ChatImageButton
            image={{ url: src, alt: alt || '답변 이미지' }}
            variant="assistant"
            onPreview={onPreviewImage}
          />
        ) : null,
    }),
    [m.streaming, onPreviewImage, openErdDesigner, openFile, root, workspaceTree],
  )
  // 벼리 응답은 Markdown 으로 렌더링 (GFM: 표·체크박스·취소선 지원). 스트리밍 중에도 즉시 파싱.
  // react-markdown 은 raw HTML 을 렌더하지 않으므로 XSS 안전, 링크는 새 탭 + noopener.
  if (m.role === 'assistant') {
    return (
      <div className="min-w-0">
        <ChatImageGallery images={m.images} variant="assistant" onPreview={onPreviewImage} />
        {(content || m.streaming) && (
          <div className="chat-md inline-block max-w-[92%] break-words rounded-lg bg-[#f7f7f5] px-3 py-2 text-left text-[13px] text-[#37352f]">
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              components={markdownComponents}
            >
              {m.streaming ? deferredContent : content}
            </ReactMarkdown>
            {m.streaming && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-[#37352f] align-middle" />}
          </div>
        )}
      </div>
    )
  }
  // 사용자 메시지는 입력한 원문 그대로 (pre-wrap)
  const deliveryStyle =
    m.delivery === 'pending'
      ? 'bg-[#1f1e1a]'
      : m.delivery === 'failed'
        ? 'bg-[#9c2f2f]'
        : 'bg-[#37352f]'
  const deliveryLabel =
    m.delivery === 'pending'
      ? '추가 지시 전달 중'
      : m.delivery === 'failed'
        ? '추가 지시 전달 실패'
        : undefined
  return (
    <div className="min-w-0 text-right">
      <ChatImageGallery images={m.images} variant="user" onPreview={onPreviewImage} />
      {(m.content || m.streaming) && (
        <div
          // break-words 필수: 긴 URL·코드 경로 같은 공백 없는 토큰이 말풍선 밖으로 넘치지 않게
          className={`inline-block max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-left text-[13px] text-white ${deliveryStyle}`}
          title={deliveryLabel}
        >
          {m.content}
          {m.streaming && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-[#37352f] align-middle" />}
          {deliveryLabel && <span className="sr-only">{deliveryLabel}</span>}
        </div>
      )}
    </div>
  )
})

const ToolActivityBlock = memo(function ToolActivityBlock({ message }: { message: AiMessage }) {
  const [open, setOpen] = useState(false)
  const state = message.toolState ?? 'done'
  const running = state === 'running'
  const output = message.toolOutput?.trim() ?? ''
  const canOpen = Boolean(output)
  const tone =
    state === 'error'
      ? 'border-[#fbcaca] bg-[#fdf2f2] text-[#c92a2a]'
      : state === 'cancelled'
        ? 'border-[#f4dfab] bg-[#fff9eb] text-[#795f28]'
        : running
          ? 'border-[#d5e6ff] bg-[#f5f8ff] text-[#375a9e]'
          : 'border-[#e3e2e0] bg-[#fbfbfa] text-[#5f5e5b]'
  const stateLabel =
    state === 'error' ? '실패' : state === 'cancelled' ? '중단' : running ? '진행 중' : '완료'

  return (
    <div className={`overflow-hidden rounded-md border ${tone}`}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => canOpen && !running && setOpen((value) => !value)}
        disabled={!canOpen || running}
        aria-expanded={running || open}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          {running ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4a7ccc]" />
          ) : state === 'done' ? (
            <span className="text-[#0f7a48]">✓</span>
          ) : state === 'cancelled' ? (
            <span>■</span>
          ) : (
            <span>!</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#37352f]">{message.content}</span>
        <span className="shrink-0 text-[10px] opacity-70">{stateLabel}</span>
        {canOpen && !running && <span className="shrink-0 text-[10px] opacity-60">{open ? '▴' : '▾'}</span>}
      </button>
      {(running || open) && output && (
        <pre className="max-h-32 overflow-y-auto border-t border-black/5 px-3 py-2 font-mono text-[10px] leading-relaxed text-[#4a5568] whitespace-pre-wrap break-words">
          {running && output.length > 1600 ? output.slice(-1600) : output}
        </pre>
      )}
    </div>
  )
})

/** 계획 세션의 답변에서 결론 JSON 을 표시에서 제거 — 결론은 별도의 제안 확정 카드로 표시된다.
 *  스트리밍 중에는 꼬리에 생성되기 시작한 JSON 부터 즉시 숨긴다. */
function stripOrderConclusion(text: string, streaming?: boolean): string {
  const matches = [...text.matchAll(/\{\s*"order"/g)]
  if (matches.length === 0) return text
  let out = text.slice(0, matches[matches.length - 1].index)
  out = out.replace(/```(?:json)?\s*$/i, '').trimEnd() // 코드펜스 머리 잔여 제거
  if (!out && !streaming) return '(결론은 아래 제안 카드로 표시됩니다)'
  return out
}

/** 입력창의 state 변화와 대화 이력 렌더링을 분리한다.
 * messages 배열이 바뀔 때만 과거 말풍선·Markdown 트리를 다시 순회한다. */
const ChatMessageList = memo(function ChatMessageList({
  messages,
  isPlanSession,
  root,
  workspaceTree,
  openFile,
  openErdDesigner,
  onPreviewImage,
}: {
  messages: AiMessage[]
  isPlanSession: boolean
  root: string | null
  workspaceTree: readonly unknown[]
  openFile: (path: string) => void
  openErdDesigner: (path?: string | null, directory?: string | null) => void
  onPreviewImage: (image: ChatImage) => void
}) {
  // 화면에 남길 사고 과정은 "가장 최근이면서 아직 뒤에 답변이 없는" 하나뿐.
  let visibleReasoningIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant') break
    if (message.role === 'reasoning') {
      visibleReasoningIdx = i
      break
    }
  }

  // 도구 블록은 실행 기록이 아니라 현재 진행 상황이다. 뒤에 새 사용자/벼리 메시지가
  // 생기는 즉시 이전 도구 블록을 숨기고, 그 뒤 시작된 도구만 다시 표시한다.
  let latestChatMessageIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'assistant') {
      latestChatMessageIdx = i
      break
    }
  }

  return (
    <>
      {messages.map((message, index) => {
        if (message.role === 'reasoning') {
          if (index !== visibleReasoningIdx) return null
          return <ReasoningView key={index} content={message.content} streaming={message.streaming} />
        }
        if (message.role === 'tool') {
          if (index < latestChatMessageIdx) return null
          return <ToolActivityBlock key={message.itemId ?? index} message={message} />
        }
        const displayContent =
          isPlanSession && message.role === 'assistant'
            ? stripOrderConclusion(message.content, message.streaming)
            : undefined
        return (
          <MessageBubble
            key={message.itemId ?? index}
            m={message}
            displayContent={displayContent}
            root={root}
            workspaceTree={workspaceTree}
            openFile={openFile}
            openErdDesigner={openErdDesigner}
            onPreviewImage={onPreviewImage}
          />
        )
      })}
    </>
  )
})

/**
 * 카드에서 시작한 세션의 UI 전용 출처 배너.
 *
 * 이 요소는 messages 배열에 넣지 않는다. 따라서 클릭·새로고침·재접속과 무관하게 세션
 * 메타데이터로만 복원되고, 사용자 또는 AI에게 보낼 프롬프트에는 절대 섞이지 않는다.
 */
function TaskSourceBanner({ session, openFile }: { session: AiSession; openFile: (path: string) => void }) {
  const source = session.sourceTask
  if (!source) return null

  const status = session.sourceTaskStatus
  const deleted = status?.state === 'deleted'
  // 생성 직후의 POST 응답에는 아직 list_sessions용 runtime 상태가 없을 수 있다.
  const title = status?.title || source.last_title || source.title
  const path = deleted ? null : status?.path || source.last_path || source.path
  const projectWarning = status?.scope_mismatch ? (
    <div className="rounded-lg border border-[#f4dfab] bg-[#fff9eb] px-3 py-2 text-[11px] leading-snug text-[#8a6817]" role="alert">
      <div className="font-medium">카드와 세션의 프로젝트가 다릅니다</div>
      <div className="mt-0.5">
        {status.scope_error ||
          '이 세션의 프로젝트 권한은 시작 시점 값으로 유지됩니다. 태스크 카드에서 ‘변경된 프로젝트로 새 실행’을 시작해주세요.'}
      </div>
    </div>
  ) : null

  if (!path) {
    return (
      <div className="space-y-1.5">
        {projectWarning}
        <div className="rounded-lg border border-[#e7e0cf] bg-[#fffcf5] px-3 py-2 text-[12px] text-[#795f28]" role="note">
          <span className="font-medium">요청 대상: {title}</span>
          <span className="ml-1.5 text-[11px] text-[#9a8050]">삭제된 카드</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {projectWarning}
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-[#c9dcff] bg-[#f4f8ff] px-3 py-2 text-left text-[12px] text-[#375a9e] hover:bg-[#eaf2ff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4a9eff]"
        onClick={() => openFile(path)}
        title={`${path} 카드 열기`}
      >
        <span aria-hidden="true">↗</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">요청 대상: {title}</span>
        </span>
        <span className="shrink-0 text-[10px] text-[#5c7db8]">카드 열기</span>
      </button>
    </div>
  )
}

function pathLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.split('/').pop() || path
}

function formatSessionTime(timestamp: number): string {
  if (!timestamp) return ''
  const diffSeconds = Math.max(0, Date.now() / 1000 - timestamp)
  if (diffSeconds < 60) return '방금'
  if (diffSeconds < 60 * 60) return `${Math.floor(diffSeconds / 60)}분 전`
  if (diffSeconds < 60 * 60 * 24) return `${Math.floor(diffSeconds / 3600)}시간 전`
  const date = new Date(timestamp * 1000)
  const now = new Date()
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return `${String(date.getFullYear()).slice(-2)}.${date.getMonth() + 1}.${date.getDate()}`
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}분 ${String(seconds).padStart(2, '0')}초` : `${seconds}초`
}

function WorkingStatus({
  session,
  now,
  onCancel,
}: {
  session: AiSession
  now: number
  onCancel: () => void
}) {
  const waiting = session.queued
  const elapsed = session.runStartedAt ? formatElapsed(session.runStartedAt, now) : null
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 py-1 text-[11px] text-[#5f5e5b]"
      aria-label={waiting ? '실행 대기 중' : `작업 중${elapsed ? `, ${elapsed}` : ''}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${waiting ? 'bg-[#c09a38]' : 'animate-pulse bg-[#4a7ccc]'}`} />
      <span className="shrink-0 font-semibold text-[#37352f]">{waiting ? 'Waiting' : 'Working'}</span>
      {!waiting && (
        <span className="flex shrink-0 items-end gap-px" aria-hidden="true">
          <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
          <span className="animate-bounce" style={{ animationDelay: '120ms' }}>.</span>
          <span className="animate-bounce" style={{ animationDelay: '240ms' }}>.</span>
        </span>
      )}
      {elapsed && <span className="shrink-0 tabular-nums text-[#7d7c78]">({elapsed})</span>}
      <span className="min-w-0 flex-1 truncate text-[#7d7c78]">
        {waiting ? '실행을 기다리는 중' : session.currentStatus || '작업을 계속하는 중'}
      </span>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[#5f5e5b] hover:bg-[#e9e9e7] disabled:opacity-50"
        onClick={onCancel}
        disabled={session.cancelRequested}
      >
        {session.cancelRequested ? '중단 중…' : waiting ? '대기 취소' : '중단'}
      </button>
    </div>
  )
}

function formatLimitReset(resetsAt: number | null): string {
  if (!resetsAt) return '갱신 시각 미정'
  const remainingMs = resetsAt * 1000 - Date.now()
  if (remainingMs <= 0) return '곧 갱신'
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}분 후 갱신`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}시간 ${minutes}분 후 갱신` : `${hours}시간 후 갱신`
}

/** 한도 윈도우 길이로 라벨 결정 — 300분≈5시간, 10080분≈주간. 정보가 없으면 fallback. */
function limitWindowLabel(limit: AiUsageLimitWindow | null, fallback: string): string {
  const mins = limit?.window_duration_mins
  if (!mins) return `${fallback} 한도`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}시간 한도`
  const days = Math.round(mins / (60 * 24))
  return days === 7 ? '주간 한도' : `${days}일 한도`
}

function UsageLimitMeter({ label, limit }: { label: string; limit: AiUsageLimitWindow | null }) {
  if (!limit) {
    return <span className="text-[#9b9a97]">{label} 정보를 받을 수 없음</span>
  }
  const remaining = Math.max(0, 100 - limit.used_percent)
  const tone = remaining === 0 ? 'bg-[#d9534f]' : remaining <= 20 ? 'bg-[#d6a33c]' : 'bg-[#4a7ccc]'
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`${label}: ${limit.used_percent}% 사용 · ${formatLimitReset(limit.resets_at)}`}>
      <span className="shrink-0">{label}</span>
      <span className="h-1 w-9 overflow-hidden rounded-full bg-[#e8e8e5]" aria-hidden="true">
        <span className={`block h-full ${tone}`} style={{ width: `${limit.used_percent}%` }} />
      </span>
      <span className="shrink-0 tabular-nums">{remaining}% 남음</span>
    </span>
  )
}

function recoveryCopy(kind: NonNullable<AiSession['recovery']>['kind']) {
  switch (kind) {
    case 'cancelled':
      return { icon: '⏹', title: '이 턴을 중단했습니다', tone: 'border-[#e7e0cf] bg-[#fffcf5] text-[#795f28]' }
    case 'timeout':
      return { icon: '⏱', title: '응답 시간이 초과되었습니다', tone: 'border-[#f4dfab] bg-[#fff9eb] text-[#8a6817]' }
    case 'websocket':
      return { icon: '⌁', title: '서버와의 연결이 끊어졌습니다', tone: 'border-[#c9dcff] bg-[#f4f8ff] text-[#375a9e]' }
    case 'auth':
      return { icon: '🔐', title: '로그인 상태를 다시 확인해주세요', tone: 'border-[#e6d4ff] bg-[#faf7ff] text-[#5d4a91]' }
    case 'cli':
      return { icon: '⌘', title: 'codex CLI를 사용할 수 없습니다', tone: 'border-[#fbcaca] bg-[#fdf2f2] text-[#a12a2a]' }
    case 'limit':
      return { icon: '⏳', title: 'Codex 사용량 한도에 도달했습니다', tone: 'border-[#f4dfab] bg-[#fff9eb] text-[#8a6817]' }
    default:
      return { icon: '!', title: '요청을 완료하지 못했습니다', tone: 'border-[#fbcaca] bg-[#fdf2f2] text-[#a12a2a]' }
  }
}

function shouldOfferCodexUpdate(recovery: NonNullable<AiSession['recovery']>): boolean {
  if (recovery.kind === 'cli') return true
  if (recovery.kind !== 'auth' && recovery.kind !== 'backend') return false
  return /401|unauthorized|model.+not supported|app-server|종료 코드\s*2|codex cli/i.test(recovery.message)
}

function sessionContextLabel(session: AiSession, scopes: WorkspaceScopeEntry[] = []): string {
  if (session.kind === 'task') return `태스크 · ${pathLabel(session.taskPath || session.title)}`
  const project = session.scopeId
    ? `프로젝트 · ${scopes.find((scope) => scope.id === session.scopeId)?.label ?? session.scopeId}`
    : session.lastScopeLabel
      ? `이전 프로젝트 · ${session.lastScopeLabel}`
      : ''
  if (project) return project
  return '일반 대화'
}

type SessionDeleteRequest =
  | { kind: 'single'; sessionId: string; title: string; running: boolean }
  | { kind: 'selected'; sessionIds: string[]; count: number; runningCount: number }

function SessionSelectionCheckbox({
  checked,
  mixed = false,
  label,
  onChange,
}: {
  checked: boolean
  mixed?: boolean
  label: string
  onChange: () => void
}) {
  const active = checked || mixed
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[10px] leading-none transition-colors ${
        active
          ? 'border-[#37352f] bg-[#37352f] text-white'
          : 'border-[#c9c8c4] bg-white text-transparent hover:border-[#8a8886]'
      }`}
      onClick={onChange}
    >
      <span aria-hidden="true">{mixed ? '−' : '✓'}</span>
    </button>
  )
}

type ByeoriPanelProps = {
  /** 분리 창에서는 문서 링크를 숨은 자식 렌더러가 아니라 기본 창에 연다. */
  onOpenFile?: (path: string) => void
  onOpenErdDesigner?: (path?: string | null, directory?: string | null) => void
  /** 제공되면 헤더에 메인 창에서 여는 액션을 표시한다. */
  onReattach?: () => void
}

export default function ByeoriPanel({
  onOpenFile,
  onOpenErdDesigner: onOpenErd,
  onReattach,
}: ByeoriPanelProps = {}) {
  const root = useAppStore((s) => s.root)
  const workspaceTree = useAppStore((s) => s.tree)
  const currentPath = useAppStore((s) => s.currentPath)
  const view = useAppStore((s) => s.view)
  const storeOpenFile = useAppStore((s) => s.openFile)
  const storeOpenErdDesigner = useAppStore((s) => s.openErdDesigner)
  const openFile = onOpenFile ?? storeOpenFile
  const openErdDesigner = onOpenErd ?? storeOpenErdDesigner

  const sessions = useAiStore((s) => s.sessions)
  const activeSessionId = useAiStore((s) => s.activeSessionId)
  const sessionsLoaded = useAiStore((s) => s.sessionsLoaded)
  // 액션을 통째 스토어에서 꺼내면 무관한 전역 상태 변경에도 패널이 구독된다.
  // 각각 selector로 읽어 입력 중 렌더링 범위를 active session 상태에 한정한다.
  const loadSessions = useAiStore((s) => s.loadSessions)
  const newChatSession = useAiStore((s) => s.newChatSession)
  const selectSession = useAiStore((s) => s.selectSession)
  const closeSession = useAiStore((s) => s.closeSession)
  const closeAllSessions = useAiStore((s) => s.closeAllSessions)
  const renameSession = useAiStore((s) => s.renameSession)
  const sendChat = useAiStore((s) => s.sendChat)
  const steer = useAiStore((s) => s.steer)
  const cancel = useAiStore((s) => s.cancel)
  const retryChat = useAiStore((s) => s.retryChat)
  const dismissRecovery = useAiStore((s) => s.dismissRecovery)
  const setSessionModel = useAiStore((s) => s.setSessionModel)
  const confirmRunOrder = useAiStore((s) => s.confirmRunOrder)
  const dismissRunOrder = useAiStore((s) => s.dismissRunOrder)
  const active: AiSession | null = sessions.find((s) => s.id === activeSessionId) ?? null
  const taskScopeMismatch = Boolean(active?.sourceTaskStatus?.scope_mismatch)
  const hasRecoverableWork = sessions.some((s) => s.busy || s.queued)

  const [status, setStatus] = useState<AiEngineStatus | null>(null)
  const [models, setModels] = useState<AiModel[]>([])
  const [scopes, setScopes] = useState<WorkspaceScopeEntry[]>([])
  const [scopePickerBusy, setScopePickerBusy] = useState(false)
  const [scopePickerOpen, setScopePickerOpen] = useState(false)
  const activeProject = active?.scopeId ? scopes.find((scope) => scope.id === active.scopeId) ?? null : null
  /** 태스크 실행은 카드에 지정된 프로젝트가 실행 문맥이다. 선택기로 새 채팅을 만들 수 없게
   * 고정 대상만 읽기 전용으로 표시한다. */
  const activeTaskProjectName =
    active?.kind === 'task'
      ? activeProject
        ? activeProject.project
          ? `${activeProject.project} · ${activeProject.label}`
          : activeProject.label
        : active.scopeId || '태스크 카드/프로젝트 설정'
      : null
  // 워크스페이스 기본 모델/강도 (.workspace.json → 없으면 앱 기본값 terra/xhigh 가 내려옴)
  const [wsDefaults, setWsDefaults] = useState<{ model: string; effort: string }>({ model: '', effort: '' })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [pendingContext, setPendingContext] = useState('')
  /** 선택 액션으로 명시적으로 허용된 이번 요청의 문서 첨부 여부. */
  const [pendingIncludeDocument, setPendingIncludeDocument] = useState(false)
  /** 첨부 파일 (업로드 완료된 에셋). 이미지는 엔진에 이미지 입력으로, 일반 파일은 경로 참조로 전달.
   *  annotatingUrl 은 ✏️ 주석 편집 중인 이미지. */
  const [attachments, setAttachments] = useState<Array<{ url: string; name: string; kind: 'image' | 'file' }>>([])
  const [annotatingUrl, setAnnotatingUrl] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<ChatImage | null>(null)
  const closePreviewImage = useCallback(() => setPreviewImage(null), [])
  const [uploadBusy, setUploadBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 복구한 명시적 문서 요청은 사용자가 다른 문서를 열었어도 원래 경로를 다시 보낸다. */
  const [draftDocumentPath, setDraftDocumentPath] = useState<string | null>(null)
  const [mentionedPaths, setMentionedPaths] = useState<string[]>([])
  const [usageLimits, setUsageLimits] = useState<AiUsageLimits | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [cliUpdateBusy, setCliUpdateBusy] = useState(false)
  const [uiError, setUiError] = useState<string | null>(null)
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set())
  const [sessionDeleteRequest, setSessionDeleteRequest] = useState<SessionDeleteRequest | null>(null)
  const [sessionDeleteBusy, setSessionDeleteBusy] = useState(false)
  const [progressNow, setProgressNow] = useState(() => Date.now())

  const refreshScopes = useCallback(() => {
    if (!root) {
      setScopes([])
      return
    }
    api.workspaceSettings
      .listScopes()
      .then(({ scopes: next }) => setScopes(next))
      .catch(() => setScopes([]))
  }, [root])

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sessionDeleteConfirmRef = useRef<HTMLButtonElement>(null)
  const [mention, setMention] = useState<MentionState>({ active: false, query: '', anchor: null })
  // 문서 컨텍스트는 "지금 문서가 실제로 화면에 열려 있을 때"만 — 태스크 보드/캘린더 등
  // 다른 뷰를 보는 중에는 이전에 열었던 문서를 끌어다 붙이지 않는다. (복원된 초안은 예외)
  const visibleDocPath = view === 'editor' ? currentPath : null
  const contextDocumentPath = draftDocumentPath ?? visibleDocPath
  const limitBlocked = usageLimits?.available ? usageLimits.blocked : active?.recovery?.kind === 'limit'
  const limitResetHint = formatLimitReset(usageLimits?.primary?.resets_at ?? usageLimits?.secondary?.resets_at ?? null)

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.ai.status())
    } catch (e) {
      setUiError((e as Error).message)
    }
  }, [])

  const refreshUsageLimits = useCallback(async () => {
    try {
      setUsageLimits(await api.ai.usageLimits())
    } catch {
      setUsageLimits(null)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    return subscribeAiEngineChanged(() => {
      setModels([])
      setUsageLimits(null)
      void api.ai.status().then(async (next) => {
        setStatus(next)
        if (next.logged_in) setModels((await api.ai.models()).models)
      }).catch((e: Error) => setUiError(e.message))
    })
  }, [refreshStatus])

  useEffect(() => {
    if (status?.logged_in) {
      loadSessions()
      api.ai.models().then((r) => setModels(r.models)).catch((e: Error) => setUiError(e.message))
      refreshUsageLimits()
      api.workspaceSettings
        .get()
        .then((s) => setWsDefaults({ model: s.codex.default_model, effort: s.codex.default_effort }))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.logged_in])

  useEffect(() => {
    if (!status?.logged_in) {
      setUsageLimits(null)
      return
    }
    const timer = window.setInterval(() => void refreshUsageLimits(), 60_000)
    return () => window.clearInterval(timer)
  }, [status?.logged_in, refreshUsageLimits])

  // 세션 실행은 서버가 맡는다. 새로고침 뒤에는 기존 WebSocket을 되살릴 수 없으므로
  // 채팅·태스크 모두 세션 메타를 확인해 진행 표시와 완료 상태를 이어받는다.
  useEffect(() => {
    if (!status?.logged_in || !hasRecoverableWork) return
    const timer = window.setInterval(() => void loadSessions(), 2500)
    return () => window.clearInterval(timer)
  }, [status?.logged_in, hasRecoverableWork, loadSessions])

  useEffect(() => {
    if (active?.recovery?.kind === 'limit') void refreshUsageLimits()
  }, [active?.recovery?.kind, refreshUsageLimits])

  // 프로젝트 선택은 사용자가 벼리에서 직접 연 채팅에서만 제공한다. 태스크 세션은
  // 카드의 프로젝트를 고정해 실행하므로, 세션을 전환한 뒤 열려 있던 선택기도 닫는다.
  useEffect(() => {
    if (active?.kind !== 'chat') setScopePickerOpen(false)
  }, [active?.id, active?.kind])

  // 경로 유무와 관계없이 모든 프로젝트를 질문 대상 선택기에 노출한다. 세션의 scope 는
  // 안정적인 id 로 저장하므로, 여기서는 표시명과 경로를 해석하는 데만 사용한다.
  useEffect(() => {
    refreshScopes()
    return subscribeWorkspaceScopesChanged(refreshScopes)
  }, [refreshScopes])

  useEffect(() => {
    return aiBus.subscribe((msg) => {
      if (msg.type === 'insertContext') {
        setPendingContext(msg.text)
        setDraftDocumentPath(msg.documentPath ?? null)
        setPendingIncludeDocument(Boolean(msg.includeDocument && msg.documentPath))
        if (msg.prompt !== undefined) setPrompt(msg.prompt)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    })
  }, [])

  useEffect(() => {
    if (!sessionListOpen) {
      if (sessionDeleteRequest) setSessionDeleteRequest(null)
      setSelectedSessionIds((selected) => (selected.size > 0 ? new Set() : selected))
      return
    }
    if (!sessionDeleteRequest) return
    const frame = requestAnimationFrame(() => sessionDeleteConfirmRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [sessionDeleteRequest, sessionListOpen])

  // 자동 스크롤: 사용자가 바닥 근처에 있을 때만 새 답변과 인라인 도구 블록을 따라간다.
  // 사용자가 위로 올려 읽는 동안에는 실행 출력이 읽던 위치를 끌어내리지 않는다.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useEffect(() => {
    if (stickBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [active?.messages, active?.id])

  // 실행 시간은 서버 이벤트 도착 여부와 독립적으로 1초마다 갱신한다. 멈춘 연결도 "진행 중"처럼
  // 보이지 않게, busy가 해제되면 타이머도 바로 정리한다.
  useEffect(() => {
    if (!active?.busy || !active.runStartedAt) return
    setProgressNow(Date.now())
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active?.busy, active?.runStartedAt])

  // ── 모델/강도 ──
  // 표시 우선순위 = 실제 실행(orchestrator) 우선순위와 동일: 세션 오버라이드 > 워크스페이스
  // 기본값(terra/xhigh) > 엔진 isDefault. 엔진 isDefault(sol·medium)를 그대로 보여주면
  // 실제로 실행되는 모델과 표시가 어긋난다.
  const defaultModel =
    models.find((m) => m.id === wsDefaults.model) ?? models.find((m) => m.isDefault) ?? models[0]
  const currentModelId = active?.model ?? defaultModel?.id
  const currentModel = models.find((m) => m.id === currentModelId) ?? defaultModel
  const currentEffort =
    active?.effort ??
    (currentModelId === wsDefaults.model && wsDefaults.effort ? wsDefaults.effort : currentModel?.defaultEffort) ??
    ''
  const filteredSessions = sessions.filter((session) => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    if (!query) return true
    return [session.title, session.taskPath, session.scopeId, session.lastScopeLabel]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query))
  })
  const selectedSessions = sessions.filter((session) => selectedSessionIds.has(session.id))
  const filteredSelectedCount = filteredSessions.reduce(
    (count, session) => count + (selectedSessionIds.has(session.id) ? 1 : 0),
    0,
  )
  const allFilteredSessionsSelected =
    filteredSessions.length > 0 && filteredSelectedCount === filteredSessions.length

  const sessionModelLabel = (session: AiSession): string => {
    const model = session.model ? models.find((item) => item.id === session.model) : defaultModel
    const modelLabel = model?.displayName ?? (session.model ? session.model : '기본 모델')
    const effort =
      session.effort ??
      (model?.id === wsDefaults.model && wsDefaults.effort ? wsDefaults.effort : model?.defaultEffort)
    return effort ? `${modelLabel} · ${effort}` : modelLabel
  }

  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds((selected) => {
      const next = new Set(selected)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleAllFilteredSessions = () => {
    setSelectedSessionIds((selected) => {
      const next = new Set(selected)
      if (allFilteredSessionsSelected) {
        for (const session of filteredSessions) next.delete(session.id)
      } else {
        for (const session of filteredSessions) next.add(session.id)
      }
      return next
    })
  }

  const startNewChat = async (scope?: WorkspaceScopeEntry | null) => {
    setUiError(null)
    const id = await newChatSession({
      title: scope ? `${scope.label} 대화` : undefined,
      scopeId: scope?.id,
    })
    if (!id) {
      setUiError('새 대화를 만들 수 없습니다')
      return null
    }
    setSessionListOpen(false)
    setSessionQuery('')
    return id
  }

  /**
   * Codex 스레드는 한 프로젝트의 파일 문맥을 이어서 가진다. 따라서 실행 대상만 기존
   * 대화에서 바꾸지 않고, 사용자가 고른 프로젝트로 새 대화를 열어 문맥이 섞이지 않게 한다.
   * 작성 중인 입력·첨부는 컴포넌트 상태에 남아 있어 바로 새 대화로 보낼 수 있다.
   */
  const selectQuestionTarget = async (scopeId: string) => {
    // 태스크 보드에서 시작한 실행에는 카드의 scope가 절대 우선이다. UI 밖에서 이 함수를
    // 호출하더라도 태스크 실행을 다른 프로젝트의 새 대화로 바꾸지 않는다.
    if (active?.kind !== 'chat') return
    const nextScope = scopes.find((scope) => scope.id === scopeId) ?? null
    const activeChatScopeId = active?.kind === 'chat' ? active.scopeId ?? '' : ''
    if (active?.kind === 'chat' && !active.busy && activeChatScopeId === scopeId) return

    setScopePickerBusy(true)
    try {
      await startNewChat(nextScope)
    } finally {
      setScopePickerBusy(false)
    }
  }

  const requestRename = async (session: AiSession) => {
    const title = await dialog.prompt('대화 이름 변경', {
      defaultValue: session.title,
      placeholder: '대화 제목',
      confirmLabel: '저장',
    })
    const trimmed = title?.trim()
    if (!trimmed || trimmed === session.title) return
    await renameSession(session.id, trimmed)
  }

  const requestDelete = (session: AiSession) => {
    setSessionDeleteRequest({
      kind: 'single',
      sessionId: session.id,
      title: session.title,
      running: session.busy || session.queued,
    })
  }

  const requestDeleteSelected = () => {
    if (selectedSessions.length === 0 || sessionDeleteBusy) return
    setSessionDeleteRequest({
      kind: 'selected',
      sessionIds: selectedSessions.map((session) => session.id),
      count: selectedSessions.length,
      runningCount: selectedSessions.filter((session) => session.busy || session.queued).length,
    })
  }

  const confirmSessionDelete = async () => {
    const request = sessionDeleteRequest
    if (!request || sessionDeleteBusy) return
    setSessionDeleteBusy(true)
    setUiError(null)
    try {
      if (request.kind === 'single') {
        await closeSession(request.sessionId)
        setSelectedSessionIds((selected) => {
          if (!selected.has(request.sessionId)) return selected
          const next = new Set(selected)
          next.delete(request.sessionId)
          return next
        })
      } else {
        const currentIds = new Set(sessions.map((session) => session.id))
        const deletesEverything =
          request.sessionIds.length === currentIds.size && request.sessionIds.every((id) => currentIds.has(id))
        if (deletesEverything) {
          await closeAllSessions()
          setSessionQuery('')
        } else {
          // 세션 저장소가 한 파일을 갱신하므로 요청은 순서대로 보내 삭제 간 덮어쓰기를 막는다.
          for (const id of request.sessionIds) await closeSession(id)
        }
        setSelectedSessionIds(new Set())
      }
      setSessionDeleteRequest(null)
    } catch (error) {
      const label = request.kind === 'single' ? '대화를 삭제하지 못했습니다' : '선택한 대화를 삭제하지 못했습니다'
      setUiError(`${label}: ${(error as Error).message}`)
    } finally {
      setSessionDeleteBusy(false)
    }
  }

  // ── mention (@ 파일 참조) ──
  const detectMention = (value: string, caret: number): MentionState => {
    const upto = value.slice(0, caret)
    const at = upto.lastIndexOf('@')
    if (at < 0) return { active: false, query: '', anchor: inputRef.current }
    const prev = at > 0 ? upto[at - 1] : ' '
    if (!/\s/.test(prev)) return { active: false, query: '', anchor: inputRef.current }
    const query = upto.slice(at + 1)
    if (/\s/.test(query)) return { active: false, query: '', anchor: inputRef.current }
    return { active: true, query, anchor: inputRef.current }
  }

  const insertMention = (path: string) => {
    const el = inputRef.current
    if (!el) return
    const caret = el.selectionStart ?? prompt.length
    const upto = prompt.slice(0, caret)
    const at = upto.lastIndexOf('@')
    if (at < 0) return
    const before = prompt.slice(0, at)
    const after = prompt.slice(caret)
    const inserted = `@${path} `
    setPrompt(before + inserted + after)
    setMentionedPaths((paths) => (paths.includes(path) ? paths : [...paths, path]))
    setMention({ active: false, query: '', anchor: el })
    requestAnimationFrame(() => {
      const newCaret = before.length + inserted.length
      el.setSelectionRange(newCaret, newCaret)
      el.focus()
    })
  }

  const updatePrompt = (value: string, caret: number) => {
    setPrompt(value)
    // 자동완성에서 선택한 @ 토큰을 사용자가 지우거나 고치면 본문 첨부도 함께 제거한다.
    setMentionedPaths((paths) => {
      const retained = paths.filter((path) => value.includes(`@${path}`))
      return retained.length === paths.length ? paths : retained
    })
    const nextMention = detectMention(value, caret)
    setMention((previous) =>
      previous.active === nextMention.active && previous.query === nextMention.query && previous.anchor === nextMention.anchor
        ? previous
        : nextMention,
    )
  }

  const updateMentionFromInput = (value: string, caret: number) => {
    const nextMention = detectMention(value, caret)
    setMention((previous) =>
      previous.active === nextMention.active && previous.query === nextMention.query && previous.anchor === nextMention.anchor
        ? previous
        : nextMention,
    )
  }

  // ── 전송 / steer ──
  const send = async () => {
    const text = prompt.trim()
    if (!text && attachments.length === 0) return
    setUiError(null)

    if (limitBlocked) {
      setUiError('Codex 사용량 한도가 갱신될 때까지 새 요청을 보낼 수 없습니다.')
      return
    }

    if (active?.busy) {
      // 실행 중인 입력은 sendSteer 경로에서만 같은 턴에 전달한다.
      return
    }

    if (taskScopeMismatch) {
      setUiError(
        active?.sourceTaskStatus?.scope_error ||
          '카드의 프로젝트가 변경되었습니다. 태스크 카드에서 ‘변경된 프로젝트로 새 실행’을 시작해주세요.',
      )
      return
    }

    let sessionId = active?.id ?? null
    if (!sessionId) {
      sessionId = await startNewChat()
      if (!sessionId) {
        return
      }
    }
    const images = attachments.filter((a) => a.kind === 'image')
    const files = attachments.filter((a) => a.kind === 'file')
    sendChat(sessionId, text, {
      // 서버가 문구를 판별해 명시적인 현재 문서 요청에서만 이 경로를 사용한다.
      currentPath: contextDocumentPath ?? undefined,
      context: pendingContext || undefined,
      includeDocument: pendingIncludeDocument,
      mentionPaths: mentionedPaths,
      images: images.length ? images.map((image) => ({ url: image.url, name: image.name, alt: image.name })) : undefined,
      files: files.length ? files.map((f) => ({ url: f.url, name: f.name })) : undefined,
    })
    setPrompt('')
    setPendingContext('')
    setPendingIncludeDocument(false)
    setMentionedPaths([])
    setAttachments([])
    setDraftDocumentPath(null)
  }

  /** 파일 첨부 — 업로드 후 입력창 위 칩으로 표시. 이미지는 ✏️ 로 주석 편집 가능. */
  const attachFiles = async (list: Iterable<File>) => {
    setUiError(null)
    setUploadBusy(true)
    try {
      for (const file of list) {
        const url = await api.uploadAsset(file)
        const kind = file.type.startsWith('image/') ? 'image' : 'file'
        setAttachments((prev) => [...prev, { url, name: file.name || (kind === 'image' ? 'image' : 'file'), kind }])
      }
    } catch (e) {
      setUiError(`파일 업로드 실패: ${(e as Error).message}`)
    } finally {
      setUploadBusy(false)
    }
  }

  const sendSteer = () => {
    const text = prompt.trim()
    if (!active?.busy || !active.turnId || (!text && attachments.length === 0)) return
    const images = attachments.filter((attachment) => attachment.kind === 'image')
    const files = attachments.filter((attachment) => attachment.kind === 'file')
    steer(active.id, text, {
      images: images.length
        ? images.map((image) => ({ url: image.url, name: image.name, alt: image.name }))
        : undefined,
      files: files.length ? files.map((file) => ({ url: file.url, name: file.name })) : undefined,
    })
    setPrompt('')
    setMentionedPaths([])
    setAttachments([])
    setMention({ active: false, query: '', anchor: inputRef.current })
  }

  const restoreRecoveryToDraft = (session: AiSession) => {
    const request = session.recovery?.request
    if (!request) return
    setPrompt(request.prompt)
    setPendingContext(request.context ?? '')
    setMentionedPaths(request.mentionPaths)
    setDraftDocumentPath(request.currentPath ?? null)
    dismissRecovery(session.id)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const moveRecoveryToNewChat = async (session: AiSession) => {
    const request = session.recovery?.request
    if (!request) return
    const id = await newChatSession({
      scopeId: session.scopeId,
    })
    if (!id) {
      setUiError('새 대화를 만들 수 없습니다')
      return
    }
    sendChat(id, request.prompt, {
      currentPath: request.currentPath,
      context: request.context,
      mentionPaths: request.mentionPaths,
    })
    dismissRecovery(session.id)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 실행 중에는 Enter가 현재 턴의 추가 지시 전송이고, Shift+Enter만 줄바꿈이다.
      // 아직 steer 가능한 turn ID가 만들어지기 전/후에는 기존 초안 입력을 보존한다.
      if (active?.busy && !active.turnId) return
      e.preventDefault()
      if (active?.busy) sendSteer()
      else send()
    }
  }

  // ── 로그아웃 (codex 엔진 고유) — 초기 로그인 이후 계정 전환/해제용 ──
  const logout = async () => {
    const ok = await dialog.confirm('Codex 계정에서 로그아웃할까요?', {
      detail: '진행 중인 AI 작업을 먼저 완료하거나 중단해 주세요. 다시 로그인할 때까지 AI 작업을 사용할 수 없습니다.',
      confirmLabel: '로그아웃',
      danger: true,
    })
    if (!ok) return
    setUiError(null)
    try {
      const res = await fetch('/api/ai/logout', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? '로그아웃 실패')
      setModels([])
      setUsageLimits(null)
      notifyAiEngineChanged()
      await refreshStatus() // logged_in=false → 로그인 화면으로 전환
    } catch (e) {
      setUiError((e as Error).message)
    }
  }

  // ── 로그인 (codex 엔진 고유 — 엔진이 codex 일 때만 노출) ──
  const startLogin = () => {
    setLoginBusy(true)
    setLoginUrl(null)
    setUiError(null)
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ai/login`)
    ws.onmessage = (ev) => {
      let msg: { type: string; url?: string; message?: string }
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (msg.type === 'url' && msg.url) {
        setLoginUrl(msg.url)
        window.open(msg.url, '_blank', 'noopener,noreferrer')
      } else if (msg.type === 'success') {
        setLoginBusy(false)
        setLoginUrl(null)
        ws.close()
        notifyAiEngineChanged()
        void refreshStatus()
        void offerAppRestart().catch((e: Error) => setUiError(e.message))
      } else if (msg.type === 'error') {
        setUiError(msg.message ?? '로그인 실패')
        setLoginBusy(false)
        ws.close()
      }
    }
    ws.onerror = () => setUiError("로그인 연결에 실패했습니다. 다시 시도해 주세요.")
    ws.onclose = () => setLoginBusy(false)
  }

  const updateCodexCliAndRestart = async () => {
    const currentVersion = status?.version ? `현재 버전은 ${status.version}입니다.` : '현재 버전을 확인할 수 없습니다.'
    const ok = await dialog.confirm('Codex CLI를 최신 버전으로 업데이트할까요?', {
      detail: `${currentVersion}\n\n공식 OpenAI 릴리스에서 Twill 전용 CLI를 설치한 뒤 앱을 재시작합니다. 로그인 정보와 문서는 유지됩니다.`,
      confirmLabel: '업데이트 및 재시작',
    })
    if (!ok) return
    setCliUpdateBusy(true)
    setUiError(null)
    try {
      await api.ai.updateCodexCli()
      if (window.noteDesktop?.restart) {
        await window.noteDesktop.restart()
        return
      }
      window.location.reload()
    } catch (error) {
      setUiError((error as Error).message)
    } finally {
      setCliUpdateBusy(false)
    }
  }

  // ── 상태별 화면 ──
  if (!status) {
    return <div className="p-4 text-[12px] text-[#9b9a97]">상태 확인 중…</div>
  }

  if (!status.engine || !status.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-[#5f5e5b]">
        <span className="text-3xl">🤖</span>
        {!status.engine ? (
          <p>AI 엔진을 초기화하지 못했습니다. 앱을 다시 시작한 뒤 상태를 확인하세요.</p>
        ) : (
          <>
            <p>AI 실행에 필요한 Codex CLI가 설치되어 있지 않습니다.</p>
            <p className="text-[12px] text-[#9b9a97]">Twill 전용 최신 CLI를 설치하면 앱이 자동으로 재시작됩니다.</p>
            <button
              type="button"
              className="mt-1 rounded-md bg-[#37352f] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#2b2925] disabled:opacity-60"
              onClick={() => void updateCodexCliAndRestart()}
              disabled={cliUpdateBusy}
            >
              {cliUpdateBusy ? 'Codex CLI 업데이트 중…' : 'Codex CLI 설치 및 재시작'}
            </button>
            {uiError && <p className="text-[11px] text-[#c92a2a]">{uiError}</p>}
          </>
        )}
      </div>
    )
  }

  if (!status.logged_in) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-3xl">🤖</span>
        <p className="text-[13px] text-[#37352f]">AI 엔진 로그인이 필요합니다</p>
        <button
          className="rounded-md bg-[#37352f] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#2b2925] disabled:opacity-60"
          onClick={startLogin}
          disabled={loginBusy}
        >
          {loginBusy ? '로그인 진행 중…' : 'AI 엔진 로그인'}
        </button>
        {loginUrl && (
          <p className="text-[11px] text-[#9b9a97]">
            브라우저에서 인증을 완료해주세요.{' '}
            <a href={loginUrl} target="_blank" rel="noreferrer" className="underline">
              URL 다시 열기
            </a>
          </p>
        )}
        {uiError && <p className="text-[11px] text-[#c92a2a]">{uiError}</p>}
      </div>
    )
  }

  const messages = active?.messages ?? []
  const isPlanSession = Boolean(active?.isOrderPlan || active?.title.startsWith('전체 실행 계획'))
  const showMemorySaved = active
    ? isMemorySavedForRun(active.memoryResultRunId, active.runId, active.memoryBullets)
    : false
  const showMemoryError = Boolean(
    active?.memoryError && active.memoryResultRunId && active.memoryResultRunId === active.runId,
  )

  const showSummary =
    active &&
    !active.busy &&
    !active.queued &&
    (active.runLogPath || active.taskStatus || showMemorySaved || showMemoryError)
  const recovery = active?.recovery ? recoveryCopy(active.recovery.kind) : null
  const summaryLabel =
    active?.lastRun?.status === 'cancelled'
      ? '중단된 실행 요약'
      : active?.lastRun?.status === 'error'
        ? '실패한 실행 요약'
        : '실행 요약'

  return (
    <div className="relative flex h-full flex-col bg-white">
      {/* 헤더에는 선택한 대화 하나만 두고, 목록·수정은 드롭다운에서 처리한다. */}
      <div className="relative flex h-8 shrink-0 items-center gap-2 border-b border-[#e9e9e7] bg-[#f7f7f5] px-3 text-[12px] text-[#5f5e5b]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left hover:bg-[#efefed]"
          onClick={() => {
            setSessionListOpen((open) => !open)
            setPickerOpen(false)
            setScopePickerOpen(false)
          }}
          aria-expanded={sessionListOpen}
          title="대화 목록"
        >
          <span aria-hidden="true">🤖</span>
          <span className="min-w-0 flex-1 truncate">{active ? active.title : 'Twill AI'}</span>
          <span className="text-[9px] text-[#9b9a97]">▾</span>
        </button>
        {currentModel && (
          <button
            className="flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[11px] hover:border-[#e3e2e0] hover:bg-white"
            onClick={() => {
              setPickerOpen((v) => !v)
              setSessionListOpen(false)
              setScopePickerOpen(false)
            }}
            title="모델·강도 선택"
          >
            <span className="font-medium">{currentModel.displayName}</span>
            <span className="text-[#9b9a97]">· {currentEffort || 'default'}</span>
            <span className="text-[9px] text-[#9b9a97]">▾</span>
          </button>
        )}
        <button className="rounded px-1.5 py-0.5 hover:bg-[#efefed]" onClick={() => void startNewChat()} title="새 대화">
          +
        </button>
        {onReattach && (
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#7d7c78] hover:bg-[#efefed] hover:text-[#37352f]"
            onClick={onReattach}
            title="메인 창에서 열기"
            aria-label="Twill AI를 메인 창에서 열기"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
              <rect x="2.5" y="3" width="11" height="9.5" rx="1.25" />
              <path d="M9.5 3v9.5M5.25 8h2.5m-1.5-1.5L4.75 8l1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]"
          onClick={() => void logout()}
          title="Codex 계정 로그아웃"
          aria-label="Codex 계정 로그아웃"
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
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
            <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
          </svg>
        </button>
        {pickerOpen && currentModel && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} />
            <div className="absolute right-2 top-8 z-40 w-64 rounded-lg border border-[#e3e2e0] bg-white p-2 shadow-lg">
              <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">모델</p>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {models.map((m) => (
                  <button
                    key={m.id}
                    className={`flex w-full flex-col rounded px-2 py-1 text-left text-[12px] ${
                      m.id === currentModelId ? 'bg-[#f1f1ef] font-medium text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#f7f7f5]'
                    }`}
                    onClick={() => active && setSessionModel(active.id, m.id, m.defaultEffort || null)}
                  >
                    <span className="flex items-center gap-1">
                      {m.displayName}
                      {m.isDefault && <span className="text-[9px] text-[#9b9a97]">(기본)</span>}
                    </span>
                    {m.description && (
                      <span className="text-[10px] font-normal text-[#9b9a97] line-clamp-2">{m.description}</span>
                    )}
                  </button>
                ))}
              </div>
              <p className="mb-1 mt-2 px-1 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">추론 강도</p>
              <div className="flex flex-wrap gap-1">
                {(currentModel.supportedEfforts.length > 0
                  ? currentModel.supportedEfforts
                  : ['low', 'medium', 'high', 'xhigh']
                ).map((e) => (
                  <button
                    key={e}
                    className={`rounded px-2 py-0.5 text-[11px] ${
                      e === currentEffort ? 'bg-[#37352f] text-white' : 'bg-[#f1f1ef] text-[#5f5e5b] hover:bg-[#e0e0de]'
                    }`}
                    onClick={() => active && setSessionModel(active.id, currentModelId ?? null, e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {currentEffort === 'ultra' && (
                <p className="mt-1.5 rounded bg-[#fff7e6] px-2 py-1 text-[10px] text-[#a67c1b]">
                  ⚠️ ultra 는 내부 서브에이전트를 병렬 실행해 토큰 소모가 매우 큽니다. 까다로운 작업에만 권장.
                </p>
              )}
              {active && (
                <button
                  className="mt-2 w-full rounded border border-[#e3e2e0] px-2 py-1 text-[10px] text-[#9b9a97] hover:bg-[#f7f7f5]"
                  onClick={() => setSessionModel(active.id, null, null)}
                  title="대화별 모델 설정 해제"
                >
                  기본값으로 초기화
                </button>
              )}
              <p className="mt-1 px-1 text-[9px] text-[#9b9a97]">변경 사항은 다음 턴부터 적용됩니다.</p>
            </div>
          </>
        )}
      </div>

      {/* 세션 전환기 — 필요할 때만 열리는 드롭다운. */}
      {sessionListOpen && (
        <>
          <button
            type="button"
            className="absolute inset-x-0 bottom-0 top-8 z-10 cursor-default"
            onClick={() => setSessionListOpen(false)}
            aria-label="대화 목록 닫기"
          />
          <section className="absolute inset-x-0 top-8 z-20 border-b border-[#e9e9e7] bg-[#fbfbfa] shadow-md">
            <div className="flex h-8 items-center gap-2 px-2.5">
              <SessionSelectionCheckbox
                checked={allFilteredSessionsSelected}
                mixed={filteredSelectedCount > 0 && !allFilteredSessionsSelected}
                label={allFilteredSessionsSelected ? '현재 목록 선택 해제' : '현재 목록 전체 선택'}
                onChange={toggleAllFilteredSessions}
              />
              <span className="min-w-0 flex-1 text-[11px] text-[#5f5e5b]">
                <span className="font-medium">대화 목록</span>
                <span className="ml-1 rounded bg-[#efefed] px-1 py-px text-[10px] text-[#7d7c78]">{sessions.length}</span>
                {selectedSessions.length > 0 && (
                  <span className="ml-1.5 text-[10px] text-[#375a9e]">{selectedSessions.length}개 선택</span>
                )}
              </span>
              <button
                type="button"
                className="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-[#c92a2a] hover:bg-[#fdf0f0] disabled:cursor-not-allowed disabled:text-[#b3b2ae] disabled:hover:bg-transparent"
                onClick={requestDeleteSelected}
                disabled={selectedSessions.length === 0 || sessionDeleteBusy}
              >
                {sessionDeleteBusy ? '삭제 중…' : '선택 삭제'}
              </button>
            </div>

          <div className="border-t border-[#efefed] px-2 pb-2 pt-1.5">
            <label className="sr-only" htmlFor="byeori-session-search">
              대화 검색
            </label>
            <div className="flex items-center rounded-md border border-[#e3e2e0] bg-white px-2 focus-within:border-[#a8a6a1]">
              <span className="mr-1 text-[11px] text-[#9b9a97]">⌕</span>
              <input
                id="byeori-session-search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="대화·문서·태스크 검색"
                className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-[#37352f] outline-none placeholder:text-[#b3b2ae]"
              />
              {sessionQuery && (
                <button
                  type="button"
                  className="text-[11px] text-[#9b9a97] hover:text-[#37352f]"
                  onClick={() => setSessionQuery('')}
                  title="검색어 지우기"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="scrollbar-thin mt-1.5 max-h-44 space-y-1 overflow-y-auto pr-0.5">
              {filteredSessions.map((session) => {
                const isActive = session.id === activeSessionId
                const isSelected = selectedSessionIds.has(session.id)
                return (
                  <div
                    key={session.id}
                    className={`group flex min-w-0 items-center gap-1 rounded-md border px-1 py-1 text-[11px] ${
                      isActive
                        ? 'border-[#c9d7f8] bg-[#f5f8ff] text-[#243d73]'
                        : isSelected
                          ? 'border-[#d9ccff] bg-[#faf7ff] text-[#5d4a91]'
                        : 'border-transparent text-[#5f5e5b] hover:border-[#e6e5e2] hover:bg-white'
                    }`}
                  >
                    <SessionSelectionCheckbox
                      checked={isSelected}
                      label={`${session.title} 선택`}
                      onChange={() => toggleSessionSelection(session.id)}
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-1 text-left"
                      onClick={() => {
                        selectSession(session.id)
                        setSessionListOpen(false)
                      }}
                      title={`${session.title}\n${sessionContextLabel(session, scopes)}\n${sessionModelLabel(session)}`}
                    >
                      <span className="flex items-center gap-1">
                        {session.busy ? (
                          <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#4a9eff]" />
                        ) : session.queued ? (
                          <span className="shrink-0 text-[9px]">⏳</span>
                        ) : session.kind === 'task' ? (
                          <span className="shrink-0 text-[9px]">▶</span>
                        ) : (
                          <span className="shrink-0 text-[10px]">💬</span>
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
                        <span className="shrink-0 text-[10px] text-[#9b9a97]">{formatSessionTime(session.updatedAt)}</span>
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3.5 text-[10px] text-[#9b9a97]">
                        <span className="min-w-0 flex-1 truncate">{sessionContextLabel(session, scopes)}</span>
                        <span className="shrink-0 rounded bg-white/80 px-1 py-px text-[9px] text-[#6f6d68]">
                          {sessionModelLabel(session)}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center self-start pt-0.5 opacity-70 group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded px-1 text-[#9b9a97] hover:bg-[#e7edf9] hover:text-[#375a9e]"
                        onClick={(event) => {
                          event.stopPropagation()
                          void requestRename(session)
                        }}
                        title="대화 이름 변경"
                        aria-label={`${session.title} 이름 변경`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 text-[#9b9a97] hover:bg-[#fdf0f0] hover:text-[#c92a2a]"
                        onClick={(event) => {
                          event.stopPropagation()
                          void requestDelete(session)
                        }}
                        title="대화 삭제"
                        aria-label={`${session.title} 삭제`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
              {sessions.length === 0 && (
                <p className="px-1 py-3 text-center text-[11px] text-[#9b9a97]">아직 대화가 없습니다.</p>
              )}
              {sessions.length > 0 && filteredSessions.length === 0 && (
                <p className="px-1 py-3 text-center text-[11px] text-[#9b9a97]">일치하는 대화가 없습니다.</p>
              )}
            </div>
          </div>
          </section>
        </>
      )}

      {active?.sourceTask && <div className="shrink-0 border-b border-[#e9e9e7] px-3 py-2"><TaskSourceBanner session={active} openFile={openFile} /></div>}
      {/* 메시지 스트림 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {!active && sessionsLoaded && (
          <div className="mt-10 flex flex-col items-center gap-2 text-center text-[12px] text-[#9b9a97]">
            <span className="text-2xl">🤖</span>
            <p>
              질문을 하거나,
              <br />
              태스크 보드에서 카드를 실행해보세요.
            </p>
          </div>
        )}
        {active && messages.length === 0 && !active.busy && (
          <p className="mt-8 text-center text-[12px] text-[#9b9a97]">
            {active.kind === 'task'
              ? '태스크 실행 결과가 여기에 표시됩니다.'
              : '질문을 하거나 작업을 요청해보세요. 문서를 참조하려면 @로 첨부하거나 현재 문서를 분명히 지칭하세요.'}
          </p>
        )}

        <ChatMessageList
          messages={messages}
          isPlanSession={isPlanSession}
          root={root}
          workspaceTree={workspaceTree}
          openFile={openFile}
          openErdDesigner={openErdDesigner}
          onPreviewImage={setPreviewImage}
        />

        {active && (active.busy || active.queued) && (
          <WorkingStatus session={active} now={progressNow} onCancel={() => cancel(active.id)} />
        )}

        {/* 완료 요약 — 최종 결과·검증 액션을 한 곳에 */}
        {showSummary && active && (
          <div className="space-y-1.5 rounded-lg border border-[#e9e9e7] bg-[#fbfbfa] p-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">{summaryLabel}</p>
            {active.taskStatus && (
              <div className="rounded-md border border-[#e7f5ef] bg-[#f0fdf4] px-3 py-1.5 text-[12px] text-[#0f7a48]">
                태스크 상태 → <span className="font-medium">{active.taskStatus.status}</span>{' '}
                <button className="underline" onClick={() => openFile(active.taskStatus!.path)}>
                  카드 열기
                </button>
              </div>
            )}
            {active.runLogPath && (
              <button
                className="flex w-full items-center gap-2 rounded-md border border-[#e3e2e0] bg-white px-3 py-1.5 text-left text-[12px] text-[#37352f] hover:bg-[#f7f7f5]"
                onClick={() => openFile(active.runLogPath!)}
              >
                <span>📋</span>
                <span className="font-medium">실행 로그 열기</span>
                <span className="truncate text-[11px] text-[#9b9a97]">{active.runLogPath}</span>
              </button>
            )}
            {showMemorySaved && active.memoryBullets && active.memoryBullets.length > 0 && (
              <div className="rounded-md border-l-2 border-[#c8b6ff] bg-[#faf7ff] px-3 py-1.5 text-[11px] text-[#6f5aa8]">
                <div className="mb-0.5 font-medium">
                  {active.memoryAlreadySaved
                    ? `🧠 이미 기억하고 있음 (${active.memoryBullets.length}개)`
                    : `🧠 메모리에 저장됨 (${active.memoryBullets.length}개)`}
                </div>
                <ul className="ml-4 list-disc space-y-0.5">
                  {active.memoryBullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            {showMemoryError && active.memoryError && (
              <div className="rounded-md border-l-2 border-[#d92d20] bg-[#fff5f3] px-3 py-1.5 text-[11px] text-[#b42318]">
                <div className="mb-0.5 font-medium">🧠 메모리를 저장하지 못했습니다</div>
                <p>{active.memoryError}</p>
              </div>
            )}
          </div>
        )}

        {/* 전체 실행 순서 제안 — 계획 세션의 결론. 사용자가 확정해야 실제 실행이 시작된다. */}
        {active?.runOrderProposal && !active.busy && (
          <div className="space-y-1.5 rounded-lg border border-[#d9ccff] bg-[#faf7ff] p-2.5">
            <p className="text-[11px] font-medium text-[#5d4a91]">
              {active.runOrderProposal.parseFailed
                ? '⚠️ 결론 JSON 해석에 실패해 카드 순서 그대로 제안합니다'
                : '🤖 AI가 제안한 실행 순서'}
            </p>
            <ol className="ml-4 list-decimal space-y-0.5 text-[12px] text-[#37352f]">
              {active.runOrderProposal.titles.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            {active.runOrderProposal.reason && (
              <p className="text-[11px] leading-snug text-[#7b6aa7]">판단 근거: {active.runOrderProposal.reason}</p>
            )}
            <div className="flex gap-1.5 pt-0.5">
              <button
                className="rounded-md bg-[#37352f] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#2b2925]"
                onClick={() => void confirmRunOrder(active.id)}
                title="이 순서대로 카드마다 세션을 만들어 차례로 실행"
              >
                ▶ 이 순서로 실행
              </button>
              <button
                className="rounded-md border border-[#e3e2e0] bg-white px-2.5 py-1 text-[11px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
                onClick={() => dismissRunOrder(active.id)}
              >
                취소
              </button>
            </div>
          </div>
        )}

        {active?.recovery && recovery && (
          <div className={`rounded-md border px-3 py-2.5 text-[12px] ${recovery.tone}`}>
            <div className="flex items-start gap-2">
              <span className="mt-px text-[14px]" aria-hidden="true">
                {recovery.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{recovery.title}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-[11px] opacity-85">{active.recovery.message}</p>
                {active.kind === 'chat' && active.recovery.request && (
                  <>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="rounded border border-current/25 bg-white px-2 py-1 text-[11px] font-medium hover:bg-white/70"
                        onClick={() => retryChat(active.id)}
                      >
                        {active.recovery.kind === 'cancelled' ? '같은 대화에서 다시 시작' : '같은 대화에서 다시 시도'}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-current/20 bg-white/60 px-2 py-1 text-[11px] hover:bg-white"
                        onClick={() => restoreRecoveryToDraft(active)}
                      >
                        질문·문맥을 입력창으로 복원
                      </button>
                      <button
                        type="button"
                        className="rounded border border-current/20 bg-white/60 px-2 py-1 text-[11px] hover:bg-white"
                        onClick={() => void moveRecoveryToNewChat(active)}
                      >
                        새 대화에서 다시 시도
                      </button>
                      {active.recovery.kind === 'auth' && (
                        <button
                          type="button"
                          className="rounded border border-current/20 bg-white/60 px-2 py-1 text-[11px] hover:bg-white"
                          onClick={startLogin}
                          disabled={loginBusy}
                        >
                          로그인 다시 하기
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] opacity-75">
                      기본 재시도는 현재 대화의 맥락을 유지합니다. 새 대화는 이전 대화 맥락 없이 이 질문과 첨부 자료만 다시 보냅니다.
                    </p>
                  </>
                )}
                {shouldOfferCodexUpdate(active.recovery) && (
                  <div className="mt-2 rounded border border-current/15 bg-white/55 p-2">
                    <p className="text-[10px] opacity-80">
                      이 오류는 오래된 Codex CLI에서 발생할 수 있습니다.
                      {status?.version ? ` 현재 버전: ${status.version}` : ''}
                    </p>
                    <button
                      type="button"
                      className="mt-1.5 rounded bg-[#37352f] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#2b2925] disabled:opacity-60"
                      onClick={() => void updateCodexCliAndRestart()}
                      disabled={cliUpdateBusy || active.busy}
                    >
                      {cliUpdateBusy ? '업데이트 중…' : 'Codex CLI 업데이트 및 재시작'}
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 rounded px-1 text-[12px] opacity-60 hover:bg-white/60 hover:opacity-100"
                onClick={() => dismissRecovery(active.id)}
                aria-label="복구 안내 닫기"
                title="복구 안내 닫기"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {active?.error && !active.recovery && (
          <div className="rounded-md border border-[#fbcaca] bg-[#fdf2f2] px-3 py-2 text-[12px] text-[#c92a2a]">
            {active.error}
          </div>
        )}
      </div>

      {uiError && (
        <div className="shrink-0 border-t border-[#e9e9e7] bg-[#fdf2f2] px-3 py-1.5 text-[11px] text-[#c92a2a]">
          {uiError}
        </div>
      )}

      {/* 사용량 한도 초과 — 갱신 전까지 새 요청 불가 */}
      {limitBlocked && (
        <div className="shrink-0 border-t border-[#f4dfab] bg-[#fff9eb] px-3 py-1.5 text-[11px] text-[#8a6817]">
          ⏳ Codex 사용량 한도에 도달했습니다 — {limitResetHint}. 갱신 전까지 새 요청을 보낼 수 없습니다.
        </div>
      )}

      {/* 입력 — 실행 중에는 다음 질문 초안 작성 / "추가 지시" 버튼으로 steer */}
      <div className="shrink-0 border-t border-[#e9e9e7] p-2">
        {activeTaskProjectName ? (
          <div
            className="mb-1.5 flex min-w-0 items-center gap-2 rounded-md border border-[#d5e6ff] bg-[#f5f8ff] px-2 py-1 text-[11px] text-[#2f6fd0]"
            title={`대상 프로젝트: ${activeTaskProjectName}`}
          >
            <span className="shrink-0 text-[#5f7fb5]">대상 프로젝트</span>
            <span className="min-w-0 flex-1 truncate font-medium text-[#275eab]">{activeTaskProjectName}</span>
            <span className="shrink-0 text-[10px] text-[#5f7fb5]">태스크에서 고정</span>
          </div>
        ) : active?.kind === 'chat' ? (
          <div className="relative mb-1.5 flex min-w-0 items-center gap-2 rounded-md border border-[#e3e2e0] bg-[#fbfbfa] px-2 py-1 text-[11px] text-[#5f5e5b]">
          <span className="shrink-0 text-[#7d7c78]">질문 대상</span>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left font-medium text-[#37352f] outline-none hover:bg-[#f1f1ef] focus-visible:ring-2 focus-visible:ring-[#4a9eff] disabled:cursor-not-allowed disabled:text-[#9b9a97]"
            onClick={() => setScopePickerOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setScopePickerOpen(false)
            }}
            disabled={scopePickerBusy}
            aria-haspopup="listbox"
            aria-expanded={scopePickerOpen}
            aria-label="질문 대상 프로젝트 선택"
            title="프로젝트 선택"
          >
            <span className="min-w-0 flex-1 truncate">
              {active?.kind === 'chat' && active.scopeId
                ? activeProject
                  ? activeProject.project
                    ? `${activeProject.project} · ${activeProject.label}`
                    : activeProject.label
                  : `등록 해제된 프로젝트 · ${active.scopeId}`
                : '자동 · 워크스페이스'}
            </span>
            <span className="shrink-0 text-[10px] text-[#9b9a97]" aria-hidden="true">{scopePickerOpen ? '▴' : '▾'}</span>
          </button>
          {scopePickerBusy && <span className="shrink-0 text-[10px] text-[#9b9a97]">대화 준비 중…</span>}

          {scopePickerOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                onClick={() => setScopePickerOpen(false)}
                aria-label="질문 대상 프로젝트 선택 닫기"
              />
              <div
                className="absolute bottom-full left-0 right-0 z-40 mb-1 max-h-56 overflow-y-auto rounded-md border border-[#e3e2e0] bg-[#fbfbfa] py-1 shadow-lg"
                role="listbox"
                aria-label="질문 대상 프로젝트"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active?.kind === 'chat' && !active.scopeId}
                  className={`flex w-full flex-col px-2.5 py-1.5 text-left ${
                    active?.kind === 'chat' && !active.scopeId
                      ? 'bg-[#f1f1ef] text-[#37352f]'
                      : 'text-[#5f5e5b] hover:bg-[#f1f1ef]'
                  }`}
                  onClick={() => {
                    setScopePickerOpen(false)
                    void selectQuestionTarget('')
                  }}
                >
                  <span className="text-[11px] font-medium">자동 · 워크스페이스</span>
                  <span className="mt-0.5 text-[10px] text-[#9b9a97]">워크스페이스 기본 설정을 사용</span>
                </button>
                {scopes.map((scope) => {
                  const selected = active?.kind === 'chat' && active.scopeId === scope.id
                  return (
                    <button
                      key={scope.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left ${
                        selected ? 'bg-[#f1f1ef] text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#f1f1ef]'
                      }`}
                      onClick={() => {
                        setScopePickerOpen(false)
                        void selectQuestionTarget(scope.id)
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium">
                          {scope.project ? `${scope.project} · ${scope.label}` : scope.label}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-[#9b9a97]">
                          {scope.path || '문서 전용 · 코드·분석 경로 없음'}
                        </span>
                      </span>
                      {selected && <span className="shrink-0 text-[12px] text-[#37352f]">✓</span>}
                    </button>
                  )
                })}
                {scopes.length === 0 && (
                  <p className="px-2.5 py-2 text-[10px] text-[#9b9a97]">아직 프로젝트가 없습니다.</p>
                )}
              </div>
            </>
          )}
          </div>
        ) : null}
        {active?.kind === 'chat' && active.scopeId && !activeProject && (
          <p className="-mt-0.5 mb-1.5 px-1 text-[10px] text-[#a67c1b]">
            선택한 프로젝트({active.scopeId})를 찾을 수 없습니다. 다음 질문은 등록된 경로를 확인한 뒤 보내세요.
          </p>
        )}
        {taskScopeMismatch && !active?.busy && (
          <div className="mb-1.5 rounded-md border border-[#f4dfab] bg-[#fff9eb] px-2 py-1.5 text-[11px] text-[#8a6817]" role="alert">
            후속 요청은 이 세션에서 보낼 수 없습니다. 태스크 카드에서 ‘변경된 프로젝트로 새 실행’을 시작해주세요.
          </div>
        )}
        {/* 선택 액션으로만 생기는 명시적 문서/텍스트 컨텍스트. 일반 채팅에는 만들지 않는다. */}
        {pendingContext && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-[#fffce8] px-2 py-1 text-[11px] text-[#5f5e5b]">
            <span aria-hidden="true">✂️</span>
            <span
              className="min-w-0 flex-1 truncate"
              title={
                pendingIncludeDocument && draftDocumentPath
                  ? `선택 텍스트와 문서 전체가 이번 요청에만 첨부됩니다. 문서: ${draftDocumentPath}`
                  : pendingContext
              }
            >
              {pendingIncludeDocument && draftDocumentPath
                ? `선택 ${pendingContext.length.toLocaleString()}자 · 문서 ${draftDocumentPath}`
                : `선택 텍스트 ${pendingContext.length.toLocaleString()}자 첨부됨`}
            </span>
            <button
              type="button"
              className="shrink-0 text-[#9b9a97] hover:text-[#37352f]"
              onClick={() => {
                setPendingContext('')
                setPendingIncludeDocument(false)
                setDraftDocumentPath(null)
              }}
              title="선택 텍스트와 문서 첨부 제거"
            >
              ✕
            </button>
          </div>
        )}

        {/* 첨부 파일/이미지 칩 — 이미지는 ✏️ 로 주석(사각형·화살표·텍스트) 편집 후 첨부 가능 */}
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {attachments.map((att) => (
              <div
                key={att.url}
                className="flex items-center gap-1.5 rounded-md border border-[#e3e2e0] bg-[#fbfbfa] p-1 pr-1.5"
              >
                {att.kind === 'image' ? (
                  <button
                    type="button"
                    className="h-9 w-9 shrink-0 overflow-hidden rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4a9eff]"
                    onClick={() => setPreviewImage({ url: att.url, name: att.name, alt: att.name })}
                    title="첨부 이미지 크게 보기"
                    aria-label={`${att.name} 크게 보기`}
                  >
                    <img src={att.url} alt={att.name} className="h-full w-full object-cover" />
                  </button>
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded bg-[#f1f1ef] text-[16px]">📄</span>
                )}
                <span className="max-w-[110px] truncate text-[10px] text-[#5f5e5b]" title={att.name}>
                  {att.name}
                </span>
                {att.kind === 'image' && (
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#efefed] hover:text-[#37352f]"
                    onClick={() => setAnnotatingUrl(att.url)}
                  title="주석 달기"
                  >
                    ✏️
                  </button>
                )}
                <button
                  type="button"
                  className="rounded px-1 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#fdf0f0] hover:text-[#c92a2a]"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.url !== att.url))}
                  title="첨부 제거"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`rounded-xl border bg-white shadow-sm transition-colors focus-within:border-[#8a8886] ${
            active?.busy ? 'border-[#d9ccff] bg-[#fdfcff]' : 'border-[#e3e2e0]'
          }`}
        >
          <textarea
            ref={inputRef}
            className="block min-h-[68px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] outline-none"
            rows={3}
            placeholder={
              taskScopeMismatch && !active?.busy
                ? '카드의 최신 프로젝트로 새 실행을 시작한 뒤 후속 요청을 보내세요.'
                : active?.busy
                ? active.turnId
                  ? '기존 작업에 이어서 추가 지시 (Enter 전송, Shift+Enter 줄바꿈)'
                  : '작업을 시작하거나 마무리하는 중입니다 — 다음 질문 초안 작성 가능'
                : '질문·요청. @ 로 노트 본문 첨부 (Enter 전송, Shift+Enter 줄바꿈)'
            }
            value={prompt}
            onChange={(e) => {
              updatePrompt(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyUp={(e) => {
              // 일반 문자 입력은 onChange에서 이미 처리했다. 이동 키에서만 caret 위치에 맞춰 갱신한다.
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
              const el = e.currentTarget
              updateMentionFromInput(el.value, el.selectionStart ?? el.value.length)
            }}
            onClick={(e) => {
              const el = e.currentTarget
              updateMentionFromInput(el.value, el.selectionStart ?? el.value.length)
            }}
            onKeyDown={(e) => {
              if (mention.active && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) return
              onKey(e)
            }}
            onPaste={(e) => {
              // 클립보드의 파일(스크린샷 이미지 등)을 바로 첨부
              const files = Array.from(e.clipboardData?.files ?? [])
              if (files.length > 0) {
                e.preventDefault()
                void attachFiles(files)
              }
            }}
          />
          <MentionPopover
            state={mention}
            onSelect={insertMention}
            onDismiss={() => setMention({ active: false, query: '', anchor: inputRef.current })}
          />
          <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
            {/* 입력창 좌측 하단: 파일 첨부 (이미지 포함 모든 파일) */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files
                e.target.value = ''
                if (files?.length) void attachFiles(files)
              }}
            />
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#7d7c78] hover:bg-[#f1f1ef] hover:text-[#37352f] disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadBusy}
              title="파일 첨부"
              aria-label={uploadBusy ? '파일 업로드 중' : '파일 첨부'}
            >
              {uploadBusy ? (
                <span className="animate-pulse text-[11px]" aria-hidden="true">…</span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m21.44 11.05-8.49 8.49a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[#9b9a97]" title={root ?? ''}>
              {active?.busy ? (
                active.turnId
                  ? 'Enter: 추가 지시 전송 · Shift+Enter: 줄바꿈'
                  : '응답을 마무리하는 중입니다.'
              ) : (
                ''
              )}
            </span>
            <button
              type="button"
              aria-label={active?.busy ? '추가 지시 보내기' : '전송'}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-50 ${
                active?.busy ? 'bg-[#6f5aa8] hover:bg-[#5d4a91]' : 'bg-[#37352f] hover:bg-[#2b2925]'
              }`}
              onClick={active?.busy ? sendSteer : send}
              disabled={
                active?.busy
                  ? (!prompt.trim() && attachments.length === 0) || !active.turnId || active.cancelRequested
                  : (!prompt.trim() && attachments.length === 0) || limitBlocked || taskScopeMismatch
              }
              title={
                active?.busy
                  ? active.turnId
                    ? '추가 지시 보내기 (Enter)'
                    : '현재 작업 턴이 끝나 응답을 정리하고 있습니다. 완료 뒤 다음 질문으로 보내세요.'
                  : limitBlocked
                    ? `사용량 한도 초과 — ${limitResetHint}`
                    : taskScopeMismatch
                      ? '카드의 프로젝트가 변경되어 새 실행이 필요합니다.'
                    : '전송 (Enter)'
              }
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </div>
        </div>

        {/* 하단: Codex 계정 사용량 한도 (5시간 · 주간) */}
        {usageLimits?.available && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#f1f1ef] pt-1.5 text-[10px] text-[#7d7c78]">
            <UsageLimitMeter label={limitWindowLabel(usageLimits.primary, '5시간')} limit={usageLimits.primary} />
            <UsageLimitMeter label={limitWindowLabel(usageLimits.secondary, '주간')} limit={usageLimits.secondary} />
            {usageLimits.plan_type && <span className="ml-auto shrink-0 text-[#b3b2ae]">{usageLimits.plan_type}</span>}
          </div>
        )}
      </div>

      {sessionDeleteRequest && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/25 p-4"
          onClick={() => {
            if (!sessionDeleteBusy) setSessionDeleteRequest(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !sessionDeleteBusy) setSessionDeleteRequest(null)
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="byeori-session-delete-title"
            aria-describedby="byeori-session-delete-detail"
            className="w-full max-w-sm overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-4 pb-3 pt-4">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#fdf0f0] text-[#c92a2a]"
                aria-hidden="true"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v5M14 11v5" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p id="byeori-session-delete-title" className="break-words text-[13px] font-medium text-[#37352f]">
                  {sessionDeleteRequest.kind === 'single'
                    ? `“${sessionDeleteRequest.title}” 대화를 삭제할까요?`
                    : `선택한 대화 ${sessionDeleteRequest.count}개를 삭제할까요?`}
                </p>
                <p id="byeori-session-delete-detail" className="mt-1 text-[11px] leading-relaxed text-[#7d7c78]">
                  {sessionDeleteRequest.kind === 'single' && sessionDeleteRequest.running
                    ? '진행 중이거나 대기 중인 실행도 함께 중단됩니다. '
                    : sessionDeleteRequest.kind === 'selected' && sessionDeleteRequest.runningCount > 0
                      ? `진행 중이거나 대기 중인 실행 ${sessionDeleteRequest.runningCount}개도 함께 중단됩니다. `
                      : ''}
                  삭제한 대화는 되돌릴 수 없습니다.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#efefed] bg-[#fbfbfa] px-4 py-2.5">
              <button
                type="button"
                className="rounded-md border border-[#e3e2e0] bg-white px-3 py-1.5 text-[11px] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:opacity-50"
                onClick={() => setSessionDeleteRequest(null)}
                disabled={sessionDeleteBusy}
              >
                취소
              </button>
              <button
                ref={sessionDeleteConfirmRef}
                type="button"
                className="rounded-md bg-red-600 px-3 py-1.5 text-[11px] font-medium text-[#ffffff] hover:bg-red-500 disabled:opacity-50"
                onClick={() => void confirmSessionDelete()}
                disabled={sessionDeleteBusy}
              >
                {sessionDeleteBusy
                  ? '삭제 중…'
                  : sessionDeleteRequest.kind === 'single'
                    ? '대화 삭제'
                    : `${sessionDeleteRequest.count}개 삭제`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 첨부 이미지 주석 편집 — 노트 이미지에 쓰는 것과 동일한 편집기(ImageAnnotator) 재사용.
          저장하면 주석이 반영된 새 에셋으로 교체되어 첨부된다. */}
      {annotatingUrl && (
        <ImageAnnotator
          imageUrl={annotatingUrl}
          onSave={(newUrl) => {
            setAttachments((prev) => prev.map((att) => (att.url === annotatingUrl ? { ...att, url: newUrl } : att)))
            setAnnotatingUrl(null)
          }}
          onClose={() => setAnnotatingUrl(null)}
        />
      )}
      {previewImage && <ChatImageLightbox image={previewImage} onClose={closePreviewImage} />}
    </div>
  )
}
