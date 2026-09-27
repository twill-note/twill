import { en, ko } from '@blocknote/core/locales'
import { locales as multiColumnLocales } from '@blocknote/xl-multi-column'
import { currentLanguage } from './i18n'

/** BlockNote reads its dictionary when a menu opens, so this proxy follows language changes
 * without rebuilding the editor instance (which would discard an unsaved editing state). */
const dictionary = new Proxy(
  { ...en, multi_column: multiColumnLocales.en } as typeof en & {
    multi_column: typeof multiColumnLocales.en
  },
  {
    get(_target, key) {
      const language = currentLanguage()
      if (key === 'multi_column') return multiColumnLocales[language]
      const active = language === 'en' ? en : ko
      return Reflect.get(active, key, active)
    },
  },
)

export function getBlockNoteDictionary() {
  return dictionary
}
