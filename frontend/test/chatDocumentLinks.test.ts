import test from 'node:test'
import assert from 'node:assert/strict'
import { chatUrlTransform, documentMentionQuery, hasDocumentMention, remarkDocumentMentions, remarkDocumentPaths } from '../src/chatDocumentLinks.ts'

test('preserves Windows and canonical document links but strips executable schemes', () => {
  for (const href of ['C:/문서/설계.md', 'twill://open?path=design.erd.json', '문서.md:12', 'https://example.com']) {
    assert.equal(chatUrlTransform(href), href)
  }
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/note.md']) assert.equal(chatUrlTransform(href), '')
})

test('mention completion keeps filename spaces and ends after a selected reference', () => {
  const query = (value: string, paths: string[] = []) => documentMentionQuery(value, value.length, paths)
  assert.equal(query('검토 @회의 자료/설계 문서'), '회의 자료/설계 문서')
  assert.equal(query('@설계 문서.md 다음 질문', ['설계 문서.md']), null)
  assert.equal(query('@설계 문서.md @회의 자료', ['설계 문서.md']), '회의 자료')
  assert.equal(query('user@example.com'), null)
  assert.equal(query('@문서\n새 문장'), null)
  assert.equal(hasDocumentMention('읽어줘 @설계 문서.md 확인', '설계 문서.md'), true)
  assert.equal(hasDocumentMention('@설계 문서.md.backup', '설계 문서.md'), false)
  assert.equal(hasDocumentMention('user@설계 문서.md', '설계 문서.md'), false)
})

test('user mentions become links with full spaced paths and retain non-reference text', () => {
  const tree = { type: 'root', children: [
    { type: 'text', value: '확인 @회의 자료/설계 문서.md 그리고 @회의.md 다음' },
    { type: 'text', value: ' @회의.md.backup user@회의.md @없는.md' },
    { type: 'code', value: '@회의.md' },
    { type: 'inlineCode', value: '@회의.md' },
    { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: '@회의.md' }] },
  ] }
  remarkDocumentMentions({ paths: ['회의.md', '회의 자료/설계 문서.md'] })(tree)
  assert.deepEqual(tree.children.slice(0, 5), [
    { type: 'text', value: '확인 ' },
    { type: 'link', url: 'twill://open?path=' + encodeURIComponent('회의 자료/설계 문서.md'), children: [{ type: 'text', value: '@회의 자료/설계 문서.md' }] },
    { type: 'text', value: ' 그리고 ' },
    { type: 'link', url: 'twill://open?path=' + encodeURIComponent('회의.md'), children: [{ type: 'text', value: '@회의.md' }] },
    { type: 'text', value: ' 다음' },
  ])
  assert.equal(tree.children[5].value, ' @회의.md.backup user@회의.md @없는.md')
  assert.equal(tree.children[6].type, 'code')
  assert.equal(tree.children[7].type, 'inlineCode')
  assert.equal(tree.children[8].children?.[0].type, 'text')
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
