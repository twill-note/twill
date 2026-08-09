import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWikiLinksInBlockContent, parseWikiLinks, serializeWikiLinks } from '../src/wikiLinks.ts'

test('문장과 번호 목록 안의 위키 링크를 인라인 링크로 바꾼다', () => {
  const parsed = parseWikiLinks([
    {
      type: 'text',
      text: '먼저 [[캐리오버 후보 조회와 호환성 검증]]에서 조건을 점검한다.',
      styles: {},
    },
  ])

  assert.deepEqual(parsed, [
    { type: 'text', text: '먼저 ', styles: {} },
    { type: 'wikiLink', props: { target: '캐리오버 후보 조회와 호환성 검증' } },
    { type: 'text', text: '에서 조건을 점검한다.', styles: {} },
  ])
})

test('표 셀 안의 위키 링크도 변환하고 Markdown으로 왕복한다', () => {
  const table = {
    type: 'tableContent',
    columnWidths: [200, 300],
    rows: [
      {
        cells: [
          [{ type: 'text', text: '[[캐리오버 기능과 전체 처리 흐름]]', styles: {} }],
          [{ type: 'text', text: '전체 구조', styles: {} }],
        ],
      },
    ],
  }

  const parsed = mapWikiLinksInBlockContent(table, 'parse') as typeof table
  assert.deepEqual(parsed.rows[0].cells[0], [
    { type: 'wikiLink', props: { target: '캐리오버 기능과 전체 처리 흐름' } },
  ])

  const serialized = mapWikiLinksInBlockContent(parsed, 'serialize') as typeof table
  assert.deepEqual(serialized.rows[0].cells[0], [
    { type: 'text', text: '[[캐리오버 기능과 전체 처리 흐름]]', styles: {} },
  ])
})

test('DB 뷰 마커는 인라인 노트 링크로 바꾸지 않는다', () => {
  const content = [{ type: 'text', text: '[[db:캐리오버|board]]', styles: {} }]
  assert.deepEqual(parseWikiLinks(content), content)
})

test('커스텀 인라인 링크를 순수 Markdown 문법으로 직렬화한다', () => {
  assert.deepEqual(serializeWikiLinks([{ type: 'wikiLink', props: { target: '관련 문서' } }]), [
    { type: 'text', text: '[[관련 문서]]', styles: {} },
  ])
})
