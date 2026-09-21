import assert from 'node:assert/strict'
import test from 'node:test'

import { APP_BUILD_INFO, formatBuildTime } from '../src/buildInfo.ts'

test('빌드 정보는 테스트 환경에서도 안전한 기본값을 제공한다', () => {
  assert.equal(APP_BUILD_INFO.version, '0.0.0-dev')
  assert.equal(formatBuildTime(APP_BUILD_INFO.builtAt), '개발 빌드')
})

test('주입된 ISO 빌드 시각을 사용자 표시 문자열로 변환한다', () => {
  const label = formatBuildTime('2026-09-04T12:34:00.000Z')
  assert.match(label, /2026/)
  assert.match(label, /09/)
  assert.match(label, /04/)
  assert.notEqual(label, '개발 빌드')
})
