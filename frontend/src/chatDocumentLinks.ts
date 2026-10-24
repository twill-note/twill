/** Preserve local document candidates for server validation, never for navigation. */
export function chatUrlTransform(url: string): string {
  if (/^(?:https?:|mailto:)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url)) return url
  if (/^[^:\n]+\.(?:md|erd\.json):\d+(?::\d+)?$/i.test(url)) return url
  if (/^twill:\/\/open\?/i.test(url) || /^[a-z]:[\\/]/i.test(url)) return url
  return ''
}

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

const mentionStart = (text: string, at: number) => at === 0 || /\s/.test(text[at - 1])
const mentionEnd = (text: string, end: number) => end === text.length || /[\s,!?;:。！？]/.test(text[end])

export function hasDocumentMention(text: string, path: string): boolean {
  const token = `@${path}`
  let at = text.indexOf(token)
  while (at !== -1) {
    if (mentionStart(text, at) && mentionEnd(text, at + token.length)) return true
    at = text.indexOf(token, at + 1)
  }
  return false
}

/** Single spaces belong to filenames; two consecutive spaces end the current query. */
export function documentMentionQuery(text: string, caret: number, selectedPaths: readonly string[]): string | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0 || !mentionStart(upto, at)) return null
  const query = upto.slice(at + 1)
  if (/[\r\n\t]| {2}/.test(query)) return null
  if (selectedPaths.some(path => query.startsWith(path) && query.length > path.length && mentionEnd(query, path.length))) return null
  return query
}

/** Link known @ references, including spaces, without interpreting arbitrary prose as a path. */
export function remarkDocumentMentions(options: { paths: readonly string[] }) {
  const paths = [...new Set(options.paths)].sort((a, b) => b.length - a.length)
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return
      node.children = node.children?.flatMap(child => {
        if (child.type !== 'text' || !child.value?.includes('@')) { visit(child); return [child] }
        const value = child.value
        const parts: MarkdownNode[] = []
        let start = 0
        for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
          if (!mentionStart(value, at)) continue
          const path = paths.find(path => value.startsWith(path, at + 1) && mentionEnd(value, at + path.length + 1))
          if (!path) continue
          if (at > start) parts.push({ type: 'text', value: value.slice(start, at) })
          parts.push({ type: 'link', url: `twill://open?path=${encodeURIComponent(path)}`, children: [{ type: 'text', value: `@${path}` }] })
          start = at + path.length + 1
          at = start - 1
        }
        if (start < value.length) parts.push({ type: 'text', value: value.slice(start) })
        return parts
      })
    }
    visit(tree)
  }
}

/** Only inline code containing a complete document path becomes a link candidate.
 * Fenced code, ordinary prose and existing link labels retain their meaning. */
export function remarkDocumentPaths() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'link' || node.type === 'linkReference') return
      node.children = node.children?.map(child => {
        const value = child.value?.trim() || ''
        if (child.type === 'inlineCode' && /^(?!https?:|file:)[^\n`]+\.(?:md|erd\.json)(?::\d+(?::\d+)?)?$/i.test(value)) {
          return { type: 'link', url: value, children: [{ type: 'text', value }] }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}
