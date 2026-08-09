const WIKI_LINK_RE = /\[\[([^[\]|\n]+)\]\]/g

type InlineContent = {
  type: string
  text?: string
  styles?: Record<string, unknown>
  props?: { target?: string }
  content?: InlineContent[]
}

type TableCell = {
  type: 'tableCell'
  content: InlineContent[]
  [key: string]: unknown
}

type TableContent = {
  type: 'tableContent'
  rows: Array<{ cells: Array<InlineContent[] | TableCell>; [key: string]: unknown }>
  [key: string]: unknown
}

function isTableContent(content: unknown): content is TableContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as { type?: string }).type === 'tableContent' &&
    Array.isArray((content as { rows?: unknown }).rows)
  )
}

function isTableCell(cell: InlineContent[] | TableCell): cell is TableCell {
  return !Array.isArray(cell) && cell.type === 'tableCell'
}

/**
 * Markdown 파서가 일반 텍스트로 읽은 `[[노트명]]`을 클릭 가능한 커스텀
 * 인라인 콘텐츠로 바꾼다. DB 뷰 마커는 별도 블록 변환 대상이므로 제외한다.
 */
export function parseWikiLinks(content: InlineContent[]): InlineContent[] {
  return content.flatMap((item) => {
    if (item.type !== 'text' || !item.text?.includes('[[')) return [item]

    const result: InlineContent[] = []
    let cursor = 0
    for (const match of item.text.matchAll(WIKI_LINK_RE)) {
      const raw = match[0]
      const target = match[1].trim()
      const index = match.index

      if (index > cursor) {
        result.push({ ...item, text: item.text.slice(cursor, index) })
      }
      if (target.toLocaleLowerCase().startsWith('db:')) {
        result.push({ ...item, text: raw })
      } else {
        result.push({ type: 'wikiLink', props: { target } })
      }
      cursor = index + raw.length
    }

    if (cursor === 0) return [item]
    if (cursor < item.text.length) {
      result.push({ ...item, text: item.text.slice(cursor) })
    }
    return result
  })
}

/** 저장할 때 커스텀 인라인 콘텐츠를 다시 순수 Markdown 위키 링크로 되돌린다. */
export function serializeWikiLinks(content: InlineContent[]): InlineContent[] {
  return content.map((item) => {
    if (item.type !== 'wikiLink') return item
    return {
      type: 'text',
      text: `[[${item.props?.target ?? ''}]]`,
      styles: {},
    }
  })
}

function mapTableContent(
  content: TableContent,
  mapInline: (inline: InlineContent[]) => InlineContent[],
): TableContent {
  return {
    ...content,
    rows: content.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) =>
        isTableCell(cell) ? { ...cell, content: mapInline(cell.content) } : mapInline(cell),
      ),
    })),
  }
}

/** 일반 블록과 표 셀 양쪽의 인라인 콘텐츠를 같은 방식으로 변환한다. */
export function mapWikiLinksInBlockContent(
  content: unknown,
  direction: 'parse' | 'serialize',
): unknown {
  const mapInline = direction === 'parse' ? parseWikiLinks : serializeWikiLinks
  if (Array.isArray(content)) return mapInline(content)
  if (isTableContent(content)) return mapTableContent(content, mapInline)
  return content
}
