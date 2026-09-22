import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preserveBlocks, restoreBlocks, markdownWithoutSnapshot } from '../src/blockPersistence.ts'

const blocks = [{ id: 'columns', type: 'columnList', children: [
  { id: 'left', type: 'column', props: { width: 2 }, children: [{ id: 'image', type: 'image', props: { url: '/assets/한글.png', previewWidth: 240 } }] },
  { id: 'right', type: 'column', props: { width: 1 }, children: [{ type: 'paragraph', content: '한글 설명' }] },
] }]
test('nested columns, image dimensions and Korean text survive reopening', async () => {
  const body = await preserveBlocks('![이미지](/assets/한글.png)\n\n한글 설명\n', blocks)
  assert.deepEqual(await restoreBlocks(body), blocks)
  assert.equal(markdownWithoutSnapshot(body), '![이미지](/assets/한글.png)\n\n한글 설명')
})
test('external text changes invalidate a stale layout snapshot', async () => {
  const body = await preserveBlocks('원문', blocks)
  assert.equal(await restoreBlocks(body.replace('원문', 'AI가 수정한 본문')), null)
})
test('plain Markdown and damaged snapshots do not prevent opening a document', async () => {
  assert.equal(await restoreBlocks('# 제목'), null)
  assert.equal(await restoreBlocks('본문\n<!-- twill:blocks:v1:abcd -->'), null)
})
