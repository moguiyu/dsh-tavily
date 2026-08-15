import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampInt, normalizeArgs } from '../src/index.js'

test('clampInt', () => {
  assert.equal(clampInt(3, 1, 20, 5), 3)
  assert.equal(clampInt(0, 1, 20, 5), 1)
  assert.equal(clampInt(99, 1, 20, 5), 20)
  assert.equal(clampInt(undefined, 1, 20, 5), 5)
  assert.equal(clampInt('abc', 1, 20, 5), 5)
  assert.equal(clampInt(2.6, 1, 20, 5), 3)
})

test('normalizeArgs: query is required and trimmed', () => {
  assert.throws(() => normalizeArgs({}), /non-empty string/)
  assert.throws(() => normalizeArgs({ query: '   ' }), /non-empty string/)
  assert.equal(normalizeArgs({ query: '  hello  ' }).query, 'hello')
})

test('normalizeArgs: defaults and clamping', () => {
  const args = normalizeArgs({ query: 'x' })
  assert.equal(args.maxResults, 5)
  assert.equal(args.searchDepth, 'basic')
  assert.equal(args.topic, 'general')
  assert.equal(args.days, undefined)
  assert.equal(args.includeAnswer, false)
  assert.deepEqual(args.includeDomains, [])
  assert.deepEqual(args.excludeDomains, [])
})

test('normalizeArgs: advanced/news/days', () => {
  const args = normalizeArgs({ query: 'x', search_depth: 'advanced', topic: 'news', days: 7, include_answer: true, max_results: 30 })
  assert.equal(args.searchDepth, 'advanced')
  assert.equal(args.topic, 'news')
  assert.equal(args.days, 7)
  assert.equal(args.includeAnswer, true)
  assert.equal(args.maxResults, 20)
})

test('normalizeArgs: domain filters', () => {
  const args = normalizeArgs({ query: 'x', include_domains: ['a.com', '', 42], exclude_domains: 'nope' })
  assert.deepEqual(args.includeDomains, ['a.com'])
  assert.deepEqual(args.excludeDomains, [])
})
