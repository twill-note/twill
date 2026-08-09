import { create } from 'zustand'
import { DEFAULT_THEME, THEMES, resolveTheme, type ThemeId } from './themeConfig'

export { DEFAULT_THEME, THEMES, type ThemeId } from './themeConfig'

/**
 * 앱 테마 상태 — <html data-theme="..."> 속성으로 themes.css 오버라이드를 활성화한다.
 * 'notion'은 오버라이드가 없어 기본 CSS 팔레트를 사용하고, 새 설치의 기본 선택은 Dracula다.
 * 선택은 localStorage 에 저장 (기기별 설정 — editor-width 와 동일한 정책).
 */
const STORAGE_KEY = 'app-theme'

function loadTheme(): ThemeId {
  return resolveTheme(localStorage.getItem(STORAGE_KEY))
}

function applyTheme(theme: ThemeId) {
  if (theme === 'notion') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  const background = THEMES.find((item) => item.id === theme)?.dots[0]
    ?? THEMES.find((item) => item.id === DEFAULT_THEME)?.dots[0]
    ?? '#282a36'
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
