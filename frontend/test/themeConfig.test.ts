import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_THEME, THEMES, resolveTheme } from '../src/themeConfig.ts'

test('Twill Code is the default theme and appears first', () => {
  assert.equal(DEFAULT_THEME, 'graphiteteal')
  assert.equal(THEMES[0]?.id, DEFAULT_THEME)
})

test('missing or invalid saved themes resolve to Twill Code', () => {
  assert.equal(resolveTheme(null), 'graphiteteal')
  assert.equal(resolveTheme('unknown-theme'), 'graphiteteal')
})

test('an existing valid theme choice is preserved', () => {
  for (const theme of THEMES) assert.equal(resolveTheme(theme.id), theme.id)
})

test('retired themes migrate to the closest representative palette', () => {
  assert.equal(resolveTheme('mint'), 'notion')
  assert.equal(resolveTheme('rosepine'), 'dracula')
  assert.equal(resolveTheme('irisdark'), 'dracula')
  assert.equal(resolveTheme('midnight'), 'graphiteteal')
  assert.equal(resolveTheme('plum'), 'paper')
  assert.equal(resolveTheme('sunset'), 'paper')
})

test('dark theme metadata matches editor rendering mode', () => {
  assert.equal(THEMES.find((theme) => theme.id === 'graphiteteal')?.dark, true)
  assert.equal(THEMES.find((theme) => theme.id === 'dracula')?.dark, true)
  assert.equal(THEMES.find((theme) => theme.id === 'nord')?.dark, true)
  assert.equal(THEMES.find((theme) => theme.id === 'notion')?.dark ?? false, false)
  assert.equal(THEMES.find((theme) => theme.id === 'paper')?.dark ?? false, false)
  assert.equal(THEMES.length, 5)
})

test('generated theme CSS includes every selectable custom theme', () => {
  const css = readFileSync(new URL('../src/themes.css', import.meta.url), 'utf8')
  const customThemes = THEMES.filter((theme) => theme.id !== 'notion')

  for (const theme of customThemes) {
    assert.match(css, new RegExp(`theme: ${theme.id} ═`))
    assert.match(css, new RegExp(`data-theme="${theme.id}"`))
  }
})
