import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { dialog } from '../dialog'
import { APP_UI_FONT_FAMILY } from '../fontFamilies'
import { useBackdropDismiss } from '../useBackdropDismiss'

// ─────────────────────────────────────────────────────────
// 주석 데이터 모델 — 좌표는 항상 "이미지 원본 픽셀 공간"
// (표시 크기와 무관 · 저장 시 그대로 원본에 오버레이됨)
// ─────────────────────────────────────────────────────────
type Tool = 'rect' | 'arrow' | 'pen' | 'text'
type Color = string

interface RectA { kind: 'rect'; x: number; y: number; w: number; h: number; color: Color; stroke: number }
interface ArrowA { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: Color; stroke: number }
interface PenA { kind: 'pen'; points: Array<[number, number]>; color: Color; stroke: number }
interface TextA { kind: 'text'; x: number; y: number; text: string; color: Color; size: number }
type Annotation = RectA | ArrowA | PenA | TextA

const COLORS: Color[] = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#111827', '#ffffff']
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

const TOOLS: { id: Tool; icon: string; name: string; desc: string }[] = [
  { id: 'rect',  icon: '⬜', name: '사각형', desc: '드래그로 강조 박스' },
  { id: 'arrow', icon: '➡️', name: '화살표', desc: '방향 지시' },
  { id: 'pen',   icon: '✏️', name: '자유선', desc: '손그림 / 언더라인' },
  { id: 'text',  icon: '🅰️', name: '텍스트', desc: '클릭하여 입력' },
]

interface Props {
  imageUrl: string
  onSave: (newUrl: string) => void
  onClose: () => void
}

export default function ImageAnnotator({ imageUrl, onSave, onClose }: Props) {
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose, imageUrl)
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState<Color>('#ef4444')
  const [stroke, setStroke] = useState<number>(6)
  const [textSize, setTextSize] = useState<number>(28)
  const [items, setItems] = useState<Annotation[]>([])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState<number>(1)  // 1 = 원본 픽셀 = 원본 해상도

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const nw = img?.naturalWidth ?? 0
  const nh = img?.naturalHeight ?? 0

  // 이미지 로드
  useEffect(() => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => {
      setImg(el)
      // 로드 직후 자동으로 뷰포트에 맞는 줌 선택 (100% 초과 방지)
      const availW = Math.min(window.innerWidth - 340, 1400)
      const availH = window.innerHeight - 260
      const fit = Math.min(availW / el.naturalWidth, availH / el.naturalHeight, 1)
      // 프리셋 줌 중 fit 보다 작으면서 가장 큰 값
      const chosen = ZOOM_LEVELS.slice().reverse().find((z) => z <= fit) ?? 0.25
      setZoom(chosen)
    }
    el.onerror = () => dialog.alert('이미지를 불러올 수 없습니다')
    el.src = imageUrl
  }, [imageUrl])

  // 캔버스 렌더 (DPR 대응 · 원본 해상도 캔버스 · CSS 스케일)
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !img || !nw || !nh) return

    // 백킹 스토어: 원본 * DPR — 확대해도 픽셀 손실 없음
    c.width = Math.round(nw * dpr)
    c.height = Math.round(nh * dpr)
    // CSS 크기: 원본 * 줌
    c.style.width = `${nw * zoom}px`
    c.style.height = `${nh * zoom}px`

    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)  // 이후 그리기는 원본 픽셀 좌표로

    // 이미지 스무딩 품질 — 다운스케일/업스케일 모두 개선
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.clearRect(0, 0, nw, nh)
    ctx.drawImage(img, 0, 0, nw, nh)
    for (const a of items) drawAnn(ctx, a)
    if (draft) drawAnn(ctx, draft)
  }, [img, nw, nh, dpr, zoom, items, draft])

  // 마우스 좌표 → 이미지 원본 좌표
  const getPos = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    // CSS 좌표를 이미지 원본 좌표로 역스케일
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
  }

  const startDrag = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (textInput) return
    const { x, y } = getPos(e)
    if (tool === 'rect') setDraft({ kind: 'rect', x, y, w: 0, h: 0, color, stroke })
    else if (tool === 'arrow') setDraft({ kind: 'arrow', x1: x, y1: y, x2: x, y2: y, color, stroke })
    else if (tool === 'pen') setDraft({ kind: 'pen', points: [[x, y]], color, stroke })
    else if (tool === 'text') setTextInput({ x, y, value: '' })
  }

  const dragMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draft) return
    const { x, y } = getPos(e)
    if (draft.kind === 'rect') setDraft({ ...draft, w: x - draft.x, h: y - draft.y })
    else if (draft.kind === 'arrow') setDraft({ ...draft, x2: x, y2: y })
    else if (draft.kind === 'pen') setDraft({ ...draft, points: [...draft.points, [x, y]] })
  }

  const endDrag = () => {
    if (!draft) return
    // 원본 픽셀 기준 3px 미만 = 취소
    const tiny =
      (draft.kind === 'rect' && Math.abs(draft.w) < 3 && Math.abs(draft.h) < 3) ||
      (draft.kind === 'arrow' && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 3) ||
      (draft.kind === 'pen' && draft.points.length < 2)
    if (!tiny) setItems((prev) => [...prev, draft])
    setDraft(null)
  }

  const commitText = () => {
    if (!textInput || !textInput.value.trim()) {
      setTextInput(null)
      return
    }
    setItems((prev) => [
      ...prev,
      { kind: 'text', x: textInput.x, y: textInput.y, text: textInput.value, color, size: textSize },
    ])
    setTextInput(null)
  }

  const undo = () => setItems((prev) => prev.slice(0, -1))
  const clear = async () => {
    if (items.length === 0) return
    const ok = await dialog.confirm('모든 주석을 지울까요?', { danger: true, confirmLabel: '모두 지우기' })
    if (ok) setItems([])
  }

  // 저장 — 원본 해상도로 정확히 인코딩
  const save = async () => {
    if (!img || saving) return
    setSaving(true)
    try {
      const off = document.createElement('canvas')
      off.width = nw
      off.height = nh
      const octx = off.getContext('2d')
      if (!octx) throw new Error('캔버스를 만들 수 없음')
      octx.imageSmoothingEnabled = true
      octx.imageSmoothingQuality = 'high'
      octx.drawImage(img, 0, 0, nw, nh)
      for (const a of items) drawAnn(octx, a)
      // PNG 무손실 저장 (JPEG 이었으면 원본 확장자도 유지하고 싶지만 우리 서버가 PNG 로 받음)
      const blob = await new Promise<Blob | null>((res) => off.toBlob((b) => res(b), 'image/png'))
      if (!blob) throw new Error('이미지 인코딩 실패')
      const file = new File([blob], 'annotated.png', { type: 'image/png' })
      const url = await api.uploadAsset(file)
      onSave(url)
    } catch (e) {
      dialog.alert((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Ctrl+휠 로 줌
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => {
        const idx = ZOOM_LEVELS.indexOf(z)
        const nextIdx = e.deltaY > 0 ? Math.max(0, idx - 1) : Math.min(ZOOM_LEVELS.length - 1, idx + 1)
        return ZOOM_LEVELS[nextIdx] ?? z
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 키보드 단축: Esc 닫기, Cmd/Ctrl+Z 되돌리기, Cmd/Ctrl+S 저장
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        undo()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, img])

  const cursorClass = useMemo(() => {
    if (textInput) return 'cursor-text'
    if (tool === 'text') return 'cursor-text'
    return 'cursor-crosshair'
  }, [tool, textInput])

  const dirty = items.length > 0

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={dismissFromBackdrop}>
      <div
        className="flex h-[92vh] w-[1200px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-3 border-b border-[#efefed] px-5 py-3">
          <span className="text-[20px]">✏️</span>
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-[#37352f]">이미지 편집</h3>
            <p className="mt-0.5 text-[11px] text-[#9b9a97]">
              {img
                ? <>원본 <b className="text-[#5f5e5b]">{nw} × {nh}</b> px · 현재 <b className="text-[#5f5e5b]">{Math.round(zoom * 100)}%</b> 표시 · {items.length}개 주석</>
                : '이미지 로딩 중…'}
              {dirty && <span className="ml-2 text-orange-600">● 저장 안 됨</span>}
            </p>
          </div>
          <button
            className="rounded-md border border-[#e3e2e0] px-3 py-1.5 text-[12px] hover:bg-[#f1f1ef]"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium text-white ${
              img && !saving ? 'bg-[#37352f] hover:bg-[#565452]' : 'cursor-not-allowed bg-[#c9c8c4]'
            }`}
            onClick={save}
            disabled={saving || !img}
            title="⌘S / Ctrl+S"
          >
            {saving ? '저장 중…' : '저장 (⌘S)'}
          </button>
        </div>

        {/* 본문: 왼쪽 도구 패널 + 오른쪽 캔버스 */}
        <div className="flex flex-1 overflow-hidden">
          {/* 왼쪽 도구 사이드바 */}
          <div className="flex w-[220px] flex-col gap-4 overflow-y-auto border-r border-[#efefed] p-3 text-[12px]">
            {/* 도구 */}
            <section>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">도구</p>
              <div className="grid grid-cols-2 gap-1">
                {TOOLS.map((t) => (
                  <button
                    key={t.id}
                    className={`flex flex-col items-center gap-0.5 rounded border px-1 py-2 ${
                      tool === t.id
                        ? 'border-blue-400 bg-blue-50 text-[#37352f]'
                        : 'border-[#e3e2e0] text-[#5f5e5b] hover:bg-[#f1f1ef]'
                    }`}
                    onClick={() => setTool(t.id)}
                    title={t.desc}
                  >
                    <span className="text-[18px]">{t.icon}</span>
                    <span className="text-[11px] font-medium">{t.name}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* 색상 */}
            <section>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">색상</p>
              <div className="grid grid-cols-7 gap-1">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-[#37352f]' : 'border-white ring-1 ring-[#e3e2e0]'}`}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </section>

            {/* 굵기 / 크기 */}
            {tool === 'text' ? (
              <section>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">글자 크기</p>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={12}
                    max={128}
                    value={textSize}
                    onChange={(e) => setTextSize(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-[11px] text-[#5f5e5b]">{textSize}px</span>
                </div>
              </section>
            ) : (
              <section>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">선 굵기</p>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={32}
                    value={stroke}
                    onChange={(e) => setStroke(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-8 text-right text-[11px] text-[#5f5e5b]">{stroke}</span>
                </div>
              </section>
            )}

            {/* 줌 */}
            <section>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9b9a97]">
                줌 (Ctrl+휠)
              </p>
              <div className="mb-1 grid grid-cols-4 gap-1">
                {[0.25, 0.5, 1, 2].map((z) => (
                  <button
                    key={z}
                    className={`rounded border px-1 py-0.5 text-[11px] ${
                      zoom === z
                        ? 'border-blue-400 bg-blue-50 font-medium text-[#37352f]'
                        : 'border-[#e3e2e0] text-[#5f5e5b] hover:bg-[#f1f1ef]'
                    }`}
                    onClick={() => setZoom(z)}
                  >
                    {Math.round(z * 100)}%
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px] text-[#5f5e5b]">
                <button
                  className="rounded border border-[#e3e2e0] px-1.5 py-0.5 hover:bg-[#f1f1ef]"
                  onClick={() => {
                    const idx = ZOOM_LEVELS.indexOf(zoom)
                    if (idx > 0) setZoom(ZOOM_LEVELS[idx - 1])
                  }}
                  title="축소"
                >
                  −
                </button>
                <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
                <button
                  className="rounded border border-[#e3e2e0] px-1.5 py-0.5 hover:bg-[#f1f1ef]"
                  onClick={() => {
                    const idx = ZOOM_LEVELS.indexOf(zoom)
                    if (idx < ZOOM_LEVELS.length - 1) setZoom(ZOOM_LEVELS[idx + 1])
                  }}
                  title="확대"
                >
                  +
                </button>
              </div>
            </section>

            {/* 액션 */}
            <section className="mt-auto">
              <div className="flex flex-col gap-1">
                <button
                  className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:opacity-40"
                  onClick={undo}
                  disabled={items.length === 0}
                  title="⌘Z / Ctrl+Z"
                >
                  ↶ 실행 취소 ({items.length})
                </button>
                <button
                  className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:opacity-40"
                  onClick={clear}
                  disabled={items.length === 0}
                >
                  🗑 모두 지우기
                </button>
              </div>
            </section>
          </div>

          {/* 오른쪽 캔버스 영역 (원본 해상도 + 스크롤/줌) */}
          <div
            ref={scrollRef}
            className="scrollbar-thin relative flex-1 overflow-auto bg-[#2b2a28] p-4"
          >
            {img && nw && nh ? (
              <div
                className="relative mx-auto"
                style={{ width: nw * zoom, height: nh * zoom }}
              >
                <canvas
                  ref={canvasRef}
                  className={`block ${cursorClass}`}
                  onMouseDown={startDrag}
                  onMouseMove={dragMove}
                  onMouseUp={endDrag}
                  onMouseLeave={endDrag}
                />
                {textInput && (
                  <input
                    autoFocus
                    className="absolute rounded border-2 bg-white/95 px-1 outline-none"
                    style={{
                      left: textInput.x * zoom,
                      top: (textInput.y - textSize / 2) * zoom,
                      borderColor: color,
                      color,
                      fontSize: textSize * zoom,
                      lineHeight: 1.2,
                      minWidth: 60,
                    }}
                    value={textInput.value}
                    onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                    onBlur={commitText}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitText()
                      }
                      if (e.key === 'Escape') setTextInput(null)
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-white">
                이미지 로딩 중…
              </div>
            )}
          </div>
        </div>

        {/* 하단 힌트 바 */}
        <div className="flex items-center justify-between border-t border-[#efefed] bg-[#fafafa] px-4 py-2 text-[11px] text-[#9b9a97]">
          <span>
            💡 도구 선택 → 캔버스 위 드래그 · 텍스트는 클릭 후 입력 · <b>Ctrl+휠</b> 로 확대/축소 · <b>⌘Z</b> 실행 취소 · <b>⌘S</b> 저장
          </span>
          <span>원본 해상도 무손실 저장</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 이미지 원본 좌표계에서 주석을 그림.
 * 호출자가 이미 ctx.scale(dpr, dpr) 을 적용해 두어야 화면에서 선명함.
 * 저장용 offscreen 캔버스는 원본 픽셀 그대로 (dpr=1) 그리면 됨.
 */
function drawAnn(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save()
  if (a.kind === 'rect') {
    ctx.strokeStyle = a.color
    ctx.lineWidth = a.stroke
    ctx.strokeRect(a.x, a.y, a.w, a.h)
  } else if (a.kind === 'arrow') {
    const { x1, y1, x2, y2 } = a
    ctx.strokeStyle = a.color
    ctx.fillStyle = a.color
    ctx.lineWidth = a.stroke
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const size = Math.max(8, a.stroke * 3)
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6))
    ctx.closePath()
    ctx.fill()
  } else if (a.kind === 'pen') {
    if (a.points.length < 2) return
    ctx.strokeStyle = a.color
    ctx.lineWidth = a.stroke
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(a.points[0][0], a.points[0][1])
    for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i][0], a.points[i][1])
    ctx.stroke()
  } else if (a.kind === 'text') {
    ctx.fillStyle = a.color
    ctx.font = `${a.size}px ${APP_UI_FONT_FAMILY}`
    ctx.textBaseline = 'top'
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'
    ctx.lineWidth = Math.max(2, a.size * 0.08)
    ctx.strokeText(a.text, a.x, a.y - a.size / 2)
    ctx.fillText(a.text, a.x, a.y - a.size / 2)
  }
  ctx.restore()
}
