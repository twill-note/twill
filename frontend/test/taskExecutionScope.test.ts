import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkspaceScopeEntry } from '../src/api.ts'
import {
  TASK_PROJECT_INVALID_MESSAGE,
  TASK_PROJECT_REQUIRED_MESSAGE,
  resolveTaskExecutionScope,
  taskSessionAction,
} from '../src/taskExecutionScope.ts'
import type { Section } from '../src/types.ts'

const sections: Section[] = [
  { id: 'section-a', name: '프로젝트 A', expanded: true, items: ['a'], scope_id: 'scope-a' },
  { id: 'section-b', name: '프로젝트 B', expanded: true, items: ['b'], scope_id: 'scope-b' },
]

const scopes: WorkspaceScopeEntry[] = [
  { id: 'scope-a', label: '프로젝트 A', path: '/project/a', has_path: true, project: '', note_path: '' },
  { id: 'scope-b', label: '프로젝트 B', path: '/project/b', has_path: true, project: '', note_path: '' },
]

test('다중 프로젝트에서 프로젝트와 섹션이 없는 카드는 실행을 차단한다', () => {
  const result = resolveTaskExecutionScope({ taskPath: 'tasks/무스코프.md' }, sections, scopes)

  assert.equal(result.scopeId, null)
  assert.equal(result.error, TASK_PROJECT_REQUIRED_MESSAGE)
  assert.match(result.error ?? '', /태스크 카드에서 프로젝트를 지정/)
})

test('단일 프로젝트 워크스페이스는 기존 자동 선택을 유지한다', () => {
  const result = resolveTaskExecutionScope(
    { taskPath: 'tasks/자동 선택.md' },
    [sections[0]],
    [scopes[0]],
  )

  assert.deepEqual(result, { scopeId: 'scope-a', sectionId: 'section-a', error: null })
})

test('존재하지 않는 카드 프로젝트는 노트 전용 실행으로 대체하지 않는다', () => {
  const result = resolveTaskExecutionScope(
    { taskPath: 'tasks/잘못된 프로젝트.md', scopeId: 'missing-scope' },
    sections,
    scopes,
  )

  assert.equal(result.error, TASK_PROJECT_INVALID_MESSAGE)
})

test('카드 프로젝트를 바꾸면 남아 있는 이전 section_id를 새 프로젝트 섹션으로 맞춘다', () => {
  const result = resolveTaskExecutionScope(
    { taskPath: 'tasks/프로젝트 변경.md', scopeId: 'scope-b', sectionId: 'section-a' },
    sections,
    scopes,
  )

  assert.deepEqual(result, { scopeId: 'scope-b', sectionId: 'section-b', error: null })
})

test('완료된 세션과 카드 프로젝트가 다르면 기존 세션 대신 명시적 새 실행을 선택한다', () => {
  const idleSession = { busy: false, queued: false, scopeId: 'scope-a' }

  assert.equal(taskSessionAction(idleSession, 'scope-b'), 'start-changed-project')
  assert.equal(taskSessionAction(idleSession, 'scope-a'), 'open-existing')
})

test('진행 중인 세션은 카드 편집으로 교체하지 않고 현재 실행을 연다', () => {
  const runningSession = { busy: true, queued: false, scopeId: 'scope-a' }

  assert.equal(taskSessionAction(runningSession, 'scope-b', true), 'open-active')
})
