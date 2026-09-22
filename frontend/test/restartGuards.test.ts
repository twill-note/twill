import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareForRestart, registerRestartGuard } from '../src/restartGuards.ts'

test('restart waits for every editor save and removes unmounted editors', async () => {
  const saved: string[] = []
  const first = registerRestartGuard(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); saved.push('first') })
  const second = registerRestartGuard(() => { saved.push('second') })
  try { await prepareForRestart(); assert.deepEqual(saved, ['first', 'second']) }
  finally { first(); second() }
  await prepareForRestart()
  assert.equal(saved.length, 2)
})
test('failed saves prevent restart', async () => {
  const remove = registerRestartGuard(() => { throw new Error('save failed') })
  try { await assert.rejects(prepareForRestart, /save failed/) }
  finally { remove() }
})
