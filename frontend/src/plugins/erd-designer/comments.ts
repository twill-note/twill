/**
 * 현재 ERD 스키마의 COMMENT 필드는 `note`다. 초기 프런트엔드에서 저장된
 * `comment`/`description` 필드도 읽을 때는 표시해 기존 다이어그램을 안전하게 연다.
 */
export type ErdCommentSource = {
  note?: unknown
  comment?: unknown
  description?: unknown
}

export function commentText(source: ErdCommentSource): string {
  // note 키가 있으면 빈 문자열도 사용자의 명시적인 삭제로 취급한다.
  if (Object.prototype.hasOwnProperty.call(source, 'note')) {
    return typeof source.note === 'string' ? source.note : ''
  }
  if (typeof source.comment === 'string') return source.comment
  if (typeof source.description === 'string') return source.description
  return ''
}
