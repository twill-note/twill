import { useCallback, useEffect, useRef, useState } from 'react'
import { usePluginRegistry } from '../plugins/registry'

type Rect = { top: number; left: number }

/** 선택 질문에 보낼 수 있는 최대 문자 수. 잘라서 다른 내용으로 바꾸지 않고 아예 액션을 숨긴다. */
const MAX_SELECTION_LENGTH = 6_000

function parentElement(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/**
 * 편집 가능한 BlockNote 텍스트에서만 선택 동작을 허용한다.
 * 코드 복사·이미지 주석·읽기 전용 커스텀 블록에서 우연히 선택한 문자열에는 툴바가
 * 뜨지 않게 해, 실제 문단을 선택했다는 기대와 전송 내용이 어긋나지 않게 한다.
 */
function isEditableNode(node: Node | null, container: HTMLElement): boolean {
  const element = parentElement(node)
  if (!element || !container.contains(element)) return false
  const editable = element.closest<HTMLElement>('[contenteditable="true"]')
  if (!editable || !container.contains(editable)) return false
  const readonly = element.closest<HTMLElement>('[contenteditable="false"], [data-readonly="true"]')
  return !readonly || !container.contains(readonly)
}

/**
 * 편집기 영역에서 텍스트를 드래그하거나 키보드로 선택했을 때 뜨는 플로팅 툴바.
 * 플러그인이 등록한 selectionAction 을 버튼으로 렌더한다.
 *
 * notePath 는 분할 편집기에서 현재 활성 탭과 다를 수 있으므로 전역 currentPath 대신
 * 실제 선택이 발생한 편집기 인스턴스가 넘긴 값을 사용한다.
 */
export default function SelectionToolbar({
  containerRef,
  notePath,
  enabled = true,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  notePath: string | null
  /** 워크스페이스 밖 문서처럼 원본 경로를 안전하게 전달할 수 없는 경우 비활성화한다. */
  enabled?: boolean
}) {
  const actions = usePluginRegistry((s) => s.selectionActions)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Rect | null>(null)
  const [text, setText] = useState('')
  const [notice, setNotice] = useState('')

  const clear = useCallback(() => {
    setPos(null)
    setText('')
    setNotice('')
  }, [])

  const updateSelection = useCallback(() => {
    const selection = window.getSelection()
    const container = containerRef.current
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container || !enabled) {
      clear()
      return
    }

    if (!isEditableNode(selection.anchorNode, container) || !isEditableNode(selection.focusNode, container)) {
      clear()
      return
    }

    // 앞뒤 공백만 제거한다. 중간의 줄바꿈·여러 블록 문맥은 그대로 보존한다.
    const selectedText = selection.toString().trim()
    if (!selectedText) {
      clear()
      return
    }
    if (selectedText.length > MAX_SELECTION_LENGTH) {
      clear()
      setNotice(`선택한 내용이 너무 깁니다. ${MAX_SELECTION_LENGTH.toLocaleString()}자 이하로 다시 선택하세요.`)
      return
    }

    const range = selection.getRangeAt(0)
    // 여러 블록을 가로지르는 선택은 union rect가 지나치게 커질 수 있다. 마지막 실제 줄의
    // rect를 기준으로 하면 스크롤 중에도 선택 끝 근처에 안정적으로 표시된다.
    const rects = Array.from(range.getClientRects())
    const rect = rects.at(-1) ?? range.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      clear()
      return
    }
    const parentRect = container.getBoundingClientRect()
    setPos({
      top: rect.top - parentRect.top - 38,
      left: rect.left - parentRect.left + Math.max(rect.width, 1) / 2,
    })
    setText(selectedText)
    setNotice('')
  }, [clear, containerRef, enabled])

  useEffect(() => {
    if (actions.length === 0 || !enabled) {
      clear()
      return
    }
    const container = containerRef.current
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target || (container?.contains(target) ?? false) || (toolbarRef.current?.contains(target) ?? false)) return
      clear()
    }
    document.addEventListener('selectionchange', updateSelection)
    document.addEventListener('mousedown', onPointerDown, true)
    // 실제 스크롤 컨테이너는 편집기 래퍼의 상위에 있다. capture 단계에서 받으면 분할
    // 패널·중첩 스크롤 모두에서 선택 범위 근처로 툴바 위치를 다시 계산할 수 있다.
    window.addEventListener('scroll', updateSelection, true)
    window.addEventListener('resize', updateSelection)
    return () => {
      document.removeEventListener('selectionchange', updateSelection)
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('scroll', updateSelection, true)
      window.removeEventListener('resize', updateSelection)
    }
  }, [actions.length, clear, containerRef, enabled, updateSelection])

  if (!enabled || actions.length === 0) return null

  return (
    <>
      <span className="sr-only" aria-live="polite">
        {notice}
      </span>
      {pos && text && (
        <div
          ref={toolbarRef}
          className="pointer-events-auto absolute z-40 -translate-x-1/2 rounded-md border border-[#e3e2e0] bg-white px-1 py-0.5 shadow-lg"
          style={{ top: Math.max(0, pos.top), left: pos.left }}
          // 클릭해도 브라우저가 선택을 해제하지 않게 한다. 키보드(Tab/Enter)는 기본 동작을
          // 유지하므로 스크린 리더와 키보드만으로도 액션을 실행할 수 있다.
          onMouseDown={(event) => event.preventDefault()}
          role="toolbar"
          aria-label="선택한 텍스트 작업"
        >
          <div className="flex items-center gap-0.5">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-[#37352f] hover:bg-[#f1f1ef] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4a9eff]"
                title={action.label}
                aria-label={`${action.label}: 선택한 텍스트를 Twill AI 입력창에 첨부`}
                onClick={() => {
                  // selectionchange가 뒤늦게 발생해도 state에 보관한 문자열·문서 경로를
                  // 사용한다. 선택 범위 자체를 재조회하거나 축약하지 않는다.
                  action.onInvoke(text, notePath)
                  window.getSelection()?.removeAllRanges()
                  clear()
                }}
              >
                {action.icon && <span aria-hidden="true">{action.icon}</span>}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
