import { useEffect, useState } from 'react'
import { api, type WorkspaceSettings } from '../api'
import { dialog } from '../dialog'
import { useAppStore } from '../store'
import {
  comboFromEvent,
  DEFAULT_BINDINGS,
  displayCombo,
  IS_MAC,
  SHORTCUT_ACTIONS,
  useShortcutStore,
  type ShortcutAction,
} from '../shortcuts'
import { DEFAULT_THEME, THEMES, useThemeStore } from '../theme'
import { isRepeatedClick, useBackdropDismiss } from '../useBackdropDismiss'

// 모델 목록을 아직 못 받았을 때의 강도 후보 (GPT-5.6부터 max·ultra 가 추가됨 — 실제 지원
// 여부는 모델별 supportedEfforts 가 우선)
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh']

/** 앱 단축키 재지정 — [변경] 클릭 후 원하는 키 조합을 누르면 즉시 저장. */
function ShortcutsSection() {
  const bindings = useShortcutStore((s) => s.bindings)
  const setBinding = useShortcutStore((s) => s.setBinding)
  const resetBinding = useShortcutStore((s) => s.resetBinding)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const record = (action: ShortcutAction, e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      setError(null)
      return
    }
    const combo = comboFromEvent(e.nativeEvent)
    if (!combo) {
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        setError('Ctrl/Alt/⌘ 같은 수식키와 함께 눌러야 합니다 (일반 타이핑과의 충돌 방지)')
      }
      return
    }
    const conflict = setBinding(action, combo)
    if (conflict) {
      setError(`'${displayCombo(combo)}' 는 이미 "${conflict}" 에 지정되어 있습니다`)
      return
    }
    setRecording(null)
    setError(null)
  }

  return (
    <div className="rounded-md border border-[#e9e9e7]">
      {SHORTCUT_ACTIONS.map((a) => {
        const isRecording = recording === a.id
        const isDefault = bindings[a.id] === DEFAULT_BINDINGS[a.id]
        return (
          <div key={a.id} className="flex items-center gap-2 border-b border-[#f1f1ef] px-3 py-1.5 last:border-b-0">
            <span className="w-6 shrink-0 text-center text-[13px]">{a.icon}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[#37352f]">{a.label}</span>
            {isRecording ? (
              <button
                autoFocus
                className="rounded border border-[#4a9eff] bg-[#f5f8ff] px-2 py-0.5 text-[11px] text-[#2f6fd0] outline-none"
                onKeyDown={(e) => record(a.id, e)}
                onBlur={() => {
                  setRecording(null)
                  setError(null)
                }}
                title="원하는 키 조합을 누르세요 (Esc: 취소)"
              >
                키 입력 대기…
              </button>
            ) : (
              <kbd className="rounded bg-[#f1f1ef] px-1.5 py-0.5 text-[11px] text-[#5f5e5b]">
                {displayCombo(bindings[a.id])}
              </kbd>
            )}
            <button
              className="shrink-0 rounded border border-[#e3e2e0] px-1.5 py-0.5 text-[10px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
              onClick={() => {
                setRecording(a.id)
                setError(null)
              }}
            >
              변경
            </button>
            <button
              className={`shrink-0 rounded px-1 py-0.5 text-[11px] ${
                isDefault ? 'cursor-default text-[#e3e2e0]' : 'text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]'
              }`}
              onClick={() => {
                if (!isDefault) {
                  resetBinding(a.id)
                  setError(null)
                }
              }}
              title="기본값으로 되돌리기"
              disabled={isDefault}
            >
              ↺
            </button>
          </div>
        )
      })}
      <p className="px-3 py-1.5 text-[10px] text-[#9b9a97]">
        고정된 노트는 고정 순서대로 {IS_MAC ? 'Option(⌥)+1~9' : 'Alt+1~9'}로 열립니다 (재지정 대상 아님).
      </p>
      {error && <p className="border-t border-[#f1f1ef] px-3 py-1.5 text-[11px] text-[#c92a2a]">{error}</p>}
    </div>
  )
}

/** 테마 팔레트 도트 3개 (배경·본문·포인트). */
function ThemeDots({ dots }: { dots: readonly [string, string, string] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {dots.map((c, i) => (
        <span
          key={i}
          className="inline-block h-4 w-4 rounded-full border border-black/10"
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  )
}

/** 테마 선택 커스텀 드롭다운 — 목록 항목 안에서 팔레트 도트·설명을 미리 보고 고른다.
 *  선택 즉시 전체 UI에 적용 (저장 버튼과 무관, 기기별 localStorage). */
function ThemePicker() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  return (
    <div className="relative">
      {/* 트리거: 현재 테마 요약 */}
      <button
        type="button"
        className="flex w-full items-center gap-2.5 rounded-md border border-[#e3e2e0] bg-white px-2.5 py-2 text-left hover:border-[#c8c7c4]"
        onClick={(event) => {
          if (!isRepeatedClick(event)) setOpen((v) => !v)
        }}
        aria-expanded={open}
        title="테마 선택"
      >
        <ThemeDots dots={current.dots} />
        <span className="shrink-0 text-[12px] font-medium text-[#37352f]">
          {current.name}
          {current.dark && (
            <span className="ml-1.5 rounded bg-[#37352f] px-1 py-px align-middle text-[9px] text-white">DARK</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#9b9a97]">{current.desc}</span>
        <span className="shrink-0 text-[10px] text-[#9b9a97]">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-[#e3e2e0] bg-white py-1 shadow-lg">
            {THEMES.map((t) => {
              const active = t.id === theme
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left ${
                    active ? 'bg-[#f1f1ef]' : 'hover:bg-[#f7f7f5]'
                  }`}
                  onClick={() => {
                    setTheme(t.id)
                    setOpen(false)
                  }}
                >
                  <ThemeDots dots={t.dots} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12px] font-medium text-[#37352f]">
                      {t.name}
                      {t.id === DEFAULT_THEME && <span className="text-[10px] font-normal text-[#9b9a97]">기본</span>}
                      {t.dark && (
                        <span className="rounded bg-[#37352f] px-1 py-px text-[9px] font-normal text-white">DARK</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-[#9b9a97]">{t.desc}</span>
                  </span>
                  {active && <span className="shrink-0 text-[12px] text-[#37352f]">✓</span>}
                </button>
              )
            })}
            <p className="border-t border-[#efefed] px-2.5 pb-1 pt-1.5 text-[10px] text-[#9b9a97]">
              선택 즉시 적용됩니다 (이 기기에만 저장).
            </p>
          </div>
        </>
      )}
    </div>
  )
}

type ModelOption = {
  id: string
  displayName: string
  isDefault: boolean
  supportedEfforts: string[]
}

/**
 * 설정 다이얼로그.
 * - 파일 탐색기와 AI 기본 모델/강도·채팅 메모리 학습
 * 저장 시 `.workspace.json` 에 반영.
 *
 * "워크스페이스 이름"(어디에도 표시 안 되던 죽은 필드)과 "프로젝트 관리 열기"(사이드바에
 * 이미 상시 버튼이 있어 중복)는 제거됨 — 프로젝트 구분은 이제 섹션이 담당.
 */
export default function WorkspaceSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [gitMetadataAccess, setGitMetadataAccess] = useState(false)
  const [gitAccessBusy, setGitAccessBusy] = useState(false)
  const refreshTree = useAppStore((s) => s.refreshTree)

  useEffect(() => {
    api.workspaceSettings
      .get()
      .then(setSettings)
      .catch((e) => setError((e as Error).message))
    // 엔진 중립 엔드포인트 — 설치된 기본 엔진(codex 등)의 모델 목록
    fetch('/api/ai/models')
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((r: { models: ModelOption[] }) => setModels(r.models ?? []))
      .catch(() => setModels([]))
    api.ai
      .gitMetadataAccess()
      .then((status) => setGitMetadataAccess(status.enabled))
      .catch((e) => setError((e as Error).message))
  }, [])

  const save = async () => {
    if (!settings) return
    setBusy(true)
    setError(null)
    try {
      await api.workspaceSettings.put(settings)
      await refreshTree()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const updateGitMetadataAccess = async (enabled: boolean) => {
    const confirmed = await dialog.confirm(
      enabled ? 'Git 메타데이터 쓰기를 허용할까요?' : 'Git 메타데이터 쓰기 권한을 해제할까요?',
      {
        detail: enabled
          ? '이 기기의 Codex가 모든 프로젝트에서 git add·commit·브랜치·병합 등 로컬 Git 메타데이터를 갱신할 수 있도록 허용합니다. Twill AI는 현재 실행 서버를 종료하고, 다음 요청을 새 규칙으로 시작합니다. 원격 push와 git reset --hard는 허용하지 않습니다.'
          : '이 기기의 Codex Git 메타데이터 쓰기 규칙을 제거합니다. Twill AI는 현재 실행 서버를 종료하고, 다음 요청을 새 규칙으로 시작합니다.',
        confirmLabel: enabled ? '허용' : '해제',
      },
    )
    if (!confirmed) return

    setGitAccessBusy(true)
    setError(null)
    try {
      const status = await api.ai.setGitMetadataAccess(enabled)
      setGitMetadataAccess(status.enabled)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGitAccessBusy(false)
    }
  }

  const currentModel = models.find((m) => m.id === settings?.codex.default_model)
  const effortOptions = currentModel?.supportedEfforts.length ? currentModel.supportedEfforts : FALLBACK_EFFORTS
  // 저장된 값이 현재 모델 목록에 없는 경우(플러그인 미설치 등)에도 값을 잃지 않도록 합성 옵션 추가
  const modelSelectOptions =
    settings?.codex.default_model && !currentModel
      ? [{ id: settings.codex.default_model, displayName: settings.codex.default_model, isDefault: false, supportedEfforts: [] }, ...models]
      : models

  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[6vh]"
      onClick={dismissFromBackdrop}
      data-testid="workspace-settings-dialog"
    >
      <div
        className="w-[640px] max-w-[95vw] max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#e9e9e7] px-5 py-3">
          <h2 className="text-[14px] font-semibold text-[#37352f]">⚙ 설정</h2>
          <button className="rounded px-2 py-0.5 text-[13px] text-[#9b9a97] hover:bg-[#efefed]" onClick={onClose}>
            ✕
          </button>
        </div>

        {!settings ? (
          <div className="p-6 text-center text-[13px] text-[#9b9a97]">
            {error ? <span className="text-[#c92a2a]">{error}</span> : '로드 중…'}
          </div>
        ) : (
          <div className="space-y-5 p-5">
            {/* 테마 — 클릭 즉시 적용 (기기별 저장, 저장 버튼과 무관) */}
            <div>
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[#9b9a97]">
                테마
              </label>
              <ThemePicker />
            </div>

            <div>
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[#9b9a97]">
                파일 탐색기
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[#e9e9e7] p-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-[#37352f]"
                  checked={settings.explorer.show_all_files}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      explorer: { ...settings.explorer, show_all_files: e.target.checked },
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[#37352f]">모든 파일 표시</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-[#9b9a97]">
                    저장소의 모든 파일을 표시합니다.
                  </span>
                </span>
              </label>
            </div>

            {/* AI 설정 */}
            <div>
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[#9b9a97]">
                AI 설정
              </label>
              <div className="space-y-2 rounded-md border border-[#e9e9e7] p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-[11px] text-[#5f5e5b]">기본 모델</label>
                    <select
                      className="w-full rounded border border-[#e3e2e0] bg-white px-2 py-1 text-[12px] outline-none"
                      value={settings.codex.default_model}
                      onChange={(e) =>
                        setSettings({ ...settings, codex: { ...settings.codex, default_model: e.target.value } })
                      }
                    >
                      <option value="">(엔진 전역 기본값 사용)</option>
                      {modelSelectOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                          {m.isDefault ? ' (기본)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-[#5f5e5b]">기본 강도</label>
                    <select
                      className="w-full rounded border border-[#e3e2e0] bg-white px-2 py-1 text-[12px] outline-none"
                      value={settings.codex.default_effort}
                      onChange={(e) =>
                        setSettings({ ...settings, codex: { ...settings.codex, default_effort: e.target.value } })
                      }
                    >
                      <option value="">(모델 기본값 사용)</option>
                      {effortOptions.map((eff) => (
                        <option key={eff} value={eff}>
                          {eff}
                        </option>
                      ))}
                    </select>
                    {settings.codex.default_effort === 'ultra' && (
                      <p className="mt-1 rounded bg-[#fff7e6] px-2 py-1 text-[10px] text-[#a67c1b]">
                        ⚠️ ultra 는 서브에이전트 병렬 실행으로 토큰 소모가 매우 큽니다. 기본값으로는 비추천.
                      </p>
                    )}
                  </div>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 border-t border-[#efefed] pt-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-[#37352f]"
                    checked={settings.codex.learn_from_chat}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        codex: { ...settings.codex, learn_from_chat: e.target.checked },
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-[#37352f]">채팅 질문 메모리 학습</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-[#9b9a97]">
                      Twill AI 채팅에서 확인된 재사용 가능한 도메인 지식을 자동으로 메모리에 저장합니다.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 border-t border-[#efefed] pt-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-[#37352f]"
                    checked={gitMetadataAccess}
                    disabled={gitAccessBusy}
                    onChange={(e) => void updateGitMetadataAccess(e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-[#37352f]">Git 메타데이터 쓰기 권한 (기기 전체)</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-[#9b9a97]">
                      사용자 허용 후 Twill AI가 다른 프로젝트에서도 .git 메타데이터를 갱신할 수 있습니다. 원격 push와 git reset --hard는 제외됩니다.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* 단축키 — 검색과 주요 화면 열기/토글 키 재지정 */}
            <div>
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[#9b9a97]">
                단축키
              </label>
              <ShortcutsSection />
            </div>

            {error && <p className="text-[12px] text-[#c92a2a]">{error}</p>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[#e9e9e7] px-5 py-3">
          <button
            className="rounded-md border border-[#e3e2e0] px-3 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded-md bg-[#37352f] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#2b2925] disabled:opacity-60"
            onClick={save}
            disabled={busy || !settings}
          >
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
