import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installBackend } from '../src/backend.js'
import { maskValue } from '../src/lib.js'

// Hermetic run: every state read/write goes to a throwaway home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-accounts-'))

const STATE = () => join(process.env.DSH_HOME, 'tavily-manager.json')
const routes = new Map()

const KEY_A = 'tvly-dev-aaaaaaaaaaaaaaaa'
const KEY_B = 'tvly-dev-bbbbbbbbbbbbbbbb'
const KEY_C = 'tvly-dev-cccccccccccccccc'
// The usage cache is module-scoped and keyed by the raw key, so the tests that
// must reach the network use their own keys rather than another test's.
const KEY_INFER_A = 'tvly-dev-iiiiaaaaaaaaaaaa1111'
const KEY_INFER_B = 'tvly-dev-iiiibbbbbbbbbbbb2222'
const KEY_INFER_C = 'tvly-dev-iiiicccccccccccc3333'
const KEY_PIN = 'tvly-dev-ppppaaaaaaaaaaaa1111'
const KEY_PIN2 = 'tvly-dev-ppppbbbbbbbbbbbb2222'
const KEY_RATE = 'tvly-dev-rrrrrrrrrrrrrrrr9999'
const KEY_LAST = 'tvly-dev-llllllllllllllll8888'

const ACCOUNT_ONE = {
  current_plan: 'Researcher', plan_usage: 522, plan_limit: 1000, paygo_usage: 0, paygo_limit: null,
  search_usage: 377, extract_usage: 112, map_usage: 33, crawl_usage: 0, research_usage: 0,
}
const ACCOUNT_TWO = {
  current_plan: 'Researcher', plan_usage: 1000, plan_limit: 1000, paygo_usage: 0, paygo_limit: null,
  search_usage: 846, extract_usage: 129, map_usage: 23, crawl_usage: 2, research_usage: 0,
}

/** One shared Home for the whole file; each test starts from a clean state file. */
function freshState(initial) {
  writeFileSync(STATE(), JSON.stringify(initial ?? {}, null, 2))
}

function stubContext(values = {}) {
  const store = new Map(Object.entries(values))
  const sets = []
  const credentials = {
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) { return { configured: store.has(ref), source: 'file', writable: true } },
    async set(ref, value) { sets.push({ ref, value }); store.set(ref, value) },
    async unset(ref) { sets.push({ ref }); store.delete(ref) },
  }
  installBackend({
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect(run) { run(); return () => {} },
    webServer: { register(entry) { routes.set(entry.path, entry.handler); return () => {} } },
  })
  return { credentials, sets }
}

function callRoute(path, init = {}) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} not registered`)
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code },
      end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) },
    }
    const req = new EventEmitter()
    req.method = init.method ?? 'GET'
    req.url = path + (init.query ?? '')
    process.nextTick(() => {
      if (init.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(init.body)))
      req.emit('end')
    })
    handler(req, res)
  })
}

function usageOk(account, usage) {
  return { status: 200, ok: true, async json() { return { account, key: { usage, limit: account.plan_limit } } } }
}

function usage429(retryAfter) {
  return {
    status: 429,
    ok: false,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? String(retryAfter) : null) },
    async json() { return { detail: { error: 'excessive requests' } } },
  }
}

test('a load-balance save keeps its strategy and cap', async () => {
  freshState()
  stubContext({ TAVILY_API_KEYS: `${KEY_A},${KEY_B}` })
  const res = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [], strategy: 'load-balance', accountCap: 2 } })

  assert.equal(res.status, 200)
  assert.equal(res.body.strategy, 'load-balance', 'load-balance is a strategy, not a typo to be coerced to rotate')
  assert.equal(res.body.accountCap, 2)
  const state = JSON.parse(readFileSync(STATE(), 'utf8'))
  assert.equal(state.strategy, 'load-balance')
  assert.equal(state.accountCap, 2)
})

test('the cap is clamped, and a later save does not wipe the account map', async () => {
  freshState({
    strategy: 'load-balance',
    accountCap: 2,
    accounts: { [maskValue(KEY_A)]: { group: 'acct-1', manual: false } },
  })
  stubContext({ TAVILY_API_KEYS: `${KEY_A},${KEY_B}` })

  const wild = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [], strategy: 'load-balance', accountCap: 99 } })
  assert.equal(wild.body.accountCap, 8, 'the cap is bounded')

  const later = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [], strategy: 'rotate' } })
  assert.equal(later.body.strategy, 'rotate')
  const state = JSON.parse(readFileSync(STATE(), 'utf8'))
  assert.deepEqual(state.accounts, { [maskValue(KEY_A)]: { group: 'acct-1', manual: false } },
    'saving a strategy must not discard the account grouping')
  assert.equal(state.accountCap, 8, 'and must not discard the cap')
})

test('load-balance does not spend usage calls re-sorting keys', async (t) => {
  freshState()
  stubContext({ TAVILY_API_KEYS: KEY_A })
  let upstream = 0
  t.mock.method(globalThis, 'fetch', async () => { upstream += 1; return usageOk(ACCOUNT_ONE, 500) })

  await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [KEY_B], remove: [], strategy: 'load-balance' } })

  assert.equal(upstream, 0, 'load-balance keeps the list order, so it must not fetch usage to sort')
})

test('the usage route infers account groups and persists them', async (t) => {
  freshState()
  stubContext({ TAVILY_API_KEYS: `${KEY_INFER_A},${KEY_INFER_B},${KEY_INFER_C}` })
  const blocks = { [KEY_INFER_A]: ACCOUNT_ONE, [KEY_INFER_B]: ACCOUNT_TWO, [KEY_INFER_C]: ACCOUNT_TWO }
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const key = init.headers.authorization.replace('Bearer ', '')
    return usageOk(blocks[key], blocks[key].plan_usage)
  })

  const res = await callRoute('/api/tavily-usage')

  assert.equal(res.status, 200)
  assert.equal(res.body.accounts[maskValue(KEY_INFER_A)].group, 'acct-1')
  assert.equal(res.body.accounts[maskValue(KEY_INFER_B)].group, 'acct-2')
  assert.equal(res.body.accounts[maskValue(KEY_INFER_C)].group, 'acct-2', 'B and C report one account, so they group together')
  const state = JSON.parse(readFileSync(STATE(), 'utf8'))
  assert.deepEqual(state.accounts, res.body.accounts, 'the inference is persisted for the tools half to read')
})

test('an account can be pinned by hand and released back to auto', async () => {
  freshState({ strategy: 'load-balance', accountCap: 1 })
  stubContext({ TAVILY_API_KEYS: `${KEY_PIN},${KEY_PIN2}` })
  const masked = maskValue(KEY_PIN)

  const pinned = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [], strategy: 'load-balance', accounts: { [masked]: 'own' } } })
  assert.deepEqual(pinned.body.accounts[masked], { group: 'own:' + masked, manual: true })
  assert.deepEqual(JSON.parse(readFileSync(STATE(), 'utf8')).accounts[masked], { group: 'own:' + masked, manual: true })

  const released = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [], strategy: 'load-balance', accounts: { [masked]: 'auto' } } })
  assert.equal(released.body.accounts[masked], undefined, 'auto drops the pin so the next scan can infer it again')
})

test('a rate-limited usage endpoint is not hammered', async (t) => {
  freshState()
  stubContext({ TAVILY_API_KEYS: KEY_RATE })
  let upstream = 0
  t.mock.method(globalThis, 'fetch', async () => { upstream += 1; return usage429(60) })

  const first = await callRoute('/api/tavily-usage')
  const second = await callRoute('/api/tavily-usage')
  const third = await callRoute('/api/tavily-usage')

  assert.equal(upstream, 1, 'the 429 and its Retry-After must stop the retry loop, not repeat it per refresh')
  assert.equal(first.status, 200, 'the card still gets an answer')
  assert.equal(first.body.perKey[0].ok, false)
  assert.equal(second.body.perKey[0].ok, false)
  assert.equal(third.body.perKey[0].ok, false)
})

test('a refusal keeps serving the numbers already loaded', async (t) => {
  freshState()
  stubContext({ TAVILY_API_KEYS: KEY_LAST })
  let upstream = 0
  t.mock.method(globalThis, 'fetch', async () => {
    upstream += 1
    return upstream === 1 ? usageOk(ACCOUNT_ONE, 522) : usage429(600)
  })
  const { ageUsageCache } = await import('../src/backend.js')

  const good = await callRoute('/api/tavily-usage')
  assert.equal(good.body.perKey[0].usage, 522)

  ageUsageCache(10 * 60 * 1000)
  const refused = await callRoute('/api/tavily-usage')

  assert.equal(upstream, 2, 'the aged entry is refreshed once')
  assert.equal(refused.body.perKey[0].ok, true, 'a rate limit on the refresh must not blank the card')
  assert.equal(refused.body.perKey[0].usage, 522, 'the last good numbers are the answer')
})
