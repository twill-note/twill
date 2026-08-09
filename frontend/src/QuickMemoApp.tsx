import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type QuickMemoSaveResult } from './api'

const MAX_MEMO_LENGTH = 10_000

type Notice =
  | { kind: 'idle' }
  | { kind: 'success'; date: string; alreadySaved: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'copied' }

function createMemoId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function toLocalIsoTimestamp(value: Date) {
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0')
  const offsetMins = String(absoluteOffset % 60).padStart(2, '0')
  const date = [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
  const time = [String(value.getHours()).padStart(2, '0'), String(value.getMinutes()).padStart(2, '0'), String(value.getSeconds()).padStart(2, '0')].join(':')
  const milliseconds = String(value.getMilliseconds()).padStart(3, '0')
  return `${date}T${time}.${milliseconds}${sign}${offsetHours}:${offsetMins}`
}

function formatDailyDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function failureMessage(result: QuickMemoSaveResult | null) {
  switch (result?.status) {
    case 'BUSY':
      return '다른 저장을 기다리느라 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.'
    case 'CONFLICT':
      return '데일리 노트가 계속 바뀌고 있어 저장하지 못했어요. 내용을 확인한 뒤 다시 시도해 주세요.'
    case 'INVALID_INPUT':
      return '내용을 저장할 수 없어요. 빈 메모가 아닌지와 글자 수를 확인해 주세요.'
    default:
      return '저장하지 못했어요. 입력한 내용은 그대로 남아 있어요.'
  }
}

export default function QuickMemoApp() {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const successTimer = useRef<number | undefined>(undefined)
  const [content, setContent] = useState('')
  const [memoId, setMemoId] = useState(createMemoId)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>({ kind: 'idle' })

  const isEmpty = !content.trim()
  const isTooLong = content.length > MAX_MEMO_LENGTH
  const canSave = !isSaving && !isEmpty && !isTooLong

  const focusEditor = useCallback(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    focusEditor()
    window.addEventListener('focus', focusEditor)
    return () => window.removeEventListener('focus', focusEditor)
  }, [focusEditor])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!content) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [content])

  useEffect(() => () => window.clearTimeout(successTimer.current), [])

  const clearSuccessNoticeLater = () => {
    window.clearTimeout(successTimer.current)
    successTimer.current = window.setTimeout(() => setNotice({ kind: 'idle' }), 3_000)
  }

  const save = useCallback(async () => {
    if (!canSave) return

    const capturedAt = new Date()
    const timestamp = toLocalIsoTimestamp(capturedAt)
    const date = timestamp.slice(0, 10)
    setIsSaving(true)
    setNotice({ kind: 'idle' })

    try {
      const result = await api.quickMemos.save({ content, id: memoId, date, captured_at: timestamp })
      if (!result.success) {
        setNotice({ kind: 'error', message: failureMessage(result) })
        return
      }
      setContent('')
      setMemoId(createMemoId())
      setNotice({ kind: 'success', date: result.date ?? date, alreadySaved: result.status === 'ALREADY_SAVED' })
      clearSuccessNoticeLater()
      window.requestAnimationFrame(focusEditor)
    } catch {
      setNotice({ kind: 'error', message: failureMessage(null) })
    } finally {
      setIsSaving(false)
    }
  }, [canSave, content, focusEditor, memoId])

  useEffect(() => {
    const saveWithShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key !== 'Enter' && event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void save()
    }

    window.addEventListener('keydown', saveWithShortcut)
    return () => window.removeEventListener('keydown', saveWithShortcut)
  }, [save])

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setNotice({ kind: 'copied' })
    } catch {
      setNotice({ kind: 'error', message: '클립보드에 복사하지 못했어요. 내용을 직접 선택해 복사해 주세요.' })
    }
  }

  const shortcut = navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl'
  const charCountLabel = `${content.length.toLocaleString()} / ${MAX_MEMO_LENGTH.toLocaleString()}`

  return (
    <main className="quick-memo" aria-labelledby="quick-memo-title">
      <header className="quick-memo__header">
        <div>
          <p className="quick-memo__eyebrow">빠른 메모</p>
          <h1 id="quick-memo-title">떠오른 생각을 바로 남기세요</h1>
        </div>
        <span className="quick-memo__status-dot" aria-label="저장 준비됨" />
      </header>

      <section className="quick-memo__editor" aria-label="메모 입력">
        <label className="sr-only" htmlFor="quick-memo-content">메모</label>
        <textarea
          ref={textareaRef}
          id="quick-memo-content"
          value={content}
          onChange={(event) => {
            setContent(event.target.value)
            if (notice.kind !== 'idle') setNotice({ kind: 'idle' })
          }}
          placeholder="무엇을 기록할까요?"
          disabled={isSaving}
          aria-describedby="quick-memo-help quick-memo-count quick-memo-feedback"
          aria-invalid={isTooLong}
          spellCheck
        />
        <div className="quick-memo__editor-foot">
          <span id="quick-memo-help">일반 텍스트로 오늘의 데일리에 저장돼요.</span>
          <span id="quick-memo-count" className={isTooLong ? 'is-warning' : undefined}>{charCountLabel}</span>
        </div>
      </section>

      <div id="quick-memo-feedback" className="quick-memo__feedback" aria-live="polite">
        {notice.kind === 'success' && (
          <p className="quick-memo__message quick-memo__message--success">
            {notice.alreadySaved ? '이미 저장된 메모예요.' : `${formatDailyDate(notice.date)} 데일리에 저장했어요.`}
          </p>
        )}
        {notice.kind === 'error' && (
          <div className="quick-memo__message quick-memo__message--error">
            <p>{notice.message}</p>
            <div className="quick-memo__recovery-actions">
              <button type="button" onClick={() => void save()} disabled={isSaving || isEmpty || isTooLong}>다시 시도</button>
              <button type="button" onClick={() => void copyContent()} disabled={!content}>복사</button>
            </div>
          </div>
        )}
        {notice.kind === 'copied' && <p className="quick-memo__message quick-memo__message--success">메모를 클립보드에 복사했어요.</p>}
      </div>

      <footer className="quick-memo__footer">
        <span className="quick-memo__shortcut"><kbd>{shortcut}</kbd> <kbd>Enter</kbd> 저장</span>
        <button type="button" className="quick-memo__save" onClick={() => void save()} disabled={!canSave}>
          {isSaving ? '저장 중…' : '저장'}
        </button>
      </footer>
    </main>
  )
}
