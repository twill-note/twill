import { create } from 'zustand'
import { DEFAULT_THEME, THEMES, resolveTheme, type ThemeId } from './themeConfig'

export { DEFAULT_THEME, THEMES, type ThemeId } from './themeConfig'

/**
 * 앱 테마 상태 — <html data-theme="..."> 속성으로 themes.css 오버라이드를 활성화한다.
 * 새 설치는 Twill Code를 사용하고, 정리된 테마는 가까운 대표 테마로 전환한다.
 * 선택은 localStorage 에 저장 (기기별 설정 — editor-width 와 동일한 정책).
 */
const STORAGE_KEY = 'app-theme'

function loadTheme(): ThemeId {
  const theme = resolveTheme(localStorage.getItem(STORAGE_KEY))
  localStorage.setItem(STORAGE_KEY, theme)
  return theme
}

function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
  const background = THEMES.find((item) => item.id === theme)?.dots[0]
    ?? THEMES.find((item) => item.id === DEFAULT_THEME)?.dots[0]
    ?? '#151719'
  window.noteDesktop?.setWindowBackground(background)
}

export function isDarkTheme(theme: ThemeId): boolean {
  return THEMES.find((t) => t.id === theme)?.dark ?? false
}

interface ThemeState {
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

export const useThemeStore = create<ThemeState>((set) => {
  const initial = loadTheme()
  applyTheme(initial)
  return {
    theme: initial,
    setTheme: (theme) => {
      localStorage.setItem(STORAGE_KEY, theme)
      applyTheme(theme)
      set({ theme })
    },
  }
})
