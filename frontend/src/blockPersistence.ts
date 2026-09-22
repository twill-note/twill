/** Markdown stays readable; a versioned snapshot preserves layout Markdown cannot represent.
 * A digest ties the snapshot to the text so external edits always take precedence.
 */
const SNAPSHOT = /\n<!-- twill:blocks:v1:([A-Za-z0-9+/=]+) -->\s*$/

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function markdownWithoutSnapshot(body: string): string {
  return body.replace(SNAPSHOT, '')
}

export async function preserveBlocks(markdown: string, blocks: readonly unknown[]): Promise<string> {
  const text = markdownWithoutSnapshot(markdown).trimEnd()
  const needsLayout = (block: unknown): boolean => {
    if (!block || typeof block !== 'object') return false
    const value = block as { type?: string; children?: unknown[] }
    return ['columnList', 'column', 'image'].includes(value.type ?? '') || Boolean(value.children?.some(needsLayout))
  }
  if (!blocks.some(needsLayout)) return text + '\n'
  const json = JSON.stringify({ digest: await digest(text), blocks })
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${text}\n<!-- twill:blocks:v1:${btoa(binary)} -->\n`
}

export async function restoreBlocks(body: string): Promise<unknown[] | null> {
  const match = body.match(SNAPSHOT)
  if (!match) return null
  try {
    const snapshot = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0))))
    const validBlock = (block: unknown): boolean => {
      if (!block || typeof block !== 'object') return false
      const b = block as { type?: unknown; children?: unknown }
      return typeof b.type === 'string' && (b.children === undefined || (Array.isArray(b.children) && b.children.every(validBlock)))
    }
    if (!Array.isArray(snapshot.blocks) || !snapshot.blocks.length || !snapshot.blocks.every(validBlock)) return null
    if (snapshot.digest !== await digest(markdownWithoutSnapshot(body).trimEnd())) return null
    return snapshot.blocks
  } catch { return null }
}
