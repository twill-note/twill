import type { AiSession } from './aiStore'
import type { Section } from './types'

/** A session belongs to one project; old or unassigned sessions stay under Root. */
export function sessionProjectId(session: Pick<AiSession, 'sectionId' | 'scopeId'>, sections: Pick<Section, 'id' | 'scope_id'>[]): string | null {
  if (session.sectionId) return sections.find((section) => section.id === session.sectionId)?.id ?? null
  if (session.scopeId) return sections.find((section) => section.scope_id === session.scopeId)?.id ?? null
  return null
}
