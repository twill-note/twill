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
  const instruction = '주간 사용 한도를 새 계정 기준으로 갱신하려면 Twill을 완전히 종료한 뒤 다시 실행해 주세요.'
  if (!window.noteDesktop?.restart) {
    await dialog.alert('로그인이 완료되었습니다. 앱 재시작이 필요합니다.', { detail: instruction + '\n브라우저 개발 모드에서는 백엔드도 다시 시작해 주세요.' })
    return
  }
  try {
    await window.noteDesktop.restart()
  } catch (error) {
    await dialog.alert('로그인은 완료되었지만 자동 재시작하지 못했습니다.', { detail: `${(error as Error).message}\n\n${instruction}` })
  }
}
