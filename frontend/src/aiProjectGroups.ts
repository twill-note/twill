import type { AiSession } from './aiStore'
import type { Section } from './types'

/** A session belongs to one project; old or unassigned sessions stay under Root. */
export function sessionProjectId(session: Pick<AiSession, 'sectionId' | 'scopeId'>, sections: Pick<Section, 'id' | 'scope_id'>[]): string | null {
  if (session.sectionId) return sections.find((section) => section.id === session.sectionId)?.id ?? null
  if (session.scopeId) return sections.find((section) => section.scope_id === session.scopeId)?.id ?? null
  return null
}

export type ProjectSession = Pick<AiSession, 'id' | 'title' | 'sectionId' | 'scopeId' | 'busy' | 'queued'>

/** Keep the file tree independent of token streams and tool output. */
export function createProjectSessionSelector() {
  let previous: ProjectSession[] = []
  return (state: { sessions: AiSession[] }): ProjectSession[] => {
    const next = state.sessions.map(({ id, title, sectionId, scopeId, busy, queued }) => ({ id, title, sectionId, scopeId, busy, queued }))
    if (next.length === previous.length && next.every((item, index) => {
      const old = previous[index]
      return item.id === old.id && item.title === old.title && item.sectionId === old.sectionId && item.scopeId === old.scopeId && item.busy === old.busy && item.queued === old.queued
    })) return previous
    previous = next
    return next
  }
}
