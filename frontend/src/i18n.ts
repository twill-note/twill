import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ko from './locales/ko.json'

/**
 * 앱 다국어(i18n) — 한국어(기본)/영어.
 * 언어는 localStorage 'app-lang' 에 저장 (테마와 동일한 기기별 정책).
 * 컴포넌트: useTranslation() 의 t() / 비 React 모듈: i18n.t() 사용.
 */
export type AppLanguage = 'ko' | 'en'

export const LANGUAGES: Array<{ id: AppLanguage; name: string }> = [
  { id: 'ko', name: '한국어' },
  { id: 'en', name: 'English' },
]

const STORAGE_KEY = 'app-lang'

function loadLanguage(): AppLanguage {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'en' ? 'en' : 'ko'
}

void i18n.use(initReactI18next).init({
  resources: {
    ko: { translation: ko },
    en: { translation: en },
  },
  lng: loadLanguage(),
  fallbackLng: 'ko',
  interpolation: { escapeValue: false }, // React 가 이스케이프하므로 이중 이스케이프 방지
  returnEmptyString: false,
})

export function setLanguage(lang: AppLanguage): void {
  localStorage.setItem(STORAGE_KEY, lang)
  void i18n.changeLanguage(lang)
}

export function currentLanguage(): AppLanguage {
  return i18n.language === 'en' ? 'en' : 'ko'
}

export default i18n
