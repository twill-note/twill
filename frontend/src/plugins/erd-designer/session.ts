import { registerRestartGuard } from '../../restartGuards'
import type { ErdDiagram } from './types'

export type ErdTabSession = {
  /** 같은 ERD를 다시 열어도 편집기 상태를 새로 마운트하기 위한 인스턴스 키. */
  instanceId: string
  filePath: string | null
  initialPath?: string
  diagram: ErdDiagram
}

/** 패널 사이 탭 이동 중에도 저장 전 편집 상태를 보관하는 탭별 세션. */
const diagramSessions = new Map<string, ErdTabSession>()
const dirtyTabs = new Map<string, boolean>()
registerRestartGuard(() => {
  if ([...dirtyTabs.values()].some(Boolean)) throw new Error('저장하지 않은 ERD가 있습니다. 저장한 뒤 앱을 완전히 종료하고 다시 실행해 주세요.')
})
const closeRequests = new Map<string, () => void>()

export function getErdTabSession(tabId: string): ErdTabSession | undefined {
  return diagramSessions.get(tabId)
}

export function setErdTabSession(tabId: string, session: ErdTabSession) {
  diagramSessions.set(tabId, session)
}

/** 활성 ERD라면 디자이너가 자체 저장 확인 대화상자를 띄우도록 닫기를 위임한다. */
export function requestCloseErdTab(tabId: string): boolean {
  const request = closeRequests.get(tabId)
  if (!request) return false
  request()
  return true
}

/** 비활성 ERD 탭의 저장되지 않은 변경 여부. */
export function hasUnsavedErdTab(tabId: string): boolean {
  return dirtyTabs.get(tabId) === true
}

export function setErdTabDirty(tabId: string, dirty: boolean) {
  dirtyTabs.set(tabId, dirty)
}

export function registerErdTabCloseRequest(tabId: string, request: (() => void) | null) {
  if (request) closeRequests.set(tabId, request)
  else closeRequests.delete(tabId)
}

/** 탭이 닫힌 뒤 보관 중인 편집 상태를 비운다. */
export function discardErdTabSession(tabId: string) {
  diagramSessions.delete(tabId)
  dirtyTabs.delete(tabId)
  closeRequests.delete(tabId)
}
