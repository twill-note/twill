export type ThemeId =
  | 'paper'
  | 'dracula'
  | 'notion'
  | 'nord'
  | 'graphiteteal'

export type ThemeOption = {
  id: ThemeId
  name: string
  desc: string
  dots: [string, string, string]
  dark?: boolean
}

export const DEFAULT_THEME: ThemeId = 'graphiteteal'

export const THEMES: ThemeOption[] = [
  { id: 'graphiteteal', name: 'Twill Code · Graphite Teal', desc: '차콜 그라파이트 + 차분한 틸과 코드 하이라이트', dots: ['#151719', '#ccdde3', '#80cbc4'], dark: true },
  { id: 'dracula', name: '드라큘라', desc: '남보라 다크 + 네온 퍼플/핑크/그린', dots: ['#282a36', '#f8f8f2', '#bd93f9'], dark: true },
  { id: 'nord', name: '노르드 다크', desc: '북유럽 블루-그레이 다크', dots: ['#2e3440', '#eceff4', '#88c0d0'], dark: true },
  { id: 'notion', name: '노션', desc: '따뜻한 미색 + 잉크 브라운', dots: ['#ffffff', '#37352f', '#f7f7f5'] },
  { id: 'paper', name: '페이퍼 세피아', desc: '크림 종이 + 세피아 잉크 + 딥그린', dots: ['#faf6ec', '#433422', '#4a6b50'] },
]

const RETIRED_THEMES: Record<string, ThemeId> = {
  mint: 'notion',
  midnight: 'graphiteteal',
  irisdark: 'dracula',
  rosepine: 'dracula',
  plum: 'paper',
  sunset: 'paper',
}

export function resolveTheme(saved: string | null): ThemeId {
  if (saved && Object.hasOwn(RETIRED_THEMES, saved)) return RETIRED_THEMES[saved]
  return THEMES.some((theme) => theme.id === saved) ? (saved as ThemeId) : DEFAULT_THEME
}
