/** 저장 결과는 명시적 기억 요청을 처리한 실행에서만 표시한다. */
export function isMemorySavedForRun(
  savedRunId: string | null,
  currentRunId: string | null,
  bullets: string[] | null,
): boolean {
  return Boolean(bullets?.length && savedRunId && currentRunId && savedRunId === currentRunId)
}
