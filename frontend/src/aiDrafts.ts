export type AiChatDraft = {
  prompt: string
  context: string
  includeDocument: boolean
  documentPath: string | null
  mentionedPaths: string[]
  attachments: Array<{ url: string; name: string; kind: 'image' | 'file' }>
}

// Only used when changing a question's project creates a new conversation.
// Ordinary tab switches keep their own mounted composer state.
const seeds = new Map<string, AiChatDraft>()
export const seedAiDraft = (id: string, draft: AiChatDraft) => seeds.set(id, draft)
export const initialAiDraft = (id: string | null | undefined) => id ? seeds.get(id) : undefined
export const clearAiDraft = (id: string | null | undefined) => { if (id) seeds.delete(id) }
