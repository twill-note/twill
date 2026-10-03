import { useAiStore } from '../aiStore'
import { SYSTEM_AI_TAB, useAppStore } from '../store'
import { useTranslation } from 'react-i18next'
import { tr } from '../i18n'

/**
 * 벼리 작업 완료 알림 토스트 — 메인 화면 우하단.
 * 벼리 패널이 닫혀 있거나 다른 세션/화면을 보는 중에 실행이 끝나면 뜬다.
 * "결과 보기"로 해당 세션 탭으로 바로 이동. 성공은 12초 후 자동 소멸, 오류는 수동 닫기.
 */
export default function AiToasts() {
  useTranslation()
  const toasts = useAiStore((s) => s.toasts)
  const dismissToast = useAiStore((s) => s.dismissToast)
  const selectSession = useAiStore((s) => s.selectSession)
  const openRightTab = useAppStore((s) => s.openRightTab)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[11000] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto rounded-lg border bg-white p-3 shadow-lg ${
            t.kind === 'error' ? 'border-[#fbcaca]' : 'border-[#e3e2e0]'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="mt-px text-[14px]" aria-hidden="true">
              {t.kind === 'error' ? '⚠️' : '✅'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-[#37352f]">
                {t.category === 'save' ? (t.kind === 'error' ? tr('저장 실패') : tr('저장 완료')) : <>{t.kind === 'error' ? tr("AI 작업 오류") : tr("AI 작업 완료")} — {t.title}</>}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[#5f5e5b]">{t.category === 'save' ? tr(t.message) : t.message}</p>
            </div>
            <button
              className="shrink-0 rounded px-1 text-[12px] text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
              onClick={() => dismissToast(t.id)}
              title={tr("알림 닫기")}
            >
              ✕
            </button>
          </div>
          {t.sessionId && (
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                className="rounded-md bg-[#37352f] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#2b2925]"
                onClick={() => {
                  selectSession(t.sessionId!)
                  openRightTab(SYSTEM_AI_TAB)
                  dismissToast(t.id)
                }}
              >

                {tr("결과 보기")}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
