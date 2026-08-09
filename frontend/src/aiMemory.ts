export type AiMemoryReviewState = {
  runId: string
  bullets: string[]
  selected?: boolean[]
}

/** 서버 후보는 기본적으로 모두 저장 대상으로 두되 사용자가 항목별로 제외할 수 있게 한다. */
export function createMemoryReview(runId: string, bullets: unknown[]): AiMemoryReviewState {
  const normalized = bullets.map(String)
  return {
    runId,
    bullets: normalized,
    selected: normalized.map(() => true),
  }
}

export function isMemoryReviewItemSelected(review: AiMemoryReviewState, index: number): boolean {
  // 선택 상태 필드가 생기기 전에 만들어진 런타임 객체도 안전하게 모두 선택된 것으로 취급한다.
  return review.selected?.[index] ?? true
}

export function selectedMemoryReviewBullets(review: AiMemoryReviewState): string[] {
  return review.bullets.filter(
    (bullet, index) => isMemoryReviewItemSelected(review, index) && bullet.trim().length > 0,
  )
}

/** 저장 배지는 그 학습을 만든 답변이 아직 마지막 실행일 때만 표시한다. */
export function isMemorySavedForRun(
  savedRunId: string | null,
  currentRunId: string | null,
  bullets: string[] | null,
): boolean {
  return Boolean(bullets?.length && savedRunId && currentRunId && savedRunId === currentRunId)
}
