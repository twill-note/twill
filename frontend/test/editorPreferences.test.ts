import assert from 'node:assert/strict'
import test from 'node:test'
import { readEditorWidth, readSpellcheckEnabled } from '../src/editorPreferences.ts'

test('저장된 에디터 너비가 없거나 올바르지 않으면 전체 너비를 사용한다', () => {
  assert.equal(readEditorWidth(null), 'full')
  assert.equal(readEditorWidth('unknown'), 'full')
})

test('사용자가 저장한 에디터 너비는 그대로 유지한다', () => {
  assert.equal(readEditorWidth('normal'), 'normal')
  assert.equal(readEditorWidth('wide'), 'wide')
  assert.equal(readEditorWidth('full'), 'full')
})

test('오탈자 검사는 사용자가 켠 값을 저장한 경우에만 활성화한다', () => {
  assert.equal(readSpellcheckEnabled(null), false)
  assert.equal(readSpellcheckEnabled('off'), false)
  assert.equal(readSpellcheckEnabled('on'), true)
})
