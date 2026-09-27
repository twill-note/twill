import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ko from './locales/ko.json'
import aiEn from './locales/fragments/ai.en.json'
import aiKo from './locales/fragments/ai.ko.json'
import boardEn from './locales/fragments/board.en.json'
import boardKo from './locales/fragments/board.ko.json'

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
    ko: { translation: { ...ko, ...aiKo.ai, ...boardKo.board } },
    en: { translation: { ...en, ...aiEn.ai, ...boardEn.board } },
  },
  lng: loadLanguage(),
  fallbackLng: 'ko',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React 가 이스케이프하므로 이중 이스케이프 방지
  returnEmptyString: false,
})

function syncSkillbookLanguage(language: AppLanguage): void {
  void fetch('/api/skillbook/language', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  }).catch(() => {})
}

syncSkillbookLanguage(loadLanguage())

document.documentElement.lang = loadLanguage()

export function setLanguage(lang: AppLanguage): void {
  localStorage.setItem(STORAGE_KEY, lang)
  document.documentElement.lang = lang
  void i18n.changeLanguage(lang)
  syncSkillbookLanguage(lang)
}

export function currentLanguage(): AppLanguage {
  return i18n.language === 'en' ? 'en' : 'ko'
}

/** Source-language keyed UI copy. Missing entries stay readable in the source language. */
export function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options)
}

export default i18n
