import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STRATEGIES, isValidStrategy, maskValue, parseKeyList, orderKeys, readJsonFile } from '../src/lib.js'

test('STRATEGIES and isValidStrategy', () => {
  assert.deepEqual(STRATEGIES, ['rotate', 'low-usage-first', 'high-usage-first'])
  assert.equal(isValidStrategy('rotate'), true)
  assert.equal(isValidStrategy('bogus'), false)
  assert.equal(isValidStrategy(undefined), false)
})

test('maskValue', () => {
  const long = 'tvly-dev-1234567890abcdef'
  assert.equal(maskValue(long), 'tvly-dev-123…cdef')
  assert.equal(maskValue('short'), '••••')
  assert.equal(maskValue(''), '')
  assert.equal(maskValue('tvly-dev-1234567890abcdef, tvly-dev-xyz'),
    'tvly-dev-123…cdef, ••••')
})

test('parseKeyList', () => {
  assert.deepEqual(parseKeyList(' a , b , a , , c '), ['a', 'b', 'c'])
  assert.deepEqual(parseKeyList(''), [])
  assert.deepEqual(parseKeyList(undefined), [])
  assert.deepEqual(parseKeyList('only'), ['only'])
})

test('orderKeys: rotate keeps order', () => {
  const values = ['b', 'a', 'c']
  assert.deepEqual(orderKeys(values, 'rotate', () => 0), ['b', 'a', 'c'])
})

test('orderKeys: low-usage-first asc, unknown treated as 0', () => {
  const usageOf = (key) => ({ a: 100, b: null }[key] ?? 0)
  assert.deepEqual(orderKeys(['a', 'b', 'c'], 'low-usage-first', usageOf), ['b', 'c', 'a'])
})

test('orderKeys: high-usage-first desc', () => {
  const usageOf = (key) => ({ a: 100, b: 10 }[key] ?? 0)
  assert.deepEqual(orderKeys(['c', 'a', 'b'], 'high-usage-first', usageOf), ['a', 'b', 'c'])
})

test('readJsonFile: missing or broken file falls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavily-test-'))
  assert.deepEqual(readJsonFile(join(dir, 'nope.json'), { x: 1 }), { x: 1 })
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, 'not json')
  assert.deepEqual(readJsonFile(broken, { x: 1 }), { x: 1 })
  const good = join(dir, 'good.json')
  writeFileSync(good, '{"a":1}')
  assert.deepEqual(readJsonFile(good, { x: 1 }), { a: 1 })
})
