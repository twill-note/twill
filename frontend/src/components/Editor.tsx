import { registerRestartGuard } from '../restartGuards'
import { exportDocumentPdf } from '../exportPdf'
import { markdownWithoutSnapshot, preserveBlocks, restoreBlocks } from '../blockPersistence'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@blocknote/core/fonts/inter.css'
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from '@blocknote/core'
import { en as defaultDictionary } from '@blocknote/core/locales'
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { codeBlockOptions } from '@blocknote/code-block'
import {
  getMultiColumnSlashMenuItems,
  locales as multiColumnLocales,
  multiColumnDropCursor,
  withMultiColumn,
} from '@blocknote/xl-multi-column'
import { createParser } from 'prosemirror-highlight/shiki'
import { api, ApiError } from '../api'
import { useAiStore } from '../aiStore'
import { useAppStore } from '../store'
import { isDarkTheme, useThemeStore } from '../theme'
import { dialog } from '../dialog'
import type { FileContent, Frontmatter, NoteLinks, NoteRow, TreeNode } from '../types'
import { propKeysOf, setNoteProp } from '../dbmodel'
import { dbApi, defaultStatusColumn, EMPTY_CONFIG, type ColumnDef, type DbConfig } from '../dbschema'
import { usePluginRegistry } from '../plugins/registry'
import { mapWikiLinksInBlockContent } from '../wikiLinks'
import { readEditorWidth, readSpellcheckEnabled, type EditorWidth } from '../editorPreferences'
import { DbBoard, DbTable } from './dbviews'
import EmojiPicker from './EmojiPicker'
import ImageAnnotator from './ImageAnnotator'
import MermaidBlockView from './MermaidBlock'
import SelectionToolbar from './SelectionToolbar'
import DocumentTaskDialog from './DocumentTaskDialog'
import SpellcheckToggleButton from './SpellcheckToggleButton'

/** 노션식 하위 노트(페이지) 블록 — 본문 안에서 일반 블록처럼 드래그로 이동 가능 */
function PageBlockView({ target }: { target: string }) {
  const openFile = useAppStore((s) => s.openFile)
  const open = async () => {
    try {
      const { path } = await api.resolveNote(target)
      if (path) openFile(path)
      else dialog.alert(`"${target}" 노트를 찾을 수 없습니다`)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }
  return (
    <button
      type="button"
      contentEditable={false}
      className="-mx-1 flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[#f1f1ef]"
      onClick={open}
    >
      <span className="text-[16px]">📄</span>
      <span className="border-b border-[#d3d1cb] text-[15px] font-medium text-[#37352f]">{target}</span>
    </button>
  )
}

const pageBlockSpec = createReactBlockSpec(
  {
    type: 'page',
    propSchema: { target: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block }) => <PageBlockView target={block.props.target} />,
    // 마크다운 직렬화 시 `[[이름]]` 한 줄짜리 문단으로 저장
    toExternalHTML: ({ block }) => <p>{`[[${block.props.target}]]`}</p>,
  },
)

/** 문장·목록·표 셀 안의 위키 링크 — Markdown에는 계속 `[[노트명]]`으로 저장한다. */
function WikiLinkInlineView({ target }: { target: string }) {
  const openFile = useAppStore((s) => s.openFile)
  const open = async () => {
    try {
      const { path } = await api.resolveNote(target)
      if (path) openFile(path)
      else dialog.alert(`"${target}" 노트를 찾을 수 없습니다`)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  return (
    <button
      type="button"
      contentEditable={false}
      className="inline-flex cursor-pointer items-baseline gap-0.5 rounded px-0.5 text-[inherit] font-medium text-[var(--bn-colors-editor-text)] underline decoration-[#d3d1cb] underline-offset-2 hover:bg-[var(--bn-colors-hovered-background)]"
      title={`${target} 문서 열기`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={open}
    >
      <span aria-hidden="true" className="text-[0.85em] no-underline">
        📄
      </span>
      <span>{target}</span>
    </button>
  )
}

const wikiLinkInlineSpec = createReactInlineContentSpec(
  {
    type: 'wikiLink',
    propSchema: { target: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent }) => <WikiLinkInlineView target={inlineContent.props.target} />,
    toExternalHTML: ({ inlineContent }) => <span>{`[[${inlineContent.props.target}]]`}</span>,
  },
)

/** 노션식 콜아웃 — 이모지 + 옅은 배경 상자. 마크다운으로는 `> [!이모지] 내용` 으로 저장. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CalloutView({ block, editor, contentRef }: any) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <div className="my-0.5 flex w-full items-start gap-2 rounded-md bg-[#f7f6f3] px-3 py-2.5">
      <div className="relative shrink-0" contentEditable={false}>
        <button
          className="rounded p-0.5 text-[18px] leading-none hover:bg-[#ececea]"
          title="이모지 변경"
          onClick={() => setPickerOpen(true)}
        >
          {block.props.emoji}
        </button>
        {pickerOpen && (
          <EmojiPicker
            onSelect={(emoji) => editor.updateBlock(block, { props: { emoji } })}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <div ref={contentRef} className="min-w-0 flex-1" />
    </div>
  )
}

const calloutBlockSpec = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: { emoji: { default: '💡' } },
    content: 'inline',
  },
  {
    render: ({ block, editor, contentRef }) => (
      <CalloutView block={block} editor={editor} contentRef={contentRef} />
    ),
  },
)

/** 트리에서 폴더 경로 수집 (노션식 하위 노트의 동반 폴더 포함) — 임베드 DB 뷰 소스 선택용 */
function collectDirs(nodes: TreeNode[], acc: string[] = []): string[] {
  nodes.forEach((n) => {
    if (n.type === 'dir') {
      acc.push(n.path)
      collectDirs(n.children ?? [], acc)
    } else if (n.children?.length) {
      acc.push(n.path.replace(/\.md$/, ''))
      collectDirs(n.children, acc)
    }
  })
  return acc
}

/** 본문 임베드 데이터베이스 뷰 — 폴더의 노트를 표/보드로 표시. `[[db:폴더|모드|그룹속성]]` 으로 저장.
 *  `source === '@self'` 이면 현재 편집 중인 노트의 companion 폴더로 자동 해석 (노션의 inline database).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DbViewBlock({ block, editor }: any) {
  const openFile = useAppStore((s) => s.openFile)
  const tree = useAppStore((s) => s.tree)
  const currentPath = useAppStore((s) => s.currentPath)
  const { source, mode, groupBy } = block.props as { source: string; mode: string; groupBy: string }
  const [rows, setRows] = useState<NoteRow[] | null>(null)
  const [config, setConfig] = useState<DbConfig>(EMPTY_CONFIG)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const setProps = (patch: Partial<{ source: string; mode: string; groupBy: string }>) =>
    editor.updateBlock(block, { props: { ...block.props, ...patch } })

  const isInline = source === '@self'
  const inlineDir = isInline && currentPath ? currentPath.replace(/\.md$/, '') : ''
  const effectiveSource = isInline ? inlineDir : source
  const dirArg = effectiveSource === '/' ? '' : effectiveSource

  useEffect(() => {
    if (!source) return
    // 인라인이면 부모 문서가 없거나 companion 경로가 아직 없으면 대기 (currentPath 로드까지)
    if (isInline && !inlineDir) return
    api
      .notesDb(dirArg)
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch(() => {
        // 인라인 companion 폴더가 아직 생성 전이면 조용히 빈 배열로 취급
        setRows([])
      })
    dbApi.getConfig(dirArg).then(setConfig).catch(() => {})
  }, [source, dirArg, isInline, inlineDir, tree, reloadKey])

  const propKeys = useMemo(() => propKeysOf(rows ?? []), [rows])
  const groupCandidates = useMemo(() => {
    const seen = new Set<string>()
    const list: { key: string; label: string }[] = []
    for (const c of config.columns) {
      if (c.type === 'select' || c.type === 'status') {
        list.push({ key: c.key, label: c.label ?? c.key })
        seen.add(c.key)
      }
    }
    for (const k of propKeys) if (!seen.has(k)) list.push({ key: k, label: k })
    return list
  }, [config.columns, propKeys])

  const moveCard = async (path: string, value: string) => {
    try {
      await setNoteProp(path, groupBy, value)
      setReloadKey((k) => k + 1)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const onCellChange = async (path: string, key: string, value: unknown) => {
    try {
      await setNoteProp(path, key, value)
      setReloadKey((k) => k + 1)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const persistConfig = async (next: DbConfig) => {
    setConfig(next)
    try {
      await dbApi.saveConfig(dirArg, next)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const onColumnChange = async (col: ColumnDef) => {
    const existing = config.columns.findIndex((c) => c.key === col.key)
    const columns =
      existing >= 0 ? config.columns.map((c) => (c.key === col.key ? col : c)) : [...config.columns, col]
    await persistConfig({ ...config, columns })
  }

  const onColumnDelete = async (key: string) => {
    await persistConfig({ ...config, columns: config.columns.filter((c) => c.key !== key) })
  }

  const onColumnAdd = async () => {
    const name = window.prompt('새 컬럼 이름 (frontmatter 키)')
    const key = (name ?? '').trim()
    if (!key) return
    if (config.columns.some((c) => c.key === key) || ['title', 'date', 'tags', 'icon', 'cover'].includes(key)) {
      dialog.alert('이미 존재하는 컬럼 이름입니다')
      return
    }
    await persistConfig({
      ...config,
      columns: [...config.columns, { key, label: null, type: 'text', options: [], visible: true }],
    })
  }

  const createRow = async (groupValue?: string) => {
    if (source === '/' || !source) {
      dialog.alert('먼저 데이터 소스를 선택하세요 (본문 임베드는 워크스페이스 루트에 새 노트를 만들 수 없습니다).')
      return
    }
    if (isInline && !inlineDir) {
      dialog.alert('현재 문서 정보를 확인할 수 없습니다. 문서를 저장한 뒤 다시 시도하세요.')
      return
    }
    try {
      // 인라인 DB 는 companion 폴더가 없을 수 있으니, 첫 행 생성 시 폴더가 자동 생성됨 (createEntry 가 parent.mkdir 수행)
      const initial: Record<string, unknown> = {}
      if (groupValue !== undefined && groupBy) initial[groupBy] = groupValue
      const path = await dbApi.createRow(dirArg, initial, config)
      setReloadKey((k) => k + 1)
      openFile(path)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  if (!source) {
    const dirs = collectDirs(tree)
    return (
      <div contentEditable={false} className="my-1 w-full rounded-lg border border-[#e9e9e7] p-3">
        <p className="mb-2 text-[13px] font-medium text-[#37352f]">📊 데이터 소스 선택</p>
        <div className="flex flex-wrap gap-1.5">
          {currentPath && (
            <button
              className="rounded-md border border-[#37352f] bg-[#37352f] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#2b2925]"
              onClick={() => setProps({ source: '@self' })}
              title="새 행이 이 페이지 하위 페이지로 저장됩니다"
            >
              📄 이 페이지 하위
            </button>
          )}
          <button
            className="rounded-md border border-[#e3e2e0] px-2.5 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
            onClick={() => setProps({ source: '/' })}
          >
            🗂️ 전체 노트
          </button>
          {dirs.map((d) => (
            <button
              key={d}
              className="rounded-md border border-[#e3e2e0] px-2.5 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={() => setProps({ source: d })}
            >
              📁 {d}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const sourceHint = isInline ? `이 페이지 하위: ${inlineDir || '…'}` : source === '/' ? '전체 노트' : source

  return (
    <div contentEditable={false} className="my-1 w-full rounded-lg border border-[#e9e9e7]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#efefed] px-2.5 py-1.5 text-[12px]">
        <span className="text-[14px]">📊</span>
        {config.kind === 'task_board' ? (
          <span className="px-1 py-0.5 text-[13px] font-semibold text-[#37352f]">태스크 보드</span>
        ) : (
          <input
            className="min-w-[80px] flex-none rounded px-1 py-0.5 text-[13px] font-semibold text-[#37352f] outline-none placeholder:text-[#c8c7c4] hover:bg-[#f7f7f5] focus:bg-white focus:ring-1 focus:ring-[#d3d1cb]"
            value={config.title}
            placeholder="제목 없는 데이터베이스"
            onChange={(e) => setConfig({ ...config, title: e.target.value })}
            onBlur={async () => {
              try {
                await dbApi.saveConfig(dirArg, config)
              } catch { /* 저장 실패 무시 */ }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        )}
        <button
          className="rounded px-1.5 py-0.5 text-[11px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          title={`데이터 소스: ${sourceHint} — 변경하려면 클릭`}
          onClick={() => setProps({ source: '' })}
        >
          {sourceHint}
        </button>
        <span className="text-[#9b9a97]">· {rows?.length ?? 0}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex rounded-md bg-[#ececea] p-0.5">
            {(['table', 'board'] as const).map((m) => (
              <button
                key={m}
                className={`rounded px-2 py-0.5 ${mode === m ? 'bg-white shadow-sm' : 'text-[#7d7c78] hover:text-[#37352f]'}`}
                onClick={async () => {
                  // 보드 진입 시 그룹 후보가 없으면 기본 status 컬럼을 자동 생성 → 즉시 그룹으로 세팅
                  if (m === 'board' && groupCandidates.length === 0 && !groupBy) {
                    const statusCol = defaultStatusColumn()
                    const nextCfg = { ...config, columns: [...config.columns, statusCol], boardGroupBy: statusCol.key }
                    setConfig(nextCfg)
                    try {
                      await dbApi.saveConfig(dirArg, nextCfg)
                    } catch (e) {
                      dialog.alert((e as Error).message)
                    }
                    setProps({ mode: m, groupBy: statusCol.key })
                    return
                  }
                  setProps({
                    mode: m,
                    groupBy: m === 'board' && !groupBy ? (groupCandidates[0]?.key ?? '') : groupBy,
                  })
                }}
              >
                {m === 'table' ? '표' : '보드'}
              </button>
            ))}
          </div>
          {mode === 'board' && (
            <select
              className="rounded-md border border-[#e3e2e0] px-1 py-0.5 text-[12px] text-[#5f5e5b] outline-none"
              value={groupBy}
              onChange={(e) => setProps({ groupBy: e.target.value })}
              title="그룹 기준 속성"
            >
              <option value="">그룹 속성…</option>
              {groupCandidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="max-h-96 overflow-auto p-2">
        {error ? (
          <p className="px-2 py-4 text-center text-[13px] text-red-500">{error}</p>
        ) : mode === 'board' ? (
          <DbBoard
            rows={rows ?? []}
            config={config}
            groupBy={groupBy}
            onOpen={openFile}
            onOpenDocument={openFile}
            onCellChange={onCellChange}
            onColumnChange={onColumnChange}
            onMove={moveCard}
            onCreateRow={createRow}
          />
        ) : (
          <DbTable
            rows={rows ?? []}
            config={config}
            onOpen={openFile}
            onOpenDocument={openFile}
            onCellChange={onCellChange}
            onColumnChange={onColumnChange}
            onColumnDelete={onColumnDelete}
            onColumnAdd={onColumnAdd}
            onCreateRow={createRow === undefined ? undefined : () => createRow()}
            compact
          />
        )}
      </div>
    </div>
  )
}

const dbViewBlockSpec = createReactBlockSpec(
  {
    type: 'dbview',
    propSchema: {
      source: { default: '' }, // '' = 미설정, '/' = 루트 전체, 그 외 폴더 경로
      mode: { default: 'table', values: ['table', 'board'] },
      groupBy: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <DbViewBlock block={block} editor={editor} />,
  },
)

// 기본 파서는 첫 로드 테마(github-dark)를 사용해 밝은 배경에서 대비가 무너짐 →
// 밝은 배경용 고대비 테마(VSCode Light+)를 로드하고 파서에 명시적으로 고정
const codeHighlightOptions = {
  ...codeBlockOptions,
  createHighlighter: async () => {
    const highlighter = await codeBlockOptions.createHighlighter!()
    const lightPlus = (await import('@shikijs/themes/light-plus')).default
    await highlighter.loadTheme(lightPlus)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any)[Symbol.for('blocknote.shikiParser')] = createParser(highlighter, {
      theme: 'light-plus',
    })
    return highlighter
  },
}

const mermaidBlockSpec = createReactBlockSpec(
  {
    type: 'mermaid',
    propSchema: { source: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <MermaidBlockView block={block} editor={editor} />,
  },
)

// NoteBodyEditor(태스크 팝업 설명 편집기) 등 다른 곳에서도 같은 블록 스키마를 재사용
export const schema = withMultiColumn(
  BlockNoteSchema.create().extend({
    blockSpecs: {
      page: pageBlockSpec(),
      callout: calloutBlockSpec(),
      dbview: dbViewBlockSpec(),
      mermaid: mermaidBlockSpec(),
      // 언어 셀렉트 + shiki 문법 하이라이팅
      codeBlock: createCodeBlockSpec(codeHighlightOptions),
    },
    inlineContentSpecs: {
      wikiLink: wikiLinkInlineSpec,
    },
  }),
)

const PAGE_LINK_RE = /^\[\[([^[\]|\n]+)\]\]$/
const DB_VIEW_RE = /^\[\[db:([^[\]|\n]*)(?:\|(table|board))?(?:\|([^[\]|\n]+))?\]\]$/ // `[[db:폴더|모드|그룹속성]]`
const CALLOUT_RE = /^\[!(\S+)\]\s?/ // 인용 블록 첫 텍스트의 `[!이모지] ` 마커
const TOGGLE_MARK = '[>] ' // 불릿 항목 첫 텍스트의 토글 마커

/** 파일에서 읽은 블록을 에디터 표현으로 변환:
 *  `[[이름]]` 문단 → 페이지, `> [!x]` 인용 → 콜아웃, `- [>] ` 불릿 → 토글 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromMarkdownBlocks(blocks: any[]): any[] {
  return blocks.map((b) => {
    const children = b.children?.length ? fromMarkdownBlocks(b.children) : b.children
    const first = Array.isArray(b.content) ? b.content[0] : undefined
    if (b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 1 && first?.type === 'text') {
      // `[[db:...]]`가 페이지 링크 패턴에도 걸리므로 DB 뷰 마커를 먼저 검사
      const dm = first.text.trim().match(DB_VIEW_RE)
      if (dm) {
        return {
          id: b.id,
          type: 'dbview',
          props: { source: dm[1], mode: dm[2] ?? 'table', groupBy: dm[3] ?? '' },
          children,
        }
      }
      const m = first.text.trim().match(PAGE_LINK_RE)
      if (m) return { id: b.id, type: 'page', props: { target: m[1].trim() }, children }
    }
    if (b.type === 'quote' && first?.type === 'text') {
      const m = first.text.match(CALLOUT_RE)
      if (m) {
        const rest = [{ ...first, text: first.text.replace(CALLOUT_RE, '') }, ...b.content.slice(1)]
        return {
          id: b.id,
          type: 'callout',
          props: { emoji: m[1] },
          content: mapWikiLinksInBlockContent(
            rest.filter((c: { type: string; text?: string }) => c.type !== 'text' || c.text !== ''),
            'parse',
          ),
          children,
        }
      }
    }
    if (b.type === 'bulletListItem' && first?.type === 'text' && first.text.startsWith(TOGGLE_MARK)) {
      return {
        ...b,
        type: 'toggleListItem',
        content: mapWikiLinksInBlockContent(
          [{ ...first, text: first.text.slice(TOGGLE_MARK.length) }, ...b.content.slice(1)],
          'parse',
        ),
        children,
      }
    }
    // ```mermaid``` 코드 블록 → mermaid 다이어그램 블록
    if (b.type === 'codeBlock' && (b.props?.language ?? '') === 'mermaid') {
      const raw = Array.isArray(b.content)
        ? b.content.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : '')).join('')
        : ''
      return { id: b.id, type: 'mermaid', props: { source: raw }, children }
    }
    return { ...b, content: mapWikiLinksInBlockContent(b.content, 'parse'), children }
  })
}

/** 저장 전 역변환: 콜아웃 → `[!x] ` 마커 인용, 토글 → `[>] ` 마커 불릿 (마크다운 왕복 보존) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toMarkdownBlocks(blocks: any[]): any[] {
  return blocks.map((b) => {
    const children = b.children?.length ? toMarkdownBlocks(b.children) : b.children
    if (b.type === 'dbview') {
      const { source, mode, groupBy } = b.props
      let marker = `[[db:${source}`
      if (mode !== 'table' || groupBy) marker += `|${mode}`
      if (groupBy) marker += `|${groupBy}`
      return {
        id: b.id,
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: marker + ']]', styles: {} }],
        children,
      }
    }
    if (b.type === 'callout') {
      return {
        id: b.id,
        type: 'quote',
        props: {},
        content: [
          { type: 'text', text: `[!${b.props.emoji}] `, styles: {} },
          ...(mapWikiLinksInBlockContent(b.content ?? [], 'serialize') as any[]),
        ],
        children,
      }
    }
    if (b.type === 'toggleListItem') {
      return {
        ...b,
        type: 'bulletListItem',
        content: [
          { type: 'text', text: TOGGLE_MARK, styles: {} },
          ...(mapWikiLinksInBlockContent(b.content ?? [], 'serialize') as any[]),
        ],
        children,
      }
    }
    if (b.type === 'mermaid') {
      const src = String(b.props?.source ?? '')
      return {
        id: b.id,
        type: 'codeBlock',
        props: { language: 'mermaid' },
        content: [{ type: 'text', text: src, styles: {} }],
        children,
      }
    }
    return { ...b, content: mapWikiLinksInBlockContent(b.content, 'serialize'), children }
  })
}

export default function Editor({ path }: { path?: string }) {
  const storeCurrentPath = useAppStore((s) => s.currentPath)
  const currentPath = path ?? storeCurrentPath
  const runLogPath = useAiStore((s) => s.runLogPath)
  const runLogVersion = useAiStore((s) => s.runLogVersion)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // 이 Editor 는 분할 패널마다 하나씩 유지된다. 탭을 전환하면 NoteEditor 는 새 문서를
  // 다시 그리므로, 패널 안에서 문서별 스크롤 위치를 따로 기억해 두었다가 복원한다.
  const scrollPositionsRef = useRef(new Map<string, number>())

  const rememberScrollPosition = useCallback((notePath: string, scrollTop: number) => {
    scrollPositionsRef.current.set(notePath, scrollTop)
  }, [])

  // 현재 열린 노트가 orchestrator 가 스트리밍 중인 run log 파일이면,
  // run 이벤트가 발생할 때마다 자동으로 최신 상태를 다시 불러옴.
  useEffect(() => {
    if (currentPath && runLogPath && currentPath === runLogPath) {
      setReloadKey((k) => k + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runLogVersion])

  useEffect(() => {
    if (!currentPath) return
    setContent(null)
    setError(null)
    const isExternal = currentPath.startsWith('/')
    const loader = isExternal ? api.getContentExternal(currentPath) : api.getContent(currentPath)
    loader.then(setContent).catch((e) => setError((e as Error).message))
  }, [currentPath, reloadKey])

  if (!currentPath) return null
  if (error)
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-500">
        파일을 열 수 없습니다: {error}
      </div>
    )
  if (!content)
    return <div className="flex h-full items-center justify-center text-sm text-[#9b9a97]">불러오는 중…</div>

  return (
    <NoteEditor
      key={`${content.path}:${reloadKey}`}
      content={content}
      onReload={() => setReloadKey((k) => k + 1)}
      initialScrollTop={scrollPositionsRef.current.get(content.path) ?? 0}
      onScrollPositionChange={(scrollTop) => rememberScrollPosition(content.path, scrollTop)}
    />
  )
}

function NoteEditor({
  content,
  onReload,
  initialScrollTop,
  onScrollPositionChange,
}: {
  content: FileContent
  onReload: () => void
  initialScrollTop: number
  onScrollPositionChange: (scrollTop: number) => void
}) {
  const isExternal = content.path.startsWith('/')
  // 다크 테마(노르드)일 때 BlockNote 도 다크로 — 나머지 테마는 라이트 유지
  const appTheme = useThemeStore((s) => s.theme)
  const editorTheme = isDarkTheme(appTheme) ? ('dark' as const) : ('light' as const)
  const { setSaveStatus, saveStatus, refreshTags, openFile, refreshTree, tree } = useAppStore()
  const [fm, setFm] = useState<Frontmatter>(content.frontmatter)
  const [tagInput, setTagInput] = useState('')
  const [links, setLinks] = useState<NoteLinks | null>(null)
  const [documentTaskOpen, setDocumentTaskOpen] = useState(false)
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const [editorWidth, setEditorWidth] = useState<EditorWidth>(
    () => readEditorWidth(localStorage.getItem('editor-width')),
  )

  const cycleWidth = () => {
    const order: EditorWidth[] = ['normal', 'wide', 'full']
    const next = order[(order.indexOf(editorWidth) + 1) % order.length]
    setEditorWidth(next)
    localStorage.setItem('editor-width', next)
  }

  // 브라우저 맞춤법 검사(오탈자 빨간 줄) 켜기/끄기 — 컨테이너 속성으로 상속시킴
  const [exportingPdf, setExportingPdf] = useState(false)
  const [spellcheck, setSpellcheck] = useState(() => readSpellcheckEnabled(localStorage.getItem('spellcheck')))
  const toggleSpellcheck = () => {
    setSpellcheck((prev) => {
      localStorage.setItem('spellcheck', prev ? 'off' : 'on')
      return !prev
    })
  }
  const mtimeRef = useRef<number | null>(content.mtime)
  const loadedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteChoicesRef = useRef<Promise<NoteRow[]> | null>(null)
  const fmRef = useRef(fm)
  fmRef.current = fm

  const editor = useCreateBlockNote({
    schema,
    uploadFile: api.uploadAsset,
    // 블록을 다른 블록의 좌·우 가장자리로 드래그하면 컬럼 리스트가 생성되도록 커스텀 drop cursor 를 활성화.
    dropCursor: multiColumnDropCursor,
    // xl-multi-column 의 slash 아이템은 editor.dictionary.multi_column 을 참조하므로 병합 필수.
    // 없으면 getMultiColumnDictionary() 가 throw 해서 슬래시 메뉴 전체가 안 뜬다.
    dictionary: { ...defaultDictionary, multi_column: multiColumnLocales.ko },
  })

  const loadLinks = useCallback(() => {
    // 외부 스코프 파일은 인덱싱 안 되므로 백링크 조회도 skip
    if (isExternal) {
      setLinks(null)
      return
    }
    api.backlinks(content.path).then(setLinks).catch(() => setLinks(null))
  }, [content.path, isExternal])

  useEffect(() => {
    loadLinks()
  }, [loadLinks])

  // 새 노트 생성·이동·삭제로 트리가 바뀌면 다음 `[[` 검색에서 목록을 새로 읽는다.
  useEffect(() => {
    noteChoicesRef.current = null
  }, [tree])

  // 파일 열기: 마크다운 → 블록 변환
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const snapshot = await restoreBlocks(content.body)
      const blocks = snapshot ?? fromMarkdownBlocks(await editor.tryParseMarkdownToBlocks(markdownWithoutSnapshot(content.body)))
      if (cancelled) return
      editor.replaceBlocks(editor.document, blocks as Parameters<typeof editor.replaceBlocks>[1])
      loadedRef.current = true
      // 블록 교체가 DOM 에 반영된 다음에 복원해야 긴 노트도 브라우저가 위치를 잘라내지 않는다.
      requestAnimationFrame(() => {
        if (!cancelled && contentScrollRef.current) contentScrollRef.current.scrollTop = initialScrollTop
      })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const save = useCallback(
    (force = false) => {
      const operation = saveChainRef.current.then(async () => {
        if (!loadedRef.current) return
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setSaveStatus('saving')
        try {
          const blocks = editor.document
          const markdown = await editor.blocksToMarkdownLossy(toMarkdownBlocks(blocks))
          const body = isExternal ? markdown : await preserveBlocks(markdown, blocks)
          const res = isExternal
            ? await api.saveContentExternal(content.path, fmRef.current, body, mtimeRef.current, force)
            : await api.saveContent(content.path, fmRef.current, body, mtimeRef.current, force)
          mtimeRef.current = res.mtime
          setSaveStatus('saved')
          if (!isExternal) {
            refreshTags()
            loadLinks()
          }
          return true
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) setSaveStatus('conflict')
          else setSaveStatus('error')
          return false
        }
      })
      saveChainRef.current = operation.then(() => {}, () => {})
      return operation
    },
    [editor, content.path, isExternal, setSaveStatus, refreshTags, loadLinks],
  )

  useEffect(() => registerRestartGuard(async () => {
    if (!loadedRef.current) return
    if (await save() === false) throw new Error('문서를 저장하지 못했습니다. 저장 오류를 해결한 뒤 앱을 완전히 종료하고 다시 실행해 주세요.')
  }), [save])

  const scheduleSave = useCallback(() => {
    if (!loadedRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => save(), 1000)
  }, [save])

  // Ctrl+S 즉시 저장
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // 노트 전환/언마운트 시 대기 중인 자동저장을 즉시 실행 (변경 유실 방지)
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        save()
      }
    },
    [save],
  )

  const updateFm = (patch: Partial<Frontmatter>) => {
    setFm((prev) => ({ ...prev, ...patch }))
    // fmRef는 렌더링 시 갱신되지만, 저장 타이머는 최신 값을 참조하도록 즉시 반영
    fmRef.current = { ...fmRef.current, ...patch }
    scheduleSave()
  }

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '')
    setTagInput('')
    if (t && !fm.tags.includes(t)) updateFm({ tags: [...fm.tags, t] })
  }

  // 노션처럼 /page 로 하위 노트 생성: 페이지 블록 삽입 → 부모 저장 → 새 노트로 이동
  const createSubNote = useCallback(async () => {
    const name = await dialog.prompt('하위 노트 이름', { confirmLabel: '만들기' })
    if (!name?.trim()) return
    try {
      const dir = content.path.replace(/\.md$/, '')
      const res = await api.createEntry(`${dir}/${name.trim()}`, 'file')
      const stem = res.path.split('/').pop()!.replace(/\.md$/, '')
      insertOrUpdateBlockForSlashMenu(editor, { type: 'page', props: { target: stem } })
      await save()
      await refreshTree()
      openFile(res.path)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }, [content.path, editor, save, refreshTree, openFile])

  // 본문의 [[링크]]/페이지 블록으로 이미 참조된 하위 노트는 중복 표시하지 않음.
  // 또한 이 노트가 인라인 DB 를 포함하고 있으면(=companion 폴더가 DB 폴더) 그 아래 노트들은
  // "하위 페이지" 로 보여주지 않는다 (DB 뷰 안에서만 표시).
  const outgoingLinks = (links?.outgoing ?? []).filter((o) => !o.target.startsWith('db:'))
  const linkedPaths = new Set(outgoingLinks.map((o) => o.path).filter(Boolean))
  const hasInlineDb = (links?.outgoing ?? []).some((o) => o.target.startsWith('db:'))
  const companionPrefix = content.path.replace(/\.md$/, '') + '/'
  const orphanChildren = (links?.children ?? []).filter((c) => {
    if (linkedPaths.has(c.path)) return false
    // 인라인 DB (또는 다른 dbview) 안의 행이면 제외
    if (hasInlineDb && c.path.startsWith(companionPrefix)) return false
    return true
  })

  const pluginSlashItems = usePluginRegistry((s) => s.slashItems)
  const getSlashMenuItems = useCallback(
    async (query: string) =>
      filterSuggestionItems(
        [
          {
            title: '하위 노트',
            subtext: '이 노트 아래에 새 노트를 만들고 링크를 넣습니다',
            aliases: ['page', 'subnote', 'sub', '하위', '하위노트', '페이지'],
            group: '노트',
            icon: <span className="text-[18px]">🗒️</span>,
            onItemClick: () => {
              createSubNote()
            },
          },
          {
            title: '콜아웃',
            subtext: '이모지와 배경으로 내용을 강조합니다',
            aliases: ['callout', 'note', 'info', '콜아웃', '강조'],
            group: '노트',
            icon: <span className="text-[18px]">💡</span>,
            onItemClick: () => {
              insertOrUpdateBlockForSlashMenu(editor, { type: 'callout' })
            },
          },
          {
            title: '데이터베이스',
            subtext: '표·보드로 여러 페이지를 관리합니다. 새 행은 이 페이지의 하위 페이지로 저장됩니다',
            aliases: ['db', 'database', 'table', 'board', '데이터베이스', '테이블', '보드'],
            group: '노트',
            icon: <span className="text-[18px]">📊</span>,
            onItemClick: () => {
              insertOrUpdateBlockForSlashMenu(editor, {
                type: 'dbview',
                props: { source: '@self', mode: 'table', groupBy: '' },
              })
            },
          },
          {
            title: '다이어그램 (Mermaid)',
            subtext: 'flowchart · sequence · gantt · state 등을 텍스트로 그리기',
            aliases: ['mermaid', 'diagram', '다이어그램', 'flowchart', '순서도', '시퀀스'],
            group: '노트',
            icon: <span className="text-[18px]">🧜‍♀️</span>,
            onItemClick: () => {
              insertOrUpdateBlockForSlashMenu(editor, {
                type: 'mermaid',
                props: {
                  source: 'graph TD\n  A[시작] --> B{조건}\n  B -->|예| C[동작]\n  B -->|아니오| D[종료]',
                },
              })
            },
          },
          ...pluginSlashItems.map((item) => ({
            title: item.title,
            subtext: item.subtext,
            aliases: item.aliases,
            group: '플러그인',
            icon: item.icon ? <span className="text-[18px]">{item.icon}</span> : undefined,
            onItemClick: () => item.onInvoke(),
          })),
          ...getDefaultReactSlashMenuItems(editor),
          // 좌우 컬럼 분할용 슬래시 아이템 ("Two Columns", "Three Columns")
          ...getMultiColumnSlashMenuItems(editor),
        ],
        query,
      ),
    [editor, createSubNote, pluginSlashItems],
  )

  const getWikiLinkItems = useCallback(
    async (query: string) => {
      if (content.path.startsWith('/')) return []
      if (!noteChoicesRef.current) {
        noteChoicesRef.current = api.notesDb('').catch(() => {
          noteChoicesRef.current = null
          return []
        })
      }
      const currentPath = content.path.toLocaleLowerCase()
      const normalizedQuery = query.trim().toLocaleLowerCase()
      const rows = (await noteChoicesRef.current)
        .filter((note) => note.path.toLocaleLowerCase() !== currentPath)
        .map((note) => {
          const stem = note.path.split('/').pop()?.replace(/\.md$/i, '') ?? note.title
          const title = note.title || stem
          const titleLower = title.toLocaleLowerCase()
          const stemLower = stem.toLocaleLowerCase()
          const pathLower = note.path.toLocaleLowerCase()
          const score = !normalizedQuery
            ? 0
            : titleLower.startsWith(normalizedQuery)
              ? 0
              : titleLower.includes(normalizedQuery)
                ? 1
                : stemLower.startsWith(normalizedQuery)
                  ? 2
                  : stemLower.includes(normalizedQuery)
                    ? 3
                    : pathLower.includes(normalizedQuery)
                      ? 4
                      : -1
          return { note, stem, title, score }
        })
        .filter((choice) => choice.score >= 0)
        .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, 'ko'))
        .slice(0, 30)

      return rows.map(({ note, stem, title }) => ({
        title,
        subtext: note.path,
        group: normalizedQuery ? `"${query.trim()}" 검색 결과` : '연결할 노트',
        icon: <span className="text-[16px]">{note.icon || '📄'}</span>,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: 'page', props: { target: stem } })
        },
      }))
    },
    [content.path, editor],
  )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-[#efefed] px-4 py-2">
        <button
          className="rounded px-1.5 py-0.5 text-[14px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          title="이전 노트"
          onClick={() => window.history.back()}
        >
          ←
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-[14px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          title="다음 노트"
          onClick={() => window.history.forward()}
        >
          →
        </button>
        <span className="flex-1 truncate text-[12px] text-[#9b9a97]">{content.path}</span>
        <SaveIndicator status={saveStatus} />
        <button type="button" disabled={exportingPdf} title="PDF로 내보내기"
          className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-[#9b9a97] hover:bg-[#f1f1ef] disabled:opacity-50"
          onClick={async () => {
            const element = editorWrapRef.current?.querySelector<HTMLElement>('.bn-editor')
            if (!element) return
            setExportingPdf(true)
            try { await exportDocumentPdf(element, fm.title || content.path.split('/').pop() || '문서') }
            catch (error) { await dialog.alert('PDF 내보내기 실패', { detail: (error as Error).message }) }
            finally { setExportingPdf(false) }
          }}>{exportingPdf ? 'PDF 생성 중…' : 'PDF ↓'}</button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f] disabled:cursor-not-allowed disabled:text-[#d3d1cb]"
          title="문서 작업 등록"
          aria-label="문서 작업 등록"
          onClick={() => setDocumentTaskOpen(true)}
          disabled={content.path.startsWith('/')}
        >
          🗒️
        </button>
        <SpellcheckToggleButton enabled={spellcheck} onToggle={toggleSpellcheck} />
        <button
          className="rounded px-1.5 py-0.5 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          title={`에디터 너비: ${WIDTH_LABEL[editorWidth]}`}
          onClick={cycleWidth}
        >
          ↔ {WIDTH_LABEL[editorWidth]}
        </button>
      </header>

      {saveStatus === 'conflict' && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-8 py-2 text-[13px] text-amber-800">
          ⚠️ 파일이 외부에서 수정되었습니다. 어떻게 할까요?
          <button className="rounded border border-amber-300 bg-white px-2 py-0.5 hover:bg-amber-100" onClick={onReload}>
            다시 불러오기
          </button>
          <button className="rounded border border-amber-300 bg-white px-2 py-0.5 hover:bg-amber-100" onClick={() => save(true)}>
            내 내용으로 덮어쓰기
          </button>
        </div>
      )}

      <div
        ref={contentScrollRef}
        className="flex-1 overflow-y-auto"
        spellCheck={spellcheck}
        onScroll={(event) => onScrollPositionChange(event.currentTarget.scrollTop)}
      >
        {!isExternal && fm.cover && <CoverBanner url={fm.cover} onChange={(cover) => updateFm({ cover })} />}
        <div
          className={`mx-auto pr-8 pb-32 pl-16 ${fm.cover ? 'pt-4' : 'pt-10'} ${WIDTH_CLASS[editorWidth]}`}
        >
          {!isExternal && <IconAndCoverControls fm={fm} updateFm={updateFm} />}
          {isExternal ? (
            <>
              <h1 className="text-[34px] font-bold text-[#37352f]">AGENTS.md</h1>
              <p className="mt-1 mb-6 text-[12px] text-[#9b9a97]">
                프로젝트에서 AI가 따라야 할 지침 · 원문 Markdown으로 저장
              </p>
            </>
          ) : (
            <>
              <input
                className="w-full border-none text-[34px] font-bold text-[#37352f] outline-none placeholder:text-[#d3d1cb]"
                value={fm.title}
                placeholder="제목 없음"
                onChange={(e) => updateFm({ title: e.target.value })}
              />

              <div className="mt-2 mb-6 flex flex-wrap items-center gap-2 text-[13px] text-[#787774]">
                <label className="flex items-center gap-1">
                  📅
                  <input
                    type="date"
                    className="rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-[#e3e2e0]"
                    value={fm.date ?? ''}
                    onChange={(e) => updateFm({ date: e.target.value || null })}
                  />
                </label>
                <span className="text-[#d3d1cb]">·</span>
                {fm.tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded-full bg-[#ececea] px-2 py-0.5 text-[12px]">
                    #{t}
                    <button
                      className="text-[#9b9a97] hover:text-red-500"
                      onClick={() => updateFm({ tags: fm.tags.filter((x) => x !== t) })}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="w-24 bg-transparent px-1 text-[12px] outline-none placeholder:text-[#c8c7c4]"
                  placeholder="+ 태그"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addTag()
                  }}
                  onBlur={addTag}
                />
              </div>
            </>
          )}

          <div ref={editorWrapRef} className="relative">
            <BlockNoteView editor={editor} theme={editorTheme} onChange={scheduleSave} slashMenu={false}>
              <SuggestionMenuController triggerCharacter="/" getItems={getSlashMenuItems} />
              <SuggestionMenuController
                triggerCharacter="[["
                getItems={getWikiLinkItems}
                shouldOpen={(transaction) => {
                  const { $from } = transaction.selection
                  return (
                    $from.parent.type.name === 'paragraph' &&
                    $from.parent.textContent === '[' &&
                    $from.parentOffset === 1
                  )
                }}
              />
            </BlockNoteView>
            <CodeCopyButton wrapperRef={editorWrapRef} />
            <ImageAnnotateButton wrapperRef={editorWrapRef} editor={editor} />
            <SelectionToolbar
              containerRef={editorWrapRef}
              notePath={content.path.startsWith('/') ? null : content.path}
              enabled={!content.path.startsWith('/')}
            />
          </div>

          {/* 본문에 페이지 블록으로 아직 없는 하위 노트 — 노션처럼 아이콘 행으로만 표시 (본문과 좌측 정렬) */}
          {orphanChildren.length > 0 && (
            <div className="mt-1">
              {orphanChildren.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  className="-mx-1 flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[#f1f1ef]"
                  onClick={() => openFile(n.path)}
                  title={n.path}
                >
                  <span className="text-[16px]">📄</span>
                  <span className="border-b border-[#d3d1cb] text-[15px] font-medium text-[#37352f]">{n.title}</span>
                </button>
              ))}
            </div>
          )}

          {links && (links.incoming.length > 0 || outgoingLinks.length > 0) && (
            <div className="mt-10 border-t border-[#efefed] pt-4">
              {outgoingLinks.length > 0 && (
                <div className="mb-3">
                  <p className="mb-1.5 text-[12px] font-medium text-[#9b9a97]">🔗 연결된 노트</p>
                  <div className="flex flex-wrap gap-1.5">
                    {outgoingLinks.map((l) => (
                      <button
                        key={l.target}
                        className={`rounded-full px-2.5 py-0.5 text-[12px] ${
                          l.path
                            ? 'bg-[#ececea] text-[#37352f] hover:bg-[#e0e0de]'
                            : 'cursor-default bg-[#f7f7f5] text-[#c8c7c4]'
                        }`}
                        onClick={() => l.path && openFile(l.path)}
                        title={l.path ?? '아직 없는 노트'}
                      >
                        [[{l.target}]]
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {links.incoming.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[12px] font-medium text-[#9b9a97]">↩️ 이 노트를 참조하는 노트 (백링크)</p>
                  {links.incoming.map((n) => (
                    <button
                      key={n.path}
                      className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
                      onClick={() => openFile(n.path)}
                      title={n.path}
                    >
                      📄 {n.title}
                      {n.date && <span className="ml-1.5 text-[11px] text-[#9b9a97]">{n.date}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {documentTaskOpen && (
        <DocumentTaskDialog documentPath={content.path} onClose={() => setDocumentTaskOpen(false)} />
      )}
    </div>
  )
}

const WIDTH_CLASS: Record<EditorWidth, string> = {
  normal: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: 'max-w-none',
}
const WIDTH_LABEL: Record<EditorWidth, string> = { normal: '보통', wide: '넓게', full: '전체' }

/** 노션식 커버 배너 — 호버 시 변경/제거 버튼 */
function CoverBanner({ url, onChange }: { url: string; onChange: (cover: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="group relative h-48 w-full">
      <img src={url} alt="" className="h-full w-full object-cover" />
      <div className="absolute right-4 bottom-3 hidden gap-1 group-hover:flex">
        <button
          className="rounded border border-[#e3e2e0] bg-white/90 px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-white"
          onClick={() => fileRef.current?.click()}
        >
          커버 변경
        </button>
        <button
          className="rounded border border-[#e3e2e0] bg-white/90 px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-white"
          onClick={() => onChange(null)}
        >
          제거
        </button>
      </div>
      <CoverFileInput inputRef={fileRef} onUploaded={onChange} />
    </div>
  )
}

function CoverFileInput({
  inputRef,
  onUploaded,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  onUploaded: (url: string) => void
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        try {
          onUploaded(await api.uploadAsset(file))
        } catch (err) {
          dialog.alert((err as Error).message)
        }
      }}
    />
  )
}

/** 제목 위 아이콘 표시 + (없을 때) 아이콘/커버 추가 버튼 — 노션 스타일 */
function IconAndCoverControls({
  fm,
  updateFm,
}: {
  fm: Frontmatter
  updateFm: (patch: Partial<Frontmatter>) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="group/head relative mb-1">
      {fm.icon ? (
        <button
          className="rounded p-1 text-[52px] leading-none hover:bg-[#f1f1ef]"
          title="아이콘 변경"
          onClick={() => setPickerOpen(true)}
        >
          {fm.icon}
        </button>
      ) : null}
      <div
        className={`flex gap-2 text-[12px] text-[#9b9a97] ${
          fm.icon && fm.cover ? 'hidden' : 'opacity-0 transition group-hover/head:opacity-100 focus-within:opacity-100'
        } ${fm.icon || fm.cover ? 'mt-1' : 'h-6 items-center'}`}
      >
        {!fm.icon && (
          <button className="rounded px-1.5 py-0.5 hover:bg-[#f1f1ef]" onClick={() => setPickerOpen(true)}>
            😀 아이콘 추가
          </button>
        )}
        {!fm.cover && (
          <button className="rounded px-1.5 py-0.5 hover:bg-[#f1f1ef]" onClick={() => fileRef.current?.click()}>
            🖼️ 커버 추가
          </button>
        )}
      </div>
      {pickerOpen && (
        <EmojiPicker
          onSelect={(icon) => updateFm({ icon })}
          onRemove={fm.icon ? () => updateFm({ icon: null }) : undefined}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <CoverFileInput inputRef={fileRef} onUploaded={(cover) => updateFm({ cover })} />
    </div>
  )
}

/** 노션처럼 코드 블록 호버 시 우상단에 나타나는 복사 버튼 */
function CodeCopyButton({ wrapperRef }: { wrapperRef: React.RefObject<HTMLDivElement | null> }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const codeElRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-code-copy]')) return // 버튼 자신 위에서는 유지
      const block = target.closest?.('[data-content-type="codeBlock"]') as HTMLElement | null
      if (block) {
        const wRect = wrapper.getBoundingClientRect()
        const rect = block.getBoundingClientRect()
        codeElRef.current = block.querySelector('code')
        setPos({ top: rect.top - wRect.top + 6, right: wRect.right - rect.right + 8 })
      } else {
        setPos(null)
        setCopied(false)
      }
    }
    wrapper.addEventListener('mouseover', onOver)
    return () => wrapper.removeEventListener('mouseover', onOver)
  }, [wrapperRef])

  if (!pos) return null
  return (
    <button
      type="button"
      data-code-copy
      className="absolute z-10 rounded border border-[#e3e2e0] bg-white px-2 py-0.5 text-[11px] text-[#5f5e5b] shadow-sm hover:bg-[#f1f1ef]"
      style={{ top: pos.top, right: pos.right }}
      onClick={async () => {
        const text = codeElRef.current?.innerText ?? ''
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          dialog.alert('클립보드 복사에 실패했습니다')
        }
      }}
    >
      {copied ? '복사됨 ✓' : '복사'}
    </button>
  )
}

/** 이미지 블록에 호버 시 우상단에 "주석" 버튼 노출 → 캔버스 편집기 오픈 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ImageAnnotateButton({ wrapperRef, editor }: { wrapperRef: React.RefObject<HTMLDivElement | null>; editor: any }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [target, setTarget] = useState<{ blockId: string; url: string } | null>(null)
  const [modal, setModal] = useState<{ url: string; blockId: string } | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-image-annotate]')) return
      const block = t.closest?.('[data-content-type="image"]') as HTMLElement | null
      if (!block) {
        setPos(null)
        setTarget(null)
        return
      }
      const imgEl = block.querySelector('img') as HTMLImageElement | null
      if (!imgEl || !imgEl.src) return
      // data-content-type은 BlockNote의 콘텐츠 노드이고 실제 블록 id는 상위 wrapper에 있다.
      // 빈 id로 updateBlock을 호출하면 "블록을 찾을 수 없음" 오류가 발생한다.
      const blockContainer = block.closest('[data-id]') as HTMLElement | null
      const blockId = blockContainer?.getAttribute('data-id') ?? ''
      if (!blockId) {
        setPos(null)
        setTarget(null)
        return
      }
      const wRect = wrapper.getBoundingClientRect()
      const rect = imgEl.getBoundingClientRect()
      setPos({ top: rect.top - wRect.top + 6, left: rect.right - wRect.left - 64 })
      setTarget({ blockId, url: imgEl.src })
    }
    wrapper.addEventListener('mouseover', onOver)
    return () => wrapper.removeEventListener('mouseover', onOver)
  }, [wrapperRef])

  const handleSave = (newUrl: string) => {
    if (!modal) return
    try {
      editor.updateBlock(modal.blockId, { props: { url: newUrl } })
      setModal(null)
    } catch (e) {
      void dialog.alert('블록 갱신 실패: ' + (e as Error).message)
    }
  }

  return (
    <>
      {pos && target && (
        <button
          type="button"
          data-image-annotate
          className="absolute z-10 rounded border border-[#e3e2e0] bg-white/95 px-2 py-0.5 text-[11px] text-[#5f5e5b] shadow-sm hover:bg-[#f1f1ef]"
          style={{ top: pos.top, left: pos.left }}
          onClick={() => setModal({ url: target.url, blockId: target.blockId })}
          title="사각형/화살표/텍스트로 주석 추가"
        >
          ✏️ 주석
        </button>
      )}
      {modal && (
        <ImageAnnotator
          imageUrl={modal.url}
          onSave={handleSave}
          onClose={() => setModal(null)}
        />
      )}
    </>
  )
}

function SaveIndicator({ status }: { status: string }) {
  const map: Record<string, { text: string; cls: string }> = {
    saving: { text: '저장 중…', cls: 'text-[#9b9a97]' },
    saved: { text: '저장됨 ✓', cls: 'text-green-600' },
    conflict: { text: '충돌 발생', cls: 'text-amber-600' },
    error: { text: '저장 실패', cls: 'text-red-500' },
    idle: { text: '', cls: '' },
  }
  const { text, cls } = map[status] ?? map.idle
  return <span className={`shrink-0 text-[12px] ${cls}`}>{text}</span>
}
