export const APP_UI_FONT_FAMILY = [
  '"Noto Sans KR"',
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Pretendard',
  '"Malgun Gothic"',
  '"Apple SD Gothic Neo"',
  'Roboto',
  'sans-serif',
].join(', ')

export const APP_MONO_FONT_FAMILY = [
  '"JetBrains Mono"',
  '"D2Coding"',
  '"Cascadia Mono"',
  'Consolas',
  '"Noto Sans KR"',
  '"Malgun Gothic"',
  'monospace',
].join(', ')

const KOREAN_FONT_PROBE = '한글가나다라마바사 데이터베이스 다이어그램'

/** SVG/canvas가 텍스트 폭을 재기 전에 WSLg에 포함한 한글 폰트를 준비한다. */
export async function ensureKoreanFontLoaded() {
  if (typeof document === 'undefined' || !document.fonts) return
  await document.fonts.load('400 14px "Noto Sans KR"', KOREAN_FONT_PROBE)
}
