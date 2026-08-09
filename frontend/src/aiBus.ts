/**
 * 벼리 패널과 다른 컴포넌트 간의 경량 이벤트 버스.
 *
 * 선택 질문은 자동 문서 첨부와 구분되는 명시적 사용자 액션이다. 그래서 선택문뿐 아니라
 * 그때의 문서 경로·기본 질문·문서 첨부 의도도 한 번에 보존한다. 패널을 연 뒤 현재 탭이
 * 바뀌어도 다른 문서를 잘못 전송하지 않도록 한다.
 */
export type AiBusMessage = {
  type: 'insertContext'
  text: string
  documentPath?: string | null
  prompt?: string
  /** 사용자가 선택 액션을 눌렀을 때만 현재 문서 전체를 이 요청에 첨부한다. */
  includeDocument?: boolean
}

type Listener = (msg: AiBusMessage) => void

const listeners = new Set<Listener>()
const crossWindowChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new BroadcastChannel('note:byeori-context')
  : null

crossWindowChannel?.addEventListener('message', (event: MessageEvent<AiBusMessage>) => {
  const message = event.data
  if (!message || message.type !== 'insertContext' || typeof message.text !== 'string') return
  for (const listener of [...listeners]) listener(message)
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => crossWindowChannel?.close())
}

export const aiBus = {
  emit(msg: AiBusMessage) {
    for (const l of [...listeners]) l(msg)
    crossWindowChannel?.postMessage(msg)
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
