import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { en as defaultDictionary } from '@blocknote/core/locales'
import { BlockNoteView } from '@blocknote/mantine'
import { useCreateBlockNote } from '@blocknote/react'
import { locales as multiColumnLocales } from '@blocknote/xl-multi-column'
import {
  api,
  type SkillBookContent,
  type SkillBookDetail,
  type SkillBookSummary,
} from '../api'
import { dialog } from '../dialog'
import type { DbConfig } from '../dbschema'
import { useAppStore } from '../store'
import { isDarkTheme, useThemeStore } from '../theme'
import type { NoteRow } from '../types'
import { DbTable } from './dbviews'
import { fromMarkdownBlocks, schema, toMarkdownBlocks } from './Editor'
import { tr } from '../i18n'


const SKILLBOOK_CONFIG: DbConfig = {
  title: '스킬북',
  kind: 'skillbook',
  columns: [
    {
      key: 'category',
      label: '구분',
      type: 'select',
      options: [
        { value: 'app_skill', label: '스킬', color: 'blue' },
        { value: 'system_manual', label: '시스템 매뉴얼', color: 'gray' },
      ],
      visible: true,
    },
    {
      key: 'description',
      label: '간단 설명',
      type: 'text',
      options: [],
      visible: true,
    },
  ],
  primarySort: { key: 'title', dir: 'asc' },
  defaultView: 'table',
  boardGroupBy: null,
}


export default function SkillBookView() {
  const closeBoardView = useAppStore((state) => state.closeBoardView)
  const [storagePath, setStoragePath] = useState('')
  useEffect(() => {
    fetch('/api/skillbook/storage').then(async (response) => {
      if (response.ok) setStoragePath((await response.json()).path)
    }).catch(() => {})
  }, [])
  const [entries, setEntries] = useState<SkillBookSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.skillbook
      .list()
      .then((items) => {
        if (cancelled) return
        setEntries(items)
        setError(null)
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase('ko')
    if (!query) return entries
    return entries.filter((entry) =>
      [entry.name, entry.description, entry.id].join(' ').toLocaleLowerCase('ko').includes(query),
    )
  }, [entries, filter])

  const rows = useMemo<NoteRow[]>(
    () =>
      visible.map((entry) => ({
        path: entry.id,
        title: entry.name,
        date: null,
        tags: [],
        icon: entry.valid ? (entry.read_only ? '🔒' : '📘') : '⚠️',
        props: {
          category: entry.source,
          description: entry.description,
        },
        updated_at: 0,
      })),
    [visible],
  )

  const createSkill = async () => {
    const name = window.prompt('스킬 이름 (소문자-하이픈)')
    if (!name?.trim()) return
    const description = window.prompt('스킬을 언제 사용하는지 간단히 설명하세요')
    if (!description?.trim()) return
    try {
      const detail = await api.skillbook.create(name.trim(), description.trim())
      setReloadKey((value) => value + 1)
      setSelectedId(detail.summary.id)
    } catch (reason) {
      await dialog.alert((reason as Error).message)
    }
  }

  if (selectedId) {
    return (
      <SkillBookDetailView
        key={selectedId}
        entryId={selectedId}
        onBack={() => {
          setSelectedId(null)
          setReloadKey((value) => value + 1)
        }}
        onEntryIdChange={setSelectedId}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-[#efefed] px-6 py-3">
        <span className="text-[18px]">📚</span>
        <h1 className="text-[15px] font-semibold text-[#37352f]">{tr("스킬북")}</h1>
        <span className="text-[12px] text-[#9b9a97]">· {visible.length}</span>
        <input
          className="ml-3 w-64 rounded-md border border-[#e3e2e0] px-2.5 py-1 text-[13px] outline-none placeholder:text-[#c8c7c4] focus:border-blue-400"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tr("스킬 제목·설명 검색…")}
        />
        <button
          className="ml-2 rounded-md bg-[#37352f] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#2b2925]"
          onClick={() => void createSkill()}
        >

          {tr("+ 새 스킬")}
        </button>
        <button
          className="ml-auto rounded px-2 py-1 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
          onClick={closeBoardView}
        >

          {tr("✕ 닫기")}
        </button>
      </header>

      {error ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-red-500">{error}</div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-[#9b9a97]">{tr("불러오는 중…")}</div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-4">
          <DbTable
            rows={rows}
            config={SKILLBOOK_CONFIG}
            onOpen={setSelectedId}
            onCellChange={() => {}}
            showDate={false}
            showTags={false}
            readOnly
            emptyLabel={tr("등록된 스킬이 없습니다")}
          />
          <p className="mt-3 text-[11px] text-[#9b9a97]">

            {tr("🔒 시스템 매뉴얼은 수정할 수 없습니다. 스킬은 앱 설치 폴더 밖에 보존됩니다.")}
            {storagePath && <span className="mt-1 block break-all">{tr("저장 위치:")} {storagePath}</span>}
          </p>
        </div>
      )}
    </div>
  )
}


function SkillBookDetailView({
  entryId,
  onBack,
  onEntryIdChange,
}: {
  entryId: string
  onBack: () => void
  onEntryIdChange: (id: string) => void
}) {
  const [detail, setDetail] = useState<SkillBookDetail | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<SkillBookContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    const next = await api.skillbook.detail(entryId)
    setDetail(next)
    setSelectedPath((current) => current ?? next.summary.entry_file)
  }, [entryId])

  useEffect(() => {
    setLoading(true)
    loadDetail()
      .then(() => setError(null))
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setLoading(false))
  }, [loadDetail])

  useEffect(() => {
    if (!selectedPath) return
    let cancelled = false
    setLoading(true)
    api.skillbook
      .content(entryId, selectedPath)
      .then((next) => {
        if (!cancelled) {
          setContent(next)
          setError(null)
        }
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [entryId, selectedPath])

  const remove = async () => {
    if (!detail || detail.summary.read_only) return
    const confirmed = await dialog.confirm(`'${detail.summary.name}' 스킬을 삭제할까요?`, {
      detail: '스킬은 skillbook/.trash로 이동하므로 필요하면 복구할 수 있습니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!confirmed) return
    try {
      await api.skillbook.remove(detail.summary.id)
      onBack()
    } catch (reason) {
      await dialog.alert((reason as Error).message)
    }
  }

  const handleSaved = (next: SkillBookContent) => {
    setContent(next)
    if (next.detail) setDetail(next.detail)
    if (next.id !== entryId) onEntryIdChange(next.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[#efefed] px-5 py-2.5">
        <button
          className="rounded px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
          onClick={onBack}
        >

          {tr("← 목록")}
        </button>
        <span className="text-[16px]">{detail?.summary.read_only ? '🔒' : '📘'}</span>
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold text-[#37352f]">{detail?.summary.name ?? entryId}</h1>
          <p className="truncate text-[11px] text-[#9b9a97]">{detail?.summary.description}</p>
        </div>
        {detail && !detail.summary.read_only && (
          <button
            className="ml-auto rounded px-2 py-1 text-[11px] text-red-500 hover:bg-red-50"
            onClick={() => void remove()}
          >

            {tr("스킬 삭제")}
          </button>
        )}
      </header>

      {detail?.validation_errors.length ? (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-800">
          {detail.validation_errors.join(' · ')}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-auto border-r border-[#efefed] bg-[#fbfbfa] p-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[#9b9a97]">{tr("구성요소")}</p>
          {detail?.components.map((component) => {
            const active = component.path === selectedPath
            const depth = component.path.split('/').length - 1
            const icon =
              component.kind === 'directory'
                ? '📁'
                : component.kind === 'markdown'
                  ? '📝'
                  : component.kind === 'image'
                    ? '🖼️'
                    : component.kind === 'text'
                      ? '📄'
                      : '📦'
            return (
              <button
                key={component.path}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] ${
                  active ? 'bg-[#ececea] text-[#37352f]' : 'text-[#5f5e5b] hover:bg-[#f1f1ef]'
                } ${component.kind === 'directory' ? 'cursor-default font-medium' : ''}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                disabled={component.kind === 'directory'}
                onClick={() => setSelectedPath(component.path)}
                title={component.path}
              >
                <span>{icon}</span>
                <span className="truncate">{component.path.split('/').at(-1)}</span>
                {!component.editable && component.kind !== 'directory' ? (
                  <span className="ml-auto text-[9px] text-[#b4b3af]">{tr("조회")}</span>
                ) : null}
              </button>
            )
          })}
        </aside>

        <section className="min-w-0 flex-1 overflow-auto">
          {error ? (
            <div className="flex h-full items-center justify-center text-[13px] text-red-500">{error}</div>
          ) : loading || !content ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[#9b9a97]">{tr("불러오는 중…")}</div>
          ) : (
            <SkillBookContentEditor
              key={`${content.id}:${content.path}:${content.mtime}`}
              entry={detail}
              value={content}
              onSaved={handleSaved}
            />
          )}
        </section>
      </div>
    </div>
  )
}


function SkillBookContentEditor({
  entry,
  value,
  onSaved,
}: {
  entry: SkillBookDetail | null
  value: SkillBookContent
  onSaved: (next: SkillBookContent) => void
}) {
  if (value.kind === 'markdown') {
    return <SkillBookMarkdownEditor entry={entry} value={value} onSaved={onSaved} />
  }
  if (value.kind === 'text') {
    return <SkillBookTextEditor value={value} onSaved={onSaved} />
  }
  if (value.kind === 'image') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
        <img
          className="max-h-[75vh] max-w-full rounded border border-[#efefed] object-contain"
          src={api.skillbook.assetUrl(value.id, value.path)}
          alt={value.path}
        />
        {value.editable && <ReplaceAssetButton value={value} onSaved={onSaved} />}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[#9b9a97]">
      <span className="text-3xl">📦</span>
      <p className="text-[13px]">{tr("이 구성요소는 편집기에서 미리 볼 수 없습니다.")}</p>
      <a
        className="text-[12px] text-blue-600 underline"
        href={api.skillbook.assetUrl(value.id, value.path)}
        target="_blank"
        rel="noreferrer"
      >

        {tr("파일 열기")}
      </a>
      {value.editable && <ReplaceAssetButton value={value} onSaved={onSaved} />}
    </div>
  )
}


function ReplaceAssetButton({
  value,
  onSaved,
}: {
  value: SkillBookContent
  onSaved: (next: SkillBookContent) => void
}) {
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const replace = async (file: File) => {
    setSaving(true)
    try {
      const next = await api.skillbook.replaceAsset(value.id, value.path, file, value.mtime)
      onSaved(next)
    } catch (reason) {
      await dialog.alert((reason as Error).message)
    } finally {
      setSaving(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void replace(file)
        }}
      />
      <button
        className="rounded border border-[#e3e2e0] bg-white px-3 py-1 text-[11px] text-[#5f5e5b] hover:bg-[#f7f7f5] disabled:opacity-40"
        disabled={saving}
        onClick={() => inputRef.current?.click()}
      >
        {saving ? tr("교체 중…") : tr("파일 교체")}
      </button>
    </>
  )
}


function SkillBookMarkdownEditor({
  entry,
  value,
  onSaved,
}: {
  entry: SkillBookDetail | null
  value: SkillBookContent
  onSaved: (next: SkillBookContent) => void
}) {
  const appTheme = useThemeStore((state) => state.theme)
  const loadedRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<Record<string, unknown>>(value.frontmatter)
  const [metadataJson, setMetadataJson] = useState(JSON.stringify(value.frontmatter, null, 2))
  const isSkillEntry = entry?.summary.source === 'app_skill' && value.path === 'SKILL.md'

  const editor = useCreateBlockNote({
    schema,
    dictionary: { ...defaultDictionary, multi_column: multiColumnLocales.ko },
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(value.content ?? '')
      if (cancelled) return
      editor.replaceBlocks(editor.document, fromMarkdownBlocks(blocks))
      loadedRef.current = true
    })()
    return () => {
      cancelled = true
    }
    // value마다 부모 key로 새 인스턴스가 만들어진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    if (!loadedRef.current || value.read_only) return
    setSaving(true)
    setError(null)
    try {
      const nextMetadata = isSkillEntry ? metadata : JSON.parse(metadataJson)
      const body = await editor.blocksToMarkdownLossy(toMarkdownBlocks(editor.document))
      const next = await api.skillbook.saveContent(value.id, value.path, body, nextMetadata, value.mtime)
      setDirty(false)
      onSaved(next)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const changeSkillMetadata = (key: 'name' | 'description', next: string) => {
    setMetadata((current) => ({ ...current, [key]: next }))
    setDirty(true)
  }

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-8 py-6">
      <div className="mb-4 flex items-center gap-2">
        <code className="text-[11px] text-[#9b9a97]">{value.path}</code>
        {value.read_only ? (
          <span className="rounded bg-[#ececea] px-1.5 py-0.5 text-[10px] text-[#787774]">{tr("읽기 전용")}</span>
        ) : (
          <button
            className="ml-auto rounded-md bg-[#37352f] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? tr("저장 중…") : tr("저장")}
          </button>
        )}
      </div>

      {isSkillEntry && (
        <div className="mb-5 grid gap-3 rounded-lg border border-[#e9e9e7] bg-[#fbfbfa] p-4">
          <label className="grid gap-1 text-[11px] font-medium text-[#787774]">

            {tr("스킬 이름")}
            <input
              className="rounded border border-[#e3e2e0] bg-white px-2.5 py-1.5 font-mono text-[12px] text-[#37352f] outline-none focus:border-blue-400"
              value={String(metadata.name ?? '')}
              onChange={(event) => changeSkillMetadata('name', event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-[#787774]">

            {tr("간단 설명")}
            <textarea
              className="min-h-16 resize-y rounded border border-[#e3e2e0] bg-white px-2.5 py-1.5 text-[12px] text-[#37352f] outline-none focus:border-blue-400"
              value={String(metadata.description ?? '')}
              onChange={(event) => changeSkillMetadata('description', event.target.value)}
            />
          </label>
        </div>
      )}

      {!isSkillEntry && Object.keys(value.frontmatter).length > 0 && !value.read_only ? (
        <details className="mb-4 rounded border border-[#e9e9e7] bg-[#fbfbfa] px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-[#787774]">{tr("Frontmatter 편집")}</summary>
          <textarea
            className="mt-2 min-h-32 w-full resize-y rounded border border-[#e3e2e0] bg-white p-2 font-mono text-[11px] outline-none"
            value={metadataJson}
            onChange={(event) => {
              setMetadataJson(event.target.value)
              setDirty(true)
            }}
          />
        </details>
      ) : null}

      {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-[11px] text-red-600">{error}</div>}
      <div className="skillbook-markdown min-h-[420px] flex-1">
        <BlockNoteView
          editor={editor}
          theme={isDarkTheme(appTheme) ? 'dark' : 'light'}
          editable={!value.read_only}
          onChange={() => {
            if (loadedRef.current) setDirty(true)
          }}
        />
      </div>
    </div>
  )
}


function SkillBookTextEditor({
  value,
  onSaved,
}: {
  value: SkillBookContent
  onSaved: (next: SkillBookContent) => void
}) {
  const [text, setText] = useState(value.content ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = text !== (value.content ?? '')

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.skillbook.saveContent(value.id, value.path, text, value.frontmatter, value.mtime)
      onSaved(next)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-[480px] flex-col p-6">
      <div className="mb-3 flex items-center gap-2">
        <code className="text-[11px] text-[#9b9a97]">{value.path}</code>
        {value.read_only ? (
          <span className="rounded bg-[#ececea] px-1.5 py-0.5 text-[10px] text-[#787774]">{tr("읽기 전용")}</span>
        ) : (
          <button
            className="ml-auto rounded-md bg-[#37352f] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? tr("저장 중…") : tr("저장")}
          </button>
        )}
      </div>
      {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-[11px] text-red-600">{error}</div>}
      <textarea
        className="min-h-0 flex-1 resize-none rounded-md border border-[#e3e2e0] bg-[#fbfbfa] p-4 font-mono text-[12px] leading-6 text-[#37352f] outline-none focus:border-blue-400"
        value={text}
        readOnly={value.read_only}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  )
}
