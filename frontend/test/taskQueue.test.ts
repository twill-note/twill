import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canStartTask } from '../src/taskQueue.ts'

test('individual tasks start even with many active tasks in the same workspace', () => {
  const running = Array.from({ length: 10 }, (_, i) => ({ id: String(i), kind: 'task', busy: true, scopeId: 'same' }))
  assert.equal(canStartTask({ id: 'new' }, running), true)
})
test('explicit batch ordering waits only for its own unfinished predecessors', () => {
  const current = { id: 'second', batchId: 'batch', batchOrder: 2 }
  const first = { id: 'first', kind: 'task', batchId: 'batch', batchOrder: 1, cardStatus: 'running' }
  assert.equal(canStartTask(current, [first]), false)
  assert.equal(canStartTask(current, [{ ...first, cardStatus: 'verify' }]), true)
  assert.equal(canStartTask(current, [{ ...first, batchId: 'other' }]), true)
})
