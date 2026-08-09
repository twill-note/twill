import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { dbApi } from '../dbschema'
import { useAppStore } from '../store'
import type { Section } from '../types'

type TemplateId = 'review' | 'improve' | 'custom'

type DocumentTaskTemplate = {
  id: TemplateId
  label: string
  description: string
  title: (documentTitle: string) => string
  prompt: string
}

const TEMPLATES: DocumentTaskTemplate[] = [
  {
    id: 'review',
    label: '문서 검토',
    description: '오탈자와 함께 모호한 표현, 누락, 구조 개선점을 점검합니다.',
    title: (documentTitle) => `${documentTitle} 문서 검토`,
    prompt:
      '원본 문서를 전체적으로 검토해줘. 오탈자·맞춤법뿐 아니라 모호하거나 오해하기 쉬운 표현, 빠진 정보, 독자가 이해하기 어려운 구조를 찾아 근거와 개선안을 정리해줘.',
  },
  {
    id: 'improve',
    label: '개선 작업 정리',
    description: '문서에서 발견한 개선 사항을 실행 가능한 작업으로 정리합니다.',
    title: (documentTitle) => `${documentTitle} 개선 작업 정리`,
    prompt:
      '원본 문서를 읽고 품질·명확성·구조 측면의 개선 작업을 정리해줘. 각 작업은 우선순위와 기대 효과를 포함하고, 바로 실행할 수 있도록 구체적으로 작성해줘.',
  },
  {
    id: 'custom',
    label: '직접 입력',
    description: '제목과 요청 내용을 처음부터 직접 작성합니다.',
    title: (documentTitle) => `${documentTitle} 문서 작업`,
    prompt: '',
  },
]

function documentTitle(path: string): string {
  return path.split('/').at(-1)?.replace(/\.md$/i, '') || '문서'
}

function belongsToSection(path: string, section: Section): boolean {
  return section.items.some((rawItem) => {
    const item = rawItem.replace(/^\/+|\/+$/g, '')
    if (!item) return false
    if (path === item || path.startsWith(`${item}/`)) return true
    // `상위.md`의 companion 폴더에 든 문서도 그 상위 노트가 속한 섹션으로 해석한다.
    const companion = item.replace(/\.md$/i, '')
    return companion !== item && path.startsWith(`${companion}/`)
  })
}

/** 중첩된 섹션이 있다면 더 긴 경로를 가진 섹션을 우선해 예기치 않은 상위 섹션 상속을 막는다. */
function sectionForDocument(path: string, sections: Section[]): Section | null {
  return (
    sections
      .filter((section) => belongsToSection(path, section))
      .sort(
        (a, b) =>
          Math.max(...b.items.map((item) => item.length), 0) - Math.max(...a.items.map((item) => item.length), 0),
      )[0] ?? null
  )
}

function taskBody(documentPath: string, prompt: string): string {
  return [
    '## 원본 문서',
    '',
    `- 문서: [[${documentPath}]]`,
    `- 경로: \`${documentPath}\``,
    '',
    '원본 문서를 직접 열어 확인한 뒤 아래 요청을 수행한다.',
    '',
    '## 요청',
    '',
    prompt.trim(),
  ].join('\n')
}

export default function DocumentTaskDialog({ documentPath, onClose }: { documentPath: string; onClose: () => void }) {
  const sections = useAppStore((state) => state.sections)
  const refreshTree = useAppStore((state) => state.refreshTree)
  const openFile = useAppStore((state) => state.openFile)
  const [templateId, setTemplateId] = useState<TemplateId>('review')
  const [title, setTitle] = useState(() => TEMPLATES[0].title(documentTitle(documentPath)))
  const [prompt, setPrompt] = useState(TEMPLATES[0].prompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const section = useMemo(() => sectionForDocument(documentPath, sections), [documentPath, sections])

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const selectTemplate = (nextId: TemplateId) => {
    const next = TEMPLATES.find((template) => template.id === nextId) ?? TEMPLATES[0]
    setTemplateId(next.id)
    setTitle(next.title(documentTitle(documentPath)))
    setPrompt(next.prompt)
    setError(null)
  }

  const createTask = async () => {
    const normalizedTitle = title.trim()
    const normalizedPrompt = prompt.trim()
    if (!normalizedTitle || !normalizedPrompt || busy) {
      setError('태스크 제목과 요청 내용을 모두 입력하세요.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      // 이 호출은 없는 워크스페이스에서도 task_board 스키마를 보장하며, 기존 보드 설정은 보존한다.
      await dbApi.ensureTaskBoard('tasks')
      const createdPath = await dbApi.createRow('tasks')
      const created = await api.getContent(createdPath)
      const extra = {
        ...(created.frontmatter.extra ?? {}),
        type: 'docs',
        priority: 'normal',
        status: 'todo',
        ...(section?.scope_id ? { scope: section.scope_id } : {}),
        ...(section?.id ? { section_id: section.id } : {}),
        origin: 'document_task',
        source_note: documentPath,
        task_template: templateId,
      }
      await api.saveContent(
        createdPath,
        { ...created.frontmatter, title: normalizedTitle, extra },
        taskBody(documentPath, normalizedPrompt),
        created.mtime,
      )
      await refreshTree()
      onClose()
      // 새 카드를 바로 문서로 열어 사용자가 실행 전 제목·프롬프트·문서 링크를 다시 수정할 수 있게 한다.
      openFile(createdPath)
    } catch (cause) {
      setError((cause as Error).message || '태스크 카드를 만들지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 px-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-task-title"
        className="w-[560px] max-w-full overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
      >
        <div className="border-b border-[#efefed] px-5 py-4">
          <h2 id="document-task-title" className="text-[15px] font-semibold text-[#37352f]">
            문서 작업 등록
          </h2>
          <p className="mt-1 truncate text-[12px] text-[#787774]" title={documentPath}>
            원본 문서: {documentPath}
          </p>
          <p className="mt-1 text-[11px] text-[#9b9a97]">
            {section
              ? `실행 문맥: ${section.name} · ${section.scope_id || '워크스페이스 기본'}`
              : '문서가 속한 섹션을 찾지 못해 워크스페이스 기본 문맥을 사용합니다.'}
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-[#5f5e5b]">작업 템플릿</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="작업 템플릿">
              {TEMPLATES.map((template) => {
                const selected = template.id === templateId
                return (
                  <button
                    key={template.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`rounded-lg border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4a9eff] ${
                      selected
                        ? 'border-[#37352f] bg-[#f7f7f5] text-[#37352f]'
                        : 'border-[#e3e2e0] text-[#5f5e5b] hover:bg-[#fbfbfa]'
                    }`}
                    onClick={() => selectTemplate(template.id)}
                  >
                    <span className="block text-[12px] font-medium">{template.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-[#9b9a97]">{template.description}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <label className="block text-[12px] font-medium text-[#5f5e5b]">
            태스크 제목
            <input
              ref={titleRef}
              value={title}
              maxLength={120}
              className="mt-1.5 w-full rounded-md border border-[#e3e2e0] px-2.5 py-1.5 text-[13px] font-normal text-[#37352f] outline-none focus:border-[#8a8886]"
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="block text-[12px] font-medium text-[#5f5e5b]">
            Twill AI에게 전달할 요청
            <textarea
              value={prompt}
              rows={6}
              className="mt-1.5 w-full resize-y rounded-md border border-[#e3e2e0] px-2.5 py-2 text-[13px] font-normal leading-relaxed text-[#37352f] outline-none focus:border-[#8a8886]"
              onChange={(event) => setPrompt(event.target.value)}
              disabled={busy}
            />
          </label>
          {error && <p className="text-[12px] text-[#c92a2a]" role="alert">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-[#efefed] bg-[#fbfbfa] px-5 py-3">
          <button
            type="button"
            className="rounded border border-[#e3e2e0] bg-white px-3 py-1.5 text-[13px] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            취소
          </button>
          <button
            type="button"
            className="rounded bg-[#37352f] px-3 py-1.5 text-[13px] text-white hover:bg-[#565452] disabled:opacity-50"
            onClick={() => void createTask()}
            disabled={busy || !title.trim() || !prompt.trim()}
          >
            {busy ? '등록 중…' : '태스크 만들기'}
          </button>
        </div>
      </div>
    </div>
  )
}
