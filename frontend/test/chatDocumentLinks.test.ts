import test from 'node:test'
import assert from 'node:assert/strict'
import { chatUrlTransform, remarkDocumentPaths } from '../src/chatDocumentLinks.ts'

test('preserves Windows and canonical document links but strips executable schemes', () => {
  for (const href of ['C:/문서/설계.md', 'twill://open?path=design.erd.json', '문서.md:12', 'https://example.com']) {
    assert.equal(chatUrlTransform(href), href)
  }
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/note.md']) assert.equal(chatUrlTransform(href), '')
})

test('links inline document paths without altering code blocks or nested links', () => {
  const tree = { type: 'root', children: [
    { type: 'inlineCode', value: '회의록/설계.erd.json' },
    { type: 'code', value: 'README.md' },
    { type: 'link', url: 'note.md', children: [{ type: 'inlineCode', value: 'note.md' }] },
    { type: 'inlineCode', value: 'src/app.ts' },
  ] }
  remarkDocumentPaths()(tree)
  assert.equal(tree.children[0].type, 'link')
  assert.equal(tree.children[1].type, 'code')
  assert.equal(tree.children[2].children?.[0].type, 'inlineCode')
  assert.equal(tree.children[3].type, 'inlineCode')
})
