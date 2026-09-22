import assert from 'node:assert/strict'
import test from 'node:test'
import { aiDocumentTab, aiDocumentTabId, isAiTab, sessionIdFromAiTab } from '../src/aiTabs.ts'

test('conversation identity is independent of its editable title', () => {
  const id = aiDocumentTabId('session-한글')
  const first = aiDocumentTab(id, '같은 제목')
  const renamed = aiDocumentTab(id, '수정한 제목')
  assert.equal(first.id, renamed.id)
  assert.equal(first.target, 'session-한글')
  assert.notEqual(first.id, aiDocumentTab(aiDocumentTabId('other'), '같은 제목').id)
})
test('only conversation tabs and the empty AI entry can be docked', () => {
  assert.equal(isAiTab('system:ai'), true)
  assert.equal(isAiTab('ai:session'), true)
  assert.equal(isAiTab('ai:'), false)
  assert.equal(isAiTab('file:ai.md'), false)
  assert.equal(sessionIdFromAiTab('system:ai'), null)
  assert.equal(aiDocumentTab('system:ai').title, '새 대화')
})
