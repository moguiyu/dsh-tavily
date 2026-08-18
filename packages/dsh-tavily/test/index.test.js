import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampInt, isToolEnabled, normalizeArgs } from '@moguiyu/dsh-tool-tavily-search'
import { STRATEGIES, isValidStrategy, maskValue, parseKeyList, orderKeys, readJsonFile } from '@moguiyu/dsh-tavily-backend/lib'
import { TAVILY_NS } from '../src/index.js'

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

test('STRATEGIES and isValidStrategy', () => {
  assert.deepEqual(STRATEGIES, ['rotate', 'low-usage-first', 'high-usage-first'])
  assert.equal(isValidStrategy('rotate'), true)
  assert.equal(isValidStrategy('bogus'), false)
})

test('maskValue and parseKeyList', () => {
  const long = 'tvly-dev-1234567890abcdef'
  assert.equal(maskValue(long), 'tvly-dev-123…cdef')
  assert.deepEqual(parseKeyList(' a , b , a , , c '), ['a', 'b', 'c'])
})

test('orderKeys', () => {
  assert.deepEqual(orderKeys(['b', 'a'], 'rotate', () => 0), ['b', 'a'])
  assert.deepEqual(orderKeys(['a', 'b'], 'low-usage-first', (key) => key === 'a' ? 100 : 0), ['b', 'a'])
})

test('readJsonFile: missing or broken file falls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavily-test-'))
  assert.deepEqual(readJsonFile(join(dir, 'nope.json'), { x: 1 }), { x: 1 })
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, 'not json')
  assert.deepEqual(readJsonFile(broken, { x: 1 }), { x: 1 })
})

test('isToolEnabled: persisted state wins over plugin config', () => {
  assert.equal(isToolEnabled({ enabled: true }, { enabled: false }), false)
  assert.equal(isToolEnabled({ enabled: false }, { enabled: true }), true)
})

test('isToolEnabled: falls back to plugin config when no state is stored', () => {
  assert.equal(isToolEnabled({ enabled: true }, null), true)
  assert.equal(isToolEnabled({ enabled: false }, null), false)
})

test('TAVILY_NS is the rc.7 plugin-management namespace join key', () => {
  assert.equal(TAVILY_NS, 'tavily-search')
})
