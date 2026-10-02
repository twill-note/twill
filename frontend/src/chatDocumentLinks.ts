/** Preserve local document candidates for server validation, never for navigation. */
export function chatUrlTransform(url: string): string {
  if (/^(?:https?:|mailto:)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url)) return url
  if (/^[^:\n]+\.(?:md|erd\.json):\d+(?::\d+)?$/i.test(url)) return url
  if (/^twill:\/\/open\?/i.test(url) || /^[a-z]:[\\/]/i.test(url)) return url
  return ''
}

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

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
