import test from 'node:test'
import assert from 'node:assert/strict'
import { createStreamBatcher } from '../src/streamBatcher.ts'

test('coalesces output while preserving lifecycle boundaries and item order', () => {
  const seen: { type: string; text?: unknown }[] = []
  const batch = createStreamBatcher(event => seen.push(event))
  batch.push({ type: 'tool_output_delta', itemId: 'one', text: 'a' })
  batch.push({ type: 'tool_output_delta', itemId: 'one', text: 'b' })
  assert.equal(seen.length, 0)
  batch.push({ type: 'tool_output_delta', itemId: 'two', text: 'c' })
  batch.push({ type: 'done' })
  assert.deepEqual(seen.map(x => [x.type, x.text]), [['tool_output_delta', 'ab'], ['tool_output_delta', 'c'], ['done', undefined]])
  batch.flush()
  assert.equal(seen.length, 3)
})
