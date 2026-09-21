import { dialog } from './dialog'

export type CodexUpdate = {
  installed: boolean
  current_version: string | null
  latest_version: string | null
  update_available: boolean
  busy: boolean
}

export async function aiMaintenanceRequest<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/ai/${path}`, { method })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'AI 엔진 요청에 실패했습니다.')
  return body as T
}

export function notifyAiEngineChanged() {
  window.dispatchEvent(new Event('twill:ai-engine-changed'))
  const channel = new BroadcastChannel('twill-ai-engine')
  channel.postMessage('changed')
  channel.close()
}

export function subscribeAiEngineChanged(callback: () => void) {
  const channel = new BroadcastChannel('twill-ai-engine')
  channel.onmessage = callback
  window.addEventListener('twill:ai-engine-changed', callback)
  return () => {
    channel.close()
    window.removeEventListener('twill:ai-engine-changed', callback)
  }
}

export async function offerAppRestart() {
  if (!window.noteDesktop) return
  const confirmed = await dialog.confirm('로그인이 완료되었습니다. Twill을 다시 시작할까요?', {
    detail: '새 계정으로 AI 엔진을 초기화했습니다. 모든 창의 편집 내용을 저장한 뒤 다시 시작해 주세요.',
    confirmLabel: '앱 다시 시작',
  })
  if (confirmed) await window.noteDesktop.restart()
}
