export type ThemeId =
  | 'paper'
  | 'dracula'
  | 'mint'
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
  { id: 'mint', name: '민트 라이트', desc: '순백 + 틸 그린의 산뜻한 생산성 라이트', dots: ['#ffffff', '#1f2937', '#0d9488'] },
  { id: 'paper', name: '페이퍼 세피아', desc: '크림 종이 + 세피아 잉크 + 딥그린', dots: ['#faf6ec', '#433422', '#4a6b50'] },
]

const RETIRED_THEMES: Record<string, ThemeId> = {
  nord: 'graphiteteal',
  midnight: 'graphiteteal',
  irisdark: 'dracula',
  rosepine: 'dracula',
  notion: 'mint',
  plum: 'paper',
  sunset: 'paper',
}

export function resolveTheme(saved: string | null): ThemeId {
  if (saved && Object.hasOwn(RETIRED_THEMES, saved)) return RETIRED_THEMES[saved]
  return THEMES.some((theme) => theme.id === saved) ? (saved as ThemeId) : DEFAULT_THEME
}
