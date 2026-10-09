import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installTavilyTool } from '../src/tools.js'

// Research is the one asynchronous Tavily capability: `POST /research` queues a
// task and `GET /research/{request_id}` reports progress. These tests drive the
// real tools against a recording fetch, so the queue -> poll -> report loop, the
// owning-key rule and the failure paths are exercised, not restated.

const KEY_A = 'tvly-dev-aaaaaaaaaaaaaaaa1111'
const KEY_B = 'tvly-dev-bbbbbbbbbbbbbbbb2222'

/** Install the tool half with `keys` configured; returns the tool registry. */
function bench(keys, options = {}) {
  const tools = []
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
        return () => { const index = tools.indexOf(definition); if (index >= 0) tools.splice(index, 1) }
      },
    },
    credentials,
    get: (key) => (key === 'credentials' ? credentials : undefined),
    effect(callback) { callback() },
  }
  installTavilyTool(ctx, { pollIntervalMs: 1, ...options })
  return { tools }
}

/** Keep `resolveDshHome()` inside a scratch directory for the duration. */
function useHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-research-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  })
  return home
}

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body } })
const toolNamed = (installed, name) => installed.tools.find((definition) => definition.name === name)

test('tavily_research queues the task, polls it, and returns the finished report', async (t) => {
  useHome(t)
  const requests = []
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (!String(url).includes('/research/')) {
      return res(200, {
        request_id: 'r-1',
        status: 'pending',
        created_at: '2026-10-09T11:34:12.588249+00:00',
        model: 'mini',
        response_time: 0.05,
      })
    }
    polls += 1
    if (polls === 1) return res(200, { request_id: 'r-1', status: 'in_progress', response_time: 0.01 })
    return res(200, {
      request_id: 'r-1',
      status: 'completed',
      created_at: '2026-10-09T11:34:12.585747+00:00',
      content: 'A 404 is temporary; a 410 is permanent [1].',
      sources: [{ url: 'https://developer.mozilla.org/404', title: '404 Not Found', favicon: 'f.ico' }],
      response_time: 12.71,
      usage: { credits: 7 },
    })
  })

  const value = await toolNamed(bench([KEY_A]), 'tavily_research').execute({ input: '404 vs 410', model: 'mini' }, {})

  assert.equal(value.status, 'completed')
  assert.equal(value.requestId, 'r-1')
  assert.equal(value.content, 'A 404 is temporary; a 410 is permanent [1].')
  assert.equal(value.credits, 7)
  assert.deepEqual(value.sources, [{ url: 'https://developer.mozilla.org/404', title: '404 Not Found', favicon: 'f.ico' }])
  assert.equal(value.note, undefined)
  assert.equal(polls, 2, 'an in_progress answer is polled again')

  assert.equal(requests[0].method, 'POST')
  assert.ok(requests[0].url.endsWith('/research'), requests[0].url)
  assert.deepEqual(requests[0].body, { input: '404 vs 410', model: 'mini' })
  assert.ok(requests[1].url.includes('/research/r-1'), requests[1].url)
  assert.ok(requests[1].url.includes('include_usage=true'), 'the retrieve asks for credit usage')
  assert.equal(requests[1].auth, requests[0].auth, 'polling reuses the key that owns the task')
})

test('timeout_seconds: 0 queues the task and hands the id back without polling', async (t) => {
  useHome(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return res(200, { request_id: 'r-2', status: 'pending', model: 'pro', response_time: 0.05 })
  })

  const value = await toolNamed(bench([KEY_A]), 'tavily_research').execute({ input: 'broad question', model: 'pro', timeout_seconds: 0 }, {})

  assert.equal(calls, 1, 'no polling request is made')
  assert.equal(value.status, 'pending')
  assert.equal(value.requestId, 'r-2')
  assert.match(value.note, /tavily_get_research/)
  assert.match(value.note, /Queued without waiting/)
})

test('tavily_get_research steps past keys that do not own the task', async (t) => {
  useHome(t)
  const auths = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    auths.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer ' + KEY_A) {
      return res(404, { detail: 'No research task found for this request ID' })
    }
    return res(200, { request_id: 'r-9', status: 'completed', content: 'report' })
  })

  const value = await toolNamed(bench([KEY_A, KEY_B]), 'tavily_get_research').execute({ request_id: 'r-9' }, {})

  assert.equal(value.status, 'completed')
  assert.equal(value.content, 'report')
  assert.deepEqual(auths, ['Bearer ' + KEY_A, 'Bearer ' + KEY_B], 'the second key is asked after the first 404s')
})

test('tavily_get_research reports a task no configured key knows', async (t) => {
  useHome(t)
  t.mock.method(globalThis, 'fetch', async () => res(404, { detail: 'No research task found for this request ID' }))

  await assert.rejects(
    () => toolNamed(bench([KEY_A, KEY_B]), 'tavily_get_research').execute({ request_id: 'missing' }, {}),
    /no configured key knows request missing/
  )
})

test('a create that a key rate-limits rotates, and polling keeps the key that queued it', async (t) => {
  useHome(t)
  const auths = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    auths.push(init.headers.authorization)
    if (auths.length === 1) return res(429, { detail: { error: 'too many requests' } })
    if (auths.length === 2) return res(200, { request_id: 'r-3', status: 'pending', model: 'mini' })
    return res(200, { request_id: 'r-3', status: 'completed', content: 'done' })
  })

  const value = await toolNamed(bench([KEY_A, KEY_B]), 'tavily_research').execute({ input: 'q', model: 'mini' }, {})

  assert.equal(value.status, 'completed')
  assert.deepEqual(auths, ['Bearer ' + KEY_A, 'Bearer ' + KEY_B, 'Bearer ' + KEY_B],
    'the second key queues the task and is the one polled')
})

test('all keys rate-limited at create reports the pool, not one key', async (t) => {
  useHome(t)
  t.mock.method(globalThis, 'fetch', async () => res(429, { detail: { error: 'too many requests' } }))

  await assert.rejects(
    () => toolNamed(bench([KEY_A, KEY_B]), 'tavily_research').execute({ input: 'q' }, {}),
    /all 2 configured key\(s\) failed with HTTP 429/
  )
})

test('a stream-only account gets an actionable error instead of a raw 400', async (t) => {
  useHome(t)
  t.mock.method(globalThis, 'fetch', async () => res(400, {
    detail: { error: 'streaming is required for this request', error_code: 'research_stream_required' },
  }))

  await assert.rejects(
    () => toolNamed(bench([KEY_A]), 'tavily_research').execute({ input: 'q' }, {}),
    /requires streamed research/
  )
})

test('a poll that starts failing hands back the id rather than losing the report', async (t) => {
  useHome(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    if (calls === 1) return res(200, { request_id: 'r-4', status: 'pending', model: 'pro' })
    return res(429, { detail: { error: 'rate limited' } })
  })

  const value = await toolNamed(bench([KEY_A]), 'tavily_research').execute({ input: 'q', model: 'pro' }, {})

  assert.equal(value.status, 'pending')
  assert.equal(value.requestId, 'r-4')
  assert.match(value.note, /Polling stopped after HTTP 429/)
  assert.match(value.note, /tavily_get_research/)
})

test('an aborted wait rejects instead of hanging', async (t) => {
  useHome(t)
  t.mock.method(globalThis, 'fetch', async () => res(200, { request_id: 'r-5', status: 'in_progress' }))

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(
    () => toolNamed(bench([KEY_A]), 'tavily_research').execute({ input: 'q' }, { signal: controller.signal }),
    /aborted while waiting/
  )
})
