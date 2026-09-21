import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_THEME, THEMES, resolveTheme } from '../src/themeConfig.ts'

test('Dracula is the default theme and appears first', () => {
  assert.equal(DEFAULT_THEME, 'dracula')
  assert.equal(THEMES[0]?.id, DEFAULT_THEME)
})

test('missing or invalid saved themes resolve to Dracula', () => {
  assert.equal(resolveTheme(null), 'dracula')
  assert.equal(resolveTheme('unknown-theme'), 'dracula')
})

test('an existing valid theme choice is preserved', () => {
  assert.equal(resolveTheme('notion'), 'notion')
  assert.equal(resolveTheme('rosepine'), 'rosepine')
  assert.equal(resolveTheme('midnight'), 'midnight')
  assert.equal(resolveTheme('irisdark'), 'irisdark')
  assert.equal(resolveTheme('plum'), 'plum')
})

test('dark theme metadata matches editor rendering mode', () => {
  assert.equal(THEMES.find((theme) => theme.id === 'midnight')?.dark, true)
  assert.equal(THEMES.find((theme) => theme.id === 'irisdark')?.dark, true)
  assert.equal(THEMES.find((theme) => theme.id === 'plum')?.dark ?? false, false)
})

test('generated theme CSS includes every selectable custom theme', () => {
  const css = readFileSync(new URL('../src/themes.css', import.meta.url), 'utf8')
  const customThemes = THEMES.filter((theme) => theme.id !== 'notion')

  for (const theme of customThemes) {
    assert.match(css, new RegExp(`theme: ${theme.id} ═`))
    assert.match(css, new RegExp(`data-theme="${theme.id}"`))
  }
})
