export type ThemeId = 'notion' | 'nord' | 'paper' | 'dracula' | 'rosepine' | 'mint' | 'sunset'

export type ThemeOption = {
  id: ThemeId
  name: string
  desc: string
  dots: [string, string, string]
  dark?: boolean
}

export const DEFAULT_THEME: ThemeId = 'dracula'

export const THEMES: ThemeOption[] = [
  { id: 'dracula', name: '드라큘라', desc: '남보라 다크 + 네온 퍼플/핑크/그린', dots: ['#282a36', '#f8f8f2', '#bd93f9'], dark: true },
  { id: 'notion', name: '노션', desc: '따뜻한 미색 + 잉크 브라운', dots: ['#ffffff', '#37352f', '#f7f7f5'] },
  { id: 'mint', name: '민트 라이트', desc: '순백 + 틸 그린의 산뜻한 생산성 라이트', dots: ['#ffffff', '#1f2937', '#0d9488'] },
  { id: 'sunset', name: '선셋 웜', desc: '복숭아빛 웜 화이트 + 오렌지 포인트', dots: ['#fffaf5', '#44403c', '#ea580c'] },
  { id: 'paper', name: '페이퍼 세피아', desc: '크림 종이 + 세피아 잉크 + 딥그린', dots: ['#faf6ec', '#433422', '#4a6b50'] },
  { id: 'nord', name: '노르드 다크', desc: '북유럽 블루-그레이 다크', dots: ['#2e3440', '#eceff4', '#88c0d0'], dark: true },
  { id: 'rosepine', name: '로제 파인', desc: '자주빛 뮤트 다크 + 로즈/골드 파스텔', dots: ['#191724', '#e0def4', '#ebbcba'], dark: true },
]

export function resolveTheme(saved: string | null): ThemeId {
  return THEMES.some((theme) => theme.id === saved) ? (saved as ThemeId) : DEFAULT_THEME
}
