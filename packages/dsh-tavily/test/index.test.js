import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STRATEGIES, isValidStrategy, maskValue, parseKeyList, orderKeys, readJsonFile } from '../src/lib.js'
import { TavilyApiClient, TavilyApiError } from '../src/tavily.js'

let fetchRestore

beforeEach(() => {
  fetchRestore = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = fetchRestore
})

test('TavilyApiClient posts JSON with the selected API key', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }
  const client = new TavilyApiClient({ resolveKeys: async () => ['first-key'] })
  await client.request('extract', { urls: ['https://example.com'] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.tavily.com/extract')
  assert.equal(calls[0].init.headers.authorization, 'Bearer first-key')
  assert.deepEqual(JSON.parse(calls[0].init.body), { urls: ['https://example.com'] })
})

test('TavilyApiClient retries a rate-limited key with the next key', async () => {
  const headers = []
  globalThis.fetch = async (_url, init) => {
    headers.push(init.headers.authorization)
    return headers.length === 1
      ? new Response(JSON.stringify({ detail: { error: 'rate limited' } }), { status: 429 })
      : new Response(JSON.stringify({ results: ['https://example.com/docs'] }), { status: 200 })
  }
  const client = new TavilyApiClient({ resolveKeys: async () => ['first-key', 'second-key'] })
  const response = await client.request('map', { url: 'https://example.com' })
  assert.deepEqual(headers, ['Bearer first-key', 'Bearer second-key'])
  assert.deepEqual(response, { results: ['https://example.com/docs'] })
})

test('TavilyApiClient reports missing credentials before fetching', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch') }
  const client = new TavilyApiClient({ resolveKeys: async () => [] })
  await assert.rejects(
    () => client.request('crawl', { url: 'https://example.com' }),
    (error) => error instanceof TavilyApiError && error.code === 'missing_credential',
  )
})

test('TavilyApiClient preserves credential resolution failures', async () => {
  const cause = new Error('credentials service unavailable')
  const client = new TavilyApiClient({ resolveKeys: async () => { throw cause } })
  await assert.rejects(
    () => client.request('search', { query: 'DSH' }),
    (error) => error instanceof TavilyApiError && error.code === 'credential_error' && error.cause === cause,
  )
})

test('TavilyApiClient classifies a custom abort reason as aborted', async () => {
  const controller = new AbortController()
  const reason = new Error('tool timeout')
  globalThis.fetch = async () => {
    controller.abort(reason)
    throw reason
  }
  const client = new TavilyApiClient({ resolveKeys: async () => ['test-key'] })
  await assert.rejects(
    () => client.request('search', { query: 'DSH' }, controller.signal),
    (error) => error instanceof TavilyApiError && error.code === 'aborted' && error.cause === reason,
  )
})

test('TavilyApiClient detects cancellation while decoding a response', async () => {
  const controller = new AbortController()
  const reason = new Error('tool timeout')
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      controller.abort(reason)
      return { results: [] }
    },
  })
  const client = new TavilyApiClient({ resolveKeys: async () => ['test-key'] })
  await assert.rejects(
    () => client.request('search', { query: 'DSH' }, controller.signal),
    (error) => error instanceof TavilyApiError && error.code === 'aborted' && error.cause === reason,
  )
})

test('TavilyApiClient keeps non-abort network failures distinct', async () => {
  globalThis.fetch = async () => { throw new Error('network unavailable') }
  const client = new TavilyApiClient({ resolveKeys: async () => ['test-key'] })
  await assert.rejects(
    () => client.request('search', { query: 'DSH' }),
    (error) => error instanceof TavilyApiError && error.code === 'request_failed',
  )
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
