declare const __TWILL_APP_VERSION__: string
declare const __TWILL_BUILD_TIME__: string

export type AppBuildInfo = Readonly<{
  version: string
  builtAt: string
}>

/** Vite가 제품 번들에 주입한 식별 정보. Node 단위 테스트에서는 안전한 개발값을 사용한다. */
export const APP_BUILD_INFO: AppBuildInfo = Object.freeze({
  version: typeof __TWILL_APP_VERSION__ === 'string' ? __TWILL_APP_VERSION__ : '0.0.0-dev',
  builtAt: typeof __TWILL_BUILD_TIME__ === 'string' ? __TWILL_BUILD_TIME__ : '',
})

export function formatBuildTime(value: string): string {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '개발 빌드'
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
