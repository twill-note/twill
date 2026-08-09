import assert from 'node:assert/strict'
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
})
