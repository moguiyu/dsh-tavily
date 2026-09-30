import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ACCOUNT_CAP,
  MAX_ACCOUNT_CAP,
  STRATEGIES,
  accountFingerprint,
  clampAccountCap,
  groupAccounts,
  isValidStrategy,
  orderKeys,
} from '../src/lib.js'

// Tavily publishes no account identifier, and its rate limits are per
// environment/key rather than per key — so two keys can share one account's
// 100 requests/minute and one credit pool. The only account-level signal the
// API returns is the `account` block of `/usage`, where every key of one
// account reports the *same* counters at the same moment (observed live: two
// keys both reporting search_usage 846 / extract 129 / map 23). These helpers
// turn that into stable group ids the tools half can act on.

const ACCOUNT_A = {
  current_plan: 'Researcher',
  plan_usage: 522,
  plan_limit: 1000,
  paygo_usage: 0,
  paygo_limit: null,
  search_usage: 377,
  extract_usage: 112,
  map_usage: 33,
  crawl_usage: 0,
  research_usage: 0,
}

const ACCOUNT_B = {
  current_plan: 'Researcher',
  plan_usage: 1000,
  plan_limit: 1000,
  paygo_usage: 0,
  paygo_limit: null,
  search_usage: 846,
  extract_usage: 129,
  map_usage: 23,
  crawl_usage: 2,
  research_usage: 0,
}

const K1 = 'tvly-dev-9UP…aEfc'
const K2 = 'tvly-dev-azX…0FFz'
const K3 = 'tvly-dev-YV1…3KrF'

test('load-balance is a valid strategy alongside the ordering ones', () => {
  assert.deepEqual(STRATEGIES, ['rotate', 'low-usage-first', 'high-usage-first', 'load-balance'])
  assert.equal(isValidStrategy('load-balance'), true)
  assert.equal(isValidStrategy('balanced'), false)
})

test('clampAccountCap keeps the per-account cap usable', () => {
  assert.equal(DEFAULT_ACCOUNT_CAP, 1)
  assert.equal(clampAccountCap(undefined), 1)
  assert.equal(clampAccountCap(0), 1)
  assert.equal(clampAccountCap('3'), 3)
  assert.equal(clampAccountCap(2.6), 3)
  assert.equal(clampAccountCap(99), MAX_ACCOUNT_CAP)
  assert.equal(clampAccountCap('nonsense'), 1)
})

test('accountFingerprint: one account, one fingerprint', () => {
  const same = accountFingerprint({ ...ACCOUNT_B, paygo_limit: null })
  assert.equal(accountFingerprint(ACCOUNT_B), same, 'field order must not matter')
  assert.notEqual(accountFingerprint(ACCOUNT_A), accountFingerprint(ACCOUNT_B))
})

test('accountFingerprint is null when the block says nothing usable', () => {
  assert.equal(accountFingerprint(null), null)
  assert.equal(accountFingerprint(undefined), null)
  assert.equal(accountFingerprint({}), null)
  assert.equal(accountFingerprint({ unrelated: 1 }), null)
})

test('groupAccounts clusters keys that share an account', () => {
  const accounts = groupAccounts(
    [
      { masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
      { masked: K3, fingerprint: accountFingerprint(ACCOUNT_B) },
    ],
    {}
  )

  assert.equal(accounts[K1].group, 'acct-1')
  assert.equal(accounts[K2].group, 'acct-2')
  assert.equal(accounts[K3].group, 'acct-2', 'K2 and K3 are the same account')
  assert.deepEqual(accounts[K2].manual, false)
})

test('groupAccounts assigns ids in the stored list order and reuses them', () => {
  const first = groupAccounts(
    [
      { masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
    ],
    {}
  )
  assert.deepEqual(Object.keys(first), [K1, K2])
  assert.deepEqual(groupAccounts(
    [
      { masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
    ],
    first
  ), first, 'a re-run must not renumber the accounts')

  const grown = groupAccounts(
    [
      { masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
      { masked: K3, fingerprint: accountFingerprint(ACCOUNT_B) },
    ],
    first
  )
  assert.equal(grown[K1].group, 'acct-1', 'the existing group id survives a new key')
  assert.equal(grown[K3].group, 'acct-2')
})

test('groupAccounts keeps manual assignments, and infers their siblings into the same group', () => {
  const previous = {
    [K1]: { group: 'own:K1', manual: true },
    [K2]: { group: 'acct-1', manual: false },
  }
  const accounts = groupAccounts(
    [
      { masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
      { masked: K3, fingerprint: accountFingerprint(ACCOUNT_A) },
    ],
    previous
  )

  assert.deepEqual(accounts[K1], { group: 'own:K1', manual: true }, 'a manual pin is never rewritten')
  assert.equal(accounts[K3].group, 'own:K1', 'K3 shares K1s account, so it joins the pinned group')
  assert.equal(accounts[K2].group, 'acct-1')
})

test('groupAccounts leaves a key without account data ungrouped', () => {
  const accounts = groupAccounts(
    [
      { masked: K1, fingerprint: null },
      { masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) },
    ],
    {}
  )
  assert.equal(accounts[K1], undefined, 'no fingerprint means no claim about the account')
  assert.equal(accounts[K2].group, 'acct-1')
})

test('groupAccounts drops keys that are no longer stored', () => {
  const previous = {
    [K1]: { group: 'acct-1', manual: false },
    [K2]: { group: 'acct-2', manual: false },
  }
  const accounts = groupAccounts([{ masked: K2, fingerprint: accountFingerprint(ACCOUNT_B) }], previous)
  assert.deepEqual(Object.keys(accounts), [K2])
})

test('groupAccounts tolerates a previous map full of junk', () => {
  const accounts = groupAccounts(
    [{ masked: K1, fingerprint: accountFingerprint(ACCOUNT_A) }],
    { [K1]: 'nonsense', [K2]: { group: 42, manual: true } }
  )
  assert.deepEqual(accounts[K1], { group: 'acct-1', manual: false })
})

test('orderKeys: load-balance keeps the given order, like rotate', () => {
  const values = ['b', 'a', 'c']
  const usageOf = (value) => ({ a: 90, b: 10, c: 50 })[value]
  assert.deepEqual(orderKeys(values, 'load-balance', usageOf), ['b', 'a', 'c'],
    'load balancing is about concurrency, not ordering, so it must not re-sort the list')
  assert.deepEqual(orderKeys(values, 'low-usage-first', usageOf), ['b', 'c', 'a'])
})
