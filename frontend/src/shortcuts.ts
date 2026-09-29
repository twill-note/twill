import { create } from 'zustand'
import { TERMINAL_ENABLED } from './features'

/**
 * 앱 전역 단축키 — 설정(⚙) 팝업에서 사용자가 재지정 가능.
 * 조합 표현: "Ctrl+Alt+Shift+Meta" 수식키 + KeyboardEvent.code, '+' 로 연결 (예: "Alt+KeyT").
 * localStorage 에 저장되며, 없는 항목은 기본값을 쓴다.
 */
export type ShortcutAction = 'search' | 'taskBoard' | 'scopes' | 'todayNote' | 'calendar' | 'todos' | 'ai' | 'terminal'

export function isShortcutEnabled(action: ShortcutAction): boolean {
  return action !== 'terminal' || TERMINAL_ENABLED
}

export const SHORTCUT_ACTIONS: Array<{ id: ShortcutAction; label: string; icon: string }> = [
  { id: 'search', label: '검색', icon: '🔍' },
  { id: 'taskBoard', label: '태스크 보드', icon: '📋' },
  { id: 'scopes', label: '프로젝트 관리', icon: '🌐' },
  { id: 'todayNote', label: '오늘의 노트', icon: '☀️' },
  { id: 'calendar', label: '캘린더', icon: '📅' },
  { id: 'todos', label: '할 일', icon: '✅' },
  { id: 'ai', label: 'Twill AI 패널', icon: '🤖' },
  { id: 'terminal', label: '터미널', icon: '>_' },
]

/** macOS 여부 — 수식키 매핑('Mod')과 표기(⌘·⌥·⇧·⌃)에 사용. */
export const IS_MAC = /Mac|iPhone|iPad/.test(
  typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '',
)

// 'Mod' = 플랫폼 주 수식키 (맥 ⌘ Command, 그 외 Ctrl). 기본값을 Mod 로 정의하면
// 같은 설정이 맥에서는 ⌘D, 윈도우/리눅스에서는 Ctrl+D 로 동작·표시된다.
export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = {
  search: 'Mod+KeyK',
  taskBoard: 'Alt+KeyT',
  scopes: 'Alt+KeyP',
  todayNote: 'Mod+KeyD',
  calendar: 'Alt+KeyC',
  todos: 'Alt+KeyH',
  ai: 'Alt+KeyB',
  terminal: 'Ctrl+Backquote', // VS Code 관례 — 맥에서도 ⌃` (Ctrl)
}

const STORAGE_KEY = 'shortcut-bindings'

function loadBindings(): Record<ShortcutAction, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    const out = { ...DEFAULT_BINDINGS }
    for (const action of Object.keys(DEFAULT_BINDINGS) as ShortcutAction[]) {
      if (typeof saved[action] === 'string' && saved[action]) out[action] = saved[action]
    }
    return out
  } catch {
    return { ...DEFAULT_BINDINGS }
  }
}

type ComboEvent = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'key' | 'code'>

/** 키 이벤트 → 조합 문자열 (녹화용, 플랫폼 주 수식키는 'Mod' 로 정규화).
 *  수식키 없는 단독 키는 타이핑과 충돌하므로 허용하지 않음(null). */
export function comboFromEvent(e: ComboEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null // 수식키 단독
  const parts: string[] = []
  // 주 수식키(맥 ⌘ / 그 외 Ctrl)는 'Mod' 로 저장 → 어느 환경에서 열어도 자연스러운 키가 됨
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (IS_MAC ? e.ctrlKey : false) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (!IS_MAC && e.metaKey) parts.push('Meta')
  if (parts.length === 0) return null
  parts.push(e.code)
  return parts.join('+')
}

/** 이벤트가 주어진 조합과 일치하는지 — 'Mod' 는 플랫폼 주 수식키로 해석, 리터럴 Ctrl/Meta 도 지원. */
function eventMatchesCombo(e: ComboEvent, combo: string): boolean {
  const parts = combo.split('+')
  const code = parts[parts.length - 1]
  if (e.code !== code) return false
  const mods = new Set(parts.slice(0, -1))
  const wantMod = mods.has('Mod')
  const wantCtrl = mods.has('Ctrl')
  const wantMeta = mods.has('Meta')
  // 기대되는 ctrl/meta 상태 계산 (Mod = 맥이면 meta, 아니면 ctrl)
  const expectCtrl = wantCtrl || (wantMod && !IS_MAC)
  const expectMeta = wantMeta || (wantMod && IS_MAC)
  return (
    e.ctrlKey === expectCtrl &&
    e.metaKey === expectMeta &&
    e.altKey === mods.has('Alt') &&
    e.shiftKey === mods.has('Shift')
  )
}

/** 조합 문자열을 플랫폼에 맞는 표기로 (맥: ⌘T·⌥T·⌃` / 그 외: Ctrl+T·Alt+T). */
export function displayCombo(combo: string): string {
  const parts = combo.split('+').map((part) => {
    if (part === 'Mod') return IS_MAC ? '⌘' : 'Ctrl'
    if (part === 'Meta') return IS_MAC ? '⌘' : 'Win'
    if (part === 'Ctrl') return IS_MAC ? '⌃' : 'Ctrl'
    if (part === 'Alt') return IS_MAC ? '⌥' : 'Alt'
    if (part === 'Shift') return IS_MAC ? '⇧' : 'Shift'
    if (/^Key([A-Z])$/.test(part)) return part.slice(3)
    if (/^Digit(\d)$/.test(part)) return part.slice(5)
    const special: Record<string, string> = {
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
      Space: 'Space', Enter: 'Enter', Tab: 'Tab',
    }
    return special[part] ?? part
  })
  // 맥은 기호를 붙여 쓰는 관례 (⌘D), 그 외는 + 로 연결 (Ctrl+D)
  return IS_MAC ? parts.join('') : parts.join('+')
}

interface ShortcutState {
  bindings: Record<ShortcutAction, string>
  /** 재지정. 다른 액션과 충돌하면 그 액션 라벨을 반환하고 적용하지 않음, 성공 시 null. */
  setBinding: (action: ShortcutAction, combo: string) => string | null
  resetBinding: (action: ShortcutAction) => void
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  bindings: loadBindings(),
  setBinding: (action, combo) => {
    const bindings = get().bindings
    const conflict = (Object.entries(bindings) as Array<[ShortcutAction, string]>).find(
      ([other, c]) => other !== action && isShortcutEnabled(other) && c === combo,
    )
    if (conflict) {
      return SHORTCUT_ACTIONS.find((a) => a.id === conflict[0])?.label ?? conflict[0]
    }
    const next = { ...bindings, [action]: combo }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ bindings: next })
    return null
  },
  resetBinding: (action) => {
    const next = { ...get().bindings, [action]: DEFAULT_BINDINGS[action] }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ bindings: next })
  },
}))

/** 이벤트가 어떤 액션의 단축키인지 판별 ('Mod' 와 리터럴 Ctrl/Meta 모두 매칭). */
export function actionForEvent(e: KeyboardEvent): ShortcutAction | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  const bindings = useShortcutStore.getState().bindings
  for (const [action, combo] of Object.entries(bindings) as Array<[ShortcutAction, string]>) {
    if (isShortcutEnabled(action) && eventMatchesCombo(e, combo)) return action
  }
  return null
}
