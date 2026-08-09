import { useCallback, useEffect, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { en as defaultDictionary } from '@blocknote/core/locales'
import { locales as multiColumnLocales } from '@blocknote/xl-multi-column'
import { api } from '../api'
import { isDarkTheme, useThemeStore } from '../theme'
import type { FileContent } from '../types'
import { fromMarkdownBlocks, schema, toMarkdownBlocks } from './Editor'

/**
 * 노트 "본문만" 편집하는 경량 BlockNote 에디터 — 태스크 카드 팝업의 설명 영역 등에 임베드.
 *
 * 본편집기(Editor.tsx)와 동일한 스키마·마크다운 왕복 변환을 재사용하므로 콜아웃·인라인 DB·
 * 다이어그램 블록도 그대로 렌더된다 (미리보기 = 편집, WYSIWYG).
 *
 * 저장 정책: 1초 디바운스 자동 저장. 저장 직전에 서버의 최신 frontmatter/mtime 을 다시 읽어
 * 본문만 갈아끼운다 — 같은 팝업의 DbCell(상태·승인 정책 등)이 frontmatter 를 병행 수정하므로
 * 처음 열 때의 스냅샷으로 덮어쓰면 그 변경이 되돌아가는 사고를 막기 위함.
 */
export default function NoteBodyEditor({ content, spellCheck = false }: { content: FileContent; spellCheck?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const appTheme = useThemeStore((s) => s.theme)
  const loadedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useCreateBlockNote({
    schema,
    uploadFile: api.uploadAsset,
    dictionary: { ...defaultDictionary, multi_column: multiColumnLocales.ko },
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(content.body)
      if (cancelled) return
      editor.replaceBlocks(editor.document, fromMarkdownBlocks(blocks))
      loadedRef.current = true
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = useCallback(async () => {
    if (!loadedRef.current) return
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setStatus('saving')
    try {
      const body = await editor.blocksToMarkdownLossy(toMarkdownBlocks(editor.document))
      // 최신 frontmatter/mtime 을 읽어 본문만 교체 (병행 수정된 메타 필드 보존)
      const latest = await api.getContent(content.path)
      await api.saveContent(content.path, latest.frontmatter, body, latest.mtime)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }, [editor, content.path])

  const scheduleSave = useCallback(() => {
    if (!loadedRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => save(), 1000)
  }, [save])

  // 언마운트(팝업 닫기) 시 대기 중인 자동저장을 즉시 실행 — 변경 유실 방지
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

  return (
    <div className="note-body-editor relative" spellCheck={spellCheck}>
      <BlockNoteView editor={editor} theme={isDarkTheme(appTheme) ? 'dark' : 'light'} onChange={scheduleSave} />
      <span
        className={`pointer-events-none absolute -top-6 right-0 text-[10px] ${
          status === 'error' ? 'text-red-500' : status === 'saved' ? 'text-green-600' : 'text-[#9b9a97]'
        }`}
      >
        {status === 'saving' ? '저장 중…' : status === 'saved' ? '저장됨 ✓' : status === 'error' ? '저장 실패' : ''}
      </span>
    </div>
  )
}
