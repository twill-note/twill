import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionProjectId } from '../src/aiProjectGroups.ts'

const sections = [{ id: 'a', scope_id: 'shared' }, { id: 'b', scope_id: 'shared' }, { id: 'c', scope_id: 'c-scope' }]

test('explicit project wins when projects share the same scope', () => {
  assert.equal(sessionProjectId({ sectionId: 'b', scopeId: 'shared' }, sections), 'b')
})
test('legacy conversations use scope and appear in only one project', () => {
  assert.equal(sessionProjectId({ sectionId: null, scopeId: 'shared' }, sections), 'a')
  assert.equal(sessionProjectId({ sectionId: null, scopeId: 'c-scope' }, sections), 'c')
})
test('deleted projects and unassigned conversations remain at Root', () => {
  assert.equal(sessionProjectId({ sectionId: 'deleted', scopeId: 'shared' }, sections), null)
  assert.equal(sessionProjectId({ sectionId: null, scopeId: 'deleted' }, sections), null)
  assert.equal(sessionProjectId({ sectionId: null, scopeId: null }, sections), null)
})
