import { api } from './api'
import type { NoteRow } from './types'

/** 데이터베이스 뷰(전체 페이지/본문 임베드) 공용 데이터 헬퍼 */

export type DbMode = 'table' | 'board'

export function propKeysOf(rows: NoteRow[]): string[] {
  const keys = new Set<string>()
  rows.forEach((r) => Object.keys(r.props).forEach((k) => keys.add(k)))
  return [...keys].sort()
}

export function cellValue(row: NoteRow, key: string): string | number {
  switch (key) {
    case 'title':
      return row.title
    case 'date':
      return row.date ?? ''
    case 'tags':
      return row.tags.join(', ')
    case 'updated_at':
      return row.updated_at
    default: {
      const v = row.props[key]
      if (v == null) return ''
      if (typeof v === 'number') return v
      return Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
}

/** 노트의 frontmatter 임의 속성 하나를 변경해 저장. 빈 문자열·빈 배열·null 은 속성 자체를 제거. */
export async function setNoteProp(path: string, key: string, value: unknown): Promise<void> {
  const c = await api.getContent(path)
  const extra = { ...(c.frontmatter.extra ?? {}) }
  const isEmpty =
    value == null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  if (isEmpty) delete extra[key]
  else extra[key] = value as never
  await api.saveContent(c.path, { ...c.frontmatter, extra }, c.body, c.mtime)
}
