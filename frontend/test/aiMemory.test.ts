import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isMemorySavedForRun } from '../src/aiMemory.ts'

test('메모리 저장 표시는 저장을 만든 실행에서만 노출한다', () => {
  assert.equal(isMemorySavedForRun('run-1', 'run-1', ['도메인 지식']), true)
  assert.equal(isMemorySavedForRun('run-1', 'run-2', ['도메인 지식']), false)
  assert.equal(isMemorySavedForRun('run-1', 'run-1', []), false)
})

test('설정과 채팅 패널에서 메모리 후보 선택·자동 학습 UI를 노출하지 않는다', async () => {
  const [settings, panel] = await Promise.all([
    readFile(new URL('../src/components/WorkspaceSettingsDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ByeoriPanel.tsx', import.meta.url), 'utf8'),
  ])

  assert.equal(settings.includes('채팅 질문 메모리 학습'), false)
  assert.equal(settings.includes('learn_from_chat'), false)
  assert.equal(panel.includes('메모리 후보 검토'), false)
  assert.equal(panel.includes('선택한 ${selectedMemoryBullets.length}개 저장'), false)
})
