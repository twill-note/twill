import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryReview,
  isMemorySavedForRun,
  selectedMemoryReviewBullets,
} from '../src/aiMemory.ts'

test('메모리 후보는 처음에 모두 선택하고 원하는 항목만 저장 대상으로 남긴다', () => {
  const review = createMemoryReview('run-1', ['첫 항목', '둘째 항목', '셋째 항목'])

  assert.deepEqual(review.selected, [true, true, true])
  review.selected = [false, true, false]
  assert.deepEqual(selectedMemoryReviewBullets(review), ['둘째 항목'])
})

test('선택한 후보라도 빈 문구는 저장 대상에서 제외한다', () => {
  const review = createMemoryReview('run-1', ['유효한 항목', '   '])

  assert.deepEqual(selectedMemoryReviewBullets(review), ['유효한 항목'])
})

test('메모리 저장 표시는 저장을 만든 실행에서만 노출한다', () => {
  assert.equal(isMemorySavedForRun('run-1', 'run-1', ['도메인 지식']), true)
  assert.equal(isMemorySavedForRun('run-1', 'run-2', ['도메인 지식']), false)
  assert.equal(isMemorySavedForRun('run-1', 'run-1', []), false)
})
