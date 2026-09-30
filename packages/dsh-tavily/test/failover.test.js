import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

// Hermetic run: the tools half now reads the concurrency policy from the state
// file, so these tests must not inherit whatever the developer's own ~/.dsh
// says — a load-balance setting there would change what is under test.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-failover-'))

// A key pool is only useful if a key that cannot serve a request is skipped.
// Tavily reports an over-limit *account* as HTTP 432 (plan limit) or 433
// (pay-as-you-go limit) — per-key conditions, exactly like 401/429, so the
// rotation must fail over instead of failing the call. This was found live on
// 2026-09-30: two of three configured keys belonged to an account at
// 1000/1000 credits, and tavily_search/tavily_crawl aborted with HTTP 432
// while the third key answered 200.

function bench(keys) {
  const tools = []
  const routes = new Map()
  const teardowns = []

  const credentials = {
    async resolve(name) {
      return name === 'TAVILY_API_KEYS' ? { value: keys.join(','), source: 'test' } : undefined
    },
    async set() {},
    async describe() { return { configured: true } },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => { const i = tools.indexOf(definition); if (i >= 0) tools.splice(i, 1) }
      },
    },
    credentials,
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    get(key) {
      if (key === 'credentials') return credentials
      return undefined
    },
    effect(callback) { teardowns.push(callback()) },
  }

  apply(ctx)
  return { tools }
}

function tavilyResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, async json() { return body } }
}

test('a key over its plan limit fails over to the next key (HTTP 432)', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer over-limit') {
      return tavilyResponse(432, { detail: { error: "This request exceeds your plan's set usage limit." } })
    }
    return tavilyResponse(200, { results: [{ url: 'https://a.example', title: 'A' }] })
  })

  const { tools } = bench(['over-limit', 'healthy'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  const value = await search.execute({ query: 'x' }, {})

  assert.deepEqual(value.results, [{ url: 'https://a.example', title: 'A' }])
  assert.deepEqual(seen, ['Bearer over-limit', 'Bearer healthy'], 'the over-limit key must be followed by the next one')
})

test('a key over its pay-as-you-go limit also fails over (HTTP 433)', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer paygo') {
      return tavilyResponse(433, { detail: { error: 'This request exceeds the pay-as-you-go limit.' } })
    }
    return tavilyResponse(200, { results: [{ url: 'https://b.example' }] })
  })

  const { tools } = bench(['paygo', 'healthy'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  const value = await search.execute({ query: 'x' }, {})

  assert.deepEqual(value.results, [{ url: 'https://b.example' }])
  assert.deepEqual(seen, ['Bearer paygo', 'Bearer healthy'])
})

test('a non-retryable failure surfaces Tavily\'s own message', async (t) => {
  // 432/433 arrive as {"detail":{"error":...}}, so a status-only message throws
  // away the one sentence that says what is actually wrong.
  t.mock.method(globalThis, 'fetch', async () =>
    tavilyResponse(400, { detail: { error: 'Invalid topic: expected general or news' } }))

  const { tools } = bench(['only'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  await assert.rejects(
    () => search.execute({ query: 'x' }, {}),
    (error) => {
      assert.match(error.message, /Invalid topic: expected general or news/)
      return true
    }
  )
})

test('the rotation cursor advances one key per call', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.authorization)
    return tavilyResponse(200, { results: [] })
  })

  const { tools } = bench(['k1', 'k2', 'k3'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  for (let call = 0; call < 4; call++) await search.execute({ query: 'x' }, {})

  assert.deepEqual(seen, ['Bearer k1', 'Bearer k2', 'Bearer k3', 'Bearer k1'])
})

test('a pool whose other keys are exhausted still answers through the healthy one', async (t) => {
  // The exact live shape found on 2026-09-30: three keys, one account with
  // credits left and two sharing an exhausted account.
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer healthy') {
      return tavilyResponse(200, { results: [{ url: 'https://ok.example' }] })
    }
    return tavilyResponse(432, { detail: { error: "This request exceeds your plan's set usage limit." } })
  })

  const { tools } = bench(['exhausted-a', 'exhausted-b', 'healthy'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  const value = await search.execute({ query: 'x' }, {})

  assert.deepEqual(value.results, [{ url: 'https://ok.example' }])
  assert.deepEqual(seen, ['Bearer exhausted-a', 'Bearer exhausted-b', 'Bearer healthy'])
})

test('every key over its plan limit reports the plan limit, not an invalid key', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.authorization)
    return tavilyResponse(432, { detail: { error: "This request exceeds your plan's set usage limit." } })
  })

  const { tools } = bench(['a', 'b'])
  const search = tools.find((definition) => definition.name === 'tavily_search')

  await assert.rejects(
    () => search.execute({ query: 'x' }, {}),
    (error) => {
      assert.match(error.message, /HTTP 432/)
      assert.match(error.message, /plan usage limit/i)
      assert.doesNotMatch(error.message, /invalid key/i)
      return true
    }
  )
  assert.equal(seen.length, 2, 'each configured key is tried exactly once')
})
