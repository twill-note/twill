/**
 * 프로젝트(= scope) 목록은 사이드바, 프로젝트 관리, Twill AI 선택기에 함께 표시된다.
 *
 * 같은 창에서는 DOM 이벤트로, 분리된 Twill AI 창까지는 BroadcastChannel로 변경을
 * 전달한다. 서버 저장이 완료된 뒤에만 notify를 호출해야 각 화면이 같은 원본을 읽는다.
 */
const EVENT_NAME = 'workspace-scopes-changed'
const CHANNEL_NAME = 'twill-workspace-scopes'

let channel: BroadcastChannel | null | undefined

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
  return channel
}

export function notifyWorkspaceScopesChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(EVENT_NAME))
  getChannel()?.postMessage(null)
}

export function subscribeWorkspaceScopesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => listener()
  const scopeChannel = getChannel()
  window.addEventListener(EVENT_NAME, onChange)
  scopeChannel?.addEventListener('message', onChange)
  return () => {
    window.removeEventListener(EVENT_NAME, onChange)
    scopeChannel?.removeEventListener('message', onChange)
  }
}
