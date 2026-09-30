import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { maskValue } from '../src/lib.js'

// `load-balance` keeps at most `accountCap` requests in flight per Tavily
// account, and spreads concurrent calls across accounts. Tavily's limits are
// per environment/key (a free Development key gets 100 requests/minute) and
// every key on one account shares that budget and its credit pool, so hitting
// one free account in parallel is the thing to avoid. Grouping comes from the
// state file the usage route writes; a key with no group is its own account.

const KEY_A = 'tvly-dev-aaaaaaaaaaaaaaaa1111'
const KEY_B = 'tvly-dev-bbbbbbbbbbbbbbbb2222'
const KEY_C = 'tvly-dev-cccccccccccccccc3333'
const authOf = (key) => 'Bearer ' + key
const MASK_A = maskValue(KEY_A)
const MASK_B = maskValue(KEY_B)
const MASK_C = maskValue(KEY_C)

function bench(keys) {
  const tools = []
  const routes = new Map()
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
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    get: (key) => (key === 'credentials' ? credentials : undefined),
    effect(callback) { callback() },
  }
  apply(ctx)
  return { tools }
}

/** Install a state file for this test and point DSH_HOME at it. */
function useState(t, state) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-lb-'))
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'tavily-manager.json'), JSON.stringify(state, null, 2))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  })
  return home
}

/**
 * Stub `fetch` and record how many requests were in flight at once, overall,
 * per key and per account group.
 */
function trackFetch(t, groupOfKey, options = {}) {
  const delayMs = options.delayMs ?? 15
  const state = { maxOverall: 0, perKey: new Map(), perGroup: new Map(), maxPerKey: new Map(), maxPerGroup: new Map(), keys: [] }
  let inFlight = 0

  const bump = (map, name, delta) => {
    const next = (map.get(name) ?? 0) + delta
    map.set(name, next)
    return next
  }

  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const key = init.headers.authorization
    const group = groupOfKey(key)
    state.keys.push(key)
    inFlight += 1
    const keyNow = bump(state.perKey, key, 1)
    const groupNow = bump(state.perGroup, group, 1)
    state.maxPerKey.set(key, Math.max(state.maxPerKey.get(key) ?? 0, keyNow))
    state.maxPerGroup.set(group, Math.max(state.maxPerGroup.get(group) ?? 0, groupNow))
    state.maxOverall = Math.max(state.maxOverall, inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { status: 200, ok: true, async json() { return { results: [{ url: 'https://a.example' }] } } }
    } finally {
      bump(state.perKey, key, -1)
      bump(state.perGroup, group, -1)
      inFlight -= 1
    }
  })

  return state
}

const search = (tools) => tools.find((definition) => definition.name === 'tavily_search')

test('two keys on one account never run concurrently under load-balance', async (t) => {
  useState(t, {
    strategy: 'load-balance',
    accountCap: 1,
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-1', manual: false } },
  })
  const groups = { [authOf(KEY_A)]: 'acct-1', [authOf(KEY_B)]: 'acct-1' }
  const state = trackFetch(t, (key) => groups[key] ?? 'unknown')
  const { tools } = bench([KEY_A, KEY_B])

  const results = await Promise.all([1, 2, 3].map(() => search(tools).execute({ query: 'x' }, {})))

  assert.equal(results.length, 3)
  assert.equal(state.maxPerGroup.get('acct-1'), 1, 'one free account must never see two requests at once')
  assert.equal(state.keys.length, 3, 'all three calls still get their answer, one after the other')
})

test('keys on different accounts run concurrently (the load spreads)', async (t) => {
  useState(t, {
    strategy: 'load-balance',
    accountCap: 1,
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-2', manual: false } },
  })
  const groups = { [authOf(KEY_A)]: 'acct-1', [authOf(KEY_B)]: 'acct-2' }
  const state = trackFetch(t, (key) => groups[key] ?? 'unknown')
  const { tools } = bench([KEY_A, KEY_B])

  await Promise.all([1, 2].map(() => search(tools).execute({ query: 'x' }, {})))

  assert.equal(state.maxOverall, 2, 'separate accounts may be hit in parallel')
  assert.ok(state.keys.includes(authOf(KEY_A)) && state.keys.includes(authOf(KEY_B)), 'the second call took the idle account')
})

test('the cap is per account, so cap 2 lets one account run two at a time', async (t) => {
  useState(t, {
    strategy: 'load-balance',
    accountCap: 2,
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-1', manual: false } },
  })
  const groups = { [authOf(KEY_A)]: 'acct-1', [authOf(KEY_B)]: 'acct-1' }
  const state = trackFetch(t, (key) => groups[key] ?? 'unknown')
  const { tools } = bench([KEY_A, KEY_B])

  await Promise.all([1, 2, 3].map(() => search(tools).execute({ query: 'x' }, {})))

  assert.equal(state.maxPerGroup.get('acct-1'), 2, 'the configured cap is the ceiling')
  assert.equal(state.keys.length, 3)
})

test('a key with no group is its own account', async (t) => {
  useState(t, { strategy: 'load-balance', accountCap: 1, accounts: {} })
  const state = trackFetch(t, (key) => 'own:' + key)
  const { tools } = bench([KEY_A, KEY_B])

  await Promise.all([1, 2].map(() => search(tools).execute({ query: 'x' }, {})))

  assert.equal(state.maxOverall, 2, 'without account data the cap still applies per key, and keys are parallel-safe')
  assert.equal(state.maxPerKey.get(authOf(KEY_A)), 1)
  assert.equal(state.maxPerKey.get(authOf(KEY_B)), 1)
})

test('rotate is untouched: the account cap is not applied at all', async (t) => {
  // Both keys are grouped, so a mode that ignored the strategy would serialize
  // these two calls. Under rotate they must run together, exactly as before.
  useState(t, {
    strategy: 'rotate',
    accountCap: 1,
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-1', manual: false } },
  })
  const groups = { [authOf(KEY_A)]: 'acct-1', [authOf(KEY_B)]: 'acct-1' }
  const state = trackFetch(t, (key) => groups[key] ?? 'unknown')
  const { tools } = bench([KEY_A, KEY_B])

  await Promise.all([1, 2].map(() => search(tools).execute({ query: 'x' }, {})))

  assert.equal(state.maxPerGroup.get('acct-1'), 2,
    'rotate keeps its existing behaviour: parallel calls are not queued behind an account cap')
})

test('a queued call that is aborted rejects instead of hanging', async (t) => {
  useState(t, {
    strategy: 'load-balance',
    accountCap: 1,
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-1', manual: false } },
  })
  trackFetch(t, () => 'acct-1', { delayMs: 40 })
  const { tools } = bench([KEY_A, KEY_B])

  const controller = new AbortController()
  const first = search(tools).execute({ query: 'first' }, {})
  const second = search(tools).execute({ query: 'second' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  const settled = await Promise.allSettled([first, second])
  assert.equal(settled[0].status, 'fulfilled', 'the in-flight call still completes')
  assert.equal(settled[1].status, 'rejected', 'the queued call must not wait forever')
  assert.match(String(settled[1].reason && settled[1].reason.message), /abort/i)
})
