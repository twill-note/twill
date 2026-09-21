import type { WorkspaceScopeEntry } from './api'
import type { Section } from './types'

export const TASK_PROJECT_REQUIRED_MESSAGE =
  '여러 프로젝트가 등록된 워크스페이스에서는 실행할 프로젝트가 필요합니다. 태스크 카드에서 프로젝트를 지정한 뒤 다시 실행해주세요.'

export const TASK_PROJECT_INVALID_MESSAGE =
  '태스크 카드의 프로젝트를 확인할 수 없습니다. 태스크 카드에서 유효한 프로젝트를 지정한 뒤 다시 실행해주세요.'

export const TASK_PROJECT_CHANGED_MESSAGE =
  '카드의 프로젝트와 현재 세션에 고정된 프로젝트가 다릅니다. 진행 중인 실행의 권한은 변경되지 않습니다.'

export type TaskExecutionScopeResolution = {
  scopeId: string | null
  sectionId: string | null
  error: string | null
}

export type TaskSessionAction = 'start-new' | 'open-existing' | 'open-active' | 'start-changed-project'

function normalized(value: unknown): string | null {
  const result = typeof value === 'string' ? value.trim() : ''
  return result || null
}

function sectionForTaskPath(sections: Section[], taskPath?: string): Section | null {
  const normalizedPath = normalized(taskPath)?.replace(/^\/+|\/+$/g, '')
  if (!normalizedPath) return null
  const matches: Array<{ length: number; section: Section }> = []
  for (const section of sections) {
    for (const rawItem of section.items ?? []) {
      const item = rawItem.trim().replace(/^\/+|\/+$/g, '')
      if (item && (normalizedPath === item || normalizedPath.startsWith(`${item}/`))) {
        matches.push({ length: item.length, section })
      }
    }
  }
  if (matches.length === 0) return null
  const maxLength = Math.max(...matches.map((match) => match.length))
  const mostSpecific = matches.filter((match) => match.length === maxLength)
  return mostSpecific.length === 1 ? mostSpecific[0].section : null
}

/** 백엔드와 같은 우선순위로 카드의 실행 프로젝트를 미리 판정한다. */
export function resolveTaskExecutionScope(
  params: { scopeId?: string | null; sectionId?: string | null; taskPath?: string },
  sections: Section[],
  scopes: WorkspaceScopeEntry[],
): TaskExecutionScopeResolution {
  const scopeIds = [...new Set(scopes.map((scope) => normalized(scope.id)).filter((id): id is string => Boolean(id)))]
  const knownScopes = new Set(scopeIds)
  const bySection = new Map(sections.map((section) => [section.id, section]))
  const cardScopeId = normalized(params.scopeId)
  const cardSectionId = normalized(params.sectionId)
  let selectedSection = cardSectionId ? bySection.get(cardSectionId) ?? null : null

  if (cardScopeId) {
    if (!knownScopes.has(cardScopeId)) {
      return { scopeId: null, sectionId: null, error: TASK_PROJECT_INVALID_MESSAGE }
    }
    if (!selectedSection || normalized(selectedSection.scope_id) !== cardScopeId) {
      const matching = sections.filter((section) => normalized(section.scope_id) === cardScopeId)
      selectedSection = matching.length === 1 ? matching[0] : null
    }
    return { scopeId: cardScopeId, sectionId: selectedSection?.id ?? null, error: null }
  }

  if (cardSectionId && !selectedSection) {
    return { scopeId: null, sectionId: null, error: TASK_PROJECT_INVALID_MESSAGE }
  }
  selectedSection ??= sectionForTaskPath(sections, params.taskPath)
  if (selectedSection) {
    const sectionScopeId = normalized(selectedSection.scope_id)
    if (!sectionScopeId || !knownScopes.has(sectionScopeId)) {
      return { scopeId: null, sectionId: null, error: TASK_PROJECT_INVALID_MESSAGE }
    }
    return { scopeId: sectionScopeId, sectionId: selectedSection.id, error: null }
  }

  if (scopeIds.length > 1) {
    return { scopeId: null, sectionId: null, error: TASK_PROJECT_REQUIRED_MESSAGE }
  }
  if (scopeIds.length === 1) {
    const onlyScopeId = scopeIds[0]
    const matching = sections.filter((section) => normalized(section.scope_id) === onlyScopeId)
    return {
      scopeId: onlyScopeId,
      sectionId: matching.length === 1 ? matching[0].id : null,
      error: null,
    }
  }
  return { scopeId: null, sectionId: null, error: null }
}

export function taskScopeMismatch(sessionScopeId: string | null, cardScopeId: string | null): boolean {
  return normalized(sessionScopeId) !== normalized(cardScopeId)
}

/** 카드 팝업이 기존 세션을 열지, 새 실행을 만들지 결정하는 단일 정책. */
export function taskSessionAction(
  session: { busy: boolean; queued: boolean; scopeId: string | null } | null,
  cardScopeId: string | null,
  serverReportedMismatch = false,
): TaskSessionAction {
  if (!session) return 'start-new'
  if (session.busy || session.queued) return 'open-active'
  if (serverReportedMismatch || taskScopeMismatch(session.scopeId, cardScopeId)) {
    return 'start-changed-project'
  }
  return 'open-existing'
}
