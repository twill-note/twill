import type { DocTab } from './store'

export const AI_LOBBY_TAB = 'system:ai'
export const aiDocumentTabId = (sessionId: string) => `ai:${sessionId}`
export const sessionIdFromAiTab = (tabId: string) => tabId.startsWith('ai:') ? tabId.slice(3) : null
export const isAiTab = (tabId: string) => tabId === AI_LOBBY_TAB || Boolean(sessionIdFromAiTab(tabId))

export function aiDocumentTab(tabId: string, title?: string): DocTab {
  return { id: tabId, kind: 'ai', target: sessionIdFromAiTab(tabId) ?? '', title: title?.trim() || '새 대화', icon: '✦' }
}
