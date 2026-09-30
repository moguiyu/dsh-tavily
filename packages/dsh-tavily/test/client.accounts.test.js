import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  byClass,
  createHarness,
  flush,
  jsonResponse,
  optionValues,
  selectByClass,
  textOf,
} from '../test-support/client-harness.js'

// The card is where the load-balancing policy is chosen: which strategy, how
// many requests may be in flight per account, and — when the inference from
// Tavily's usage counters is wrong — which keys really share an account.

const MASK_A = 'tvly-dev-9UP…aEfc'
const MASK_B = 'tvly-dev-azX…0FFz'

function managerPayload(options = {}) {
  return {
    ok: true,
    keys: [
      { masked: MASK_A, savedAt: '2026-08-16T11:25:59.291Z', primary: true, removable: true },
      { masked: MASK_B, savedAt: '2026-08-16T11:39:21.896Z', primary: false, removable: true },
    ],
    strategy: options.strategy ?? 'rotate',
    accounts: options.accounts ?? {},
    accountCap: options.accountCap ?? 1,
    writable: { keys: true, primary: false },
  }
}

function usagePayload(options = {}) {
  return {
    ok: true,
    perKey: [
      { ok: true, masked: MASK_A, usage: 522, planUsage: 522, planLimit: 1000 },
      { ok: true, masked: MASK_B, usage: 439, planUsage: 439, planLimit: 1000 },
    ],
    accounts: options.accounts ?? {},
    accountCap: options.accountCap ?? 1,
    totals: { keys: 2, okKeys: 2, usage: 961, planUsage: 961, planLimit: 2000 },
  }
}

function mount(t, options = {}) {
  const posts = []
  const harness = createHarness(t, {
    routes: {
      '/api/tavily-manager': (init) => {
        if (init !== undefined && init.method === 'POST') {
          posts.push(JSON.parse(init.body))
          return jsonResponse({ ok: true, ...managerPayload(options) })
        }
        return jsonResponse(managerPayload(options))
      },
      '/api/tavily-usage': () => jsonResponse(usagePayload(options)),
    },
  })
  harness.render()
  return { harness, posts }
}

const accountSelect = (element, masked) =>
  byClass(element, 'dts-account').find((node) => node.props['data-masked'] === masked)

test('load balance is offered as a strategy, with a hint that says what it does', async (t) => {
  const { harness } = mount(t, { strategy: 'rotate' })
  await flush()
  harness.render()

  const strategy = selectByClass(harness.element(), 'dts-strategy')
  assert.ok(strategy, 'the strategy selector must render')
  assert.ok(optionValues(strategy).includes('load-balance'), 'load-balance must be selectable')
  assert.ok(optionValues(strategy).includes('rotate'), 'the existing strategies stay')

  const balanced = mount(t, { strategy: 'load-balance' })
  await flush()
  balanced.harness.render()
  const hint = textOf(balanced.harness.element())
  assert.match(hint, /in flight/i, 'the hint must explain the per-account concurrency cap')
  assert.match(hint, /account/i)
})

test('each key shows the account it was grouped into', async (t) => {
  const { harness } = mount(t, {
    strategy: 'load-balance',
    accounts: {
      [MASK_A]: { group: 'acct-1', manual: false },
      [MASK_B]: { group: 'acct-2', manual: false },
    },
  })
  await flush()
  harness.render()

  const chips = byClass(harness.element(), 'dts-account-chip').map(textOf)
  assert.deepEqual(chips, ['Account 1', 'Account 2'])
  assert.equal(accountSelect(harness.element(), MASK_A).props.value, 'auto', 'an inferred group is not a manual choice')
  assert.ok(optionValues(accountSelect(harness.element(), MASK_A)).includes('own'), 'a key can be forced into its own account')
})

test('a pinned key reads as separate instead of auto', async (t) => {
  const { harness } = mount(t, {
    strategy: 'load-balance',
    accounts: {
      [MASK_A]: { group: 'acct-1', manual: false },
      [MASK_B]: { group: 'own:' + MASK_B, manual: true },
    },
  })
  await flush()
  harness.render()

  assert.deepEqual(byClass(harness.element(), 'dts-account-chip').map(textOf), ['Account 1', 'Separate'])
  assert.equal(accountSelect(harness.element(), MASK_B).props.value, 'own')
})

test('pinning an account posts the override and refreshes', async (t) => {
  const { harness, posts } = mount(t, {
    strategy: 'load-balance',
    accounts: { [MASK_A]: { group: 'acct-1', manual: false }, [MASK_B]: { group: 'acct-1', manual: false } },
  })
  await flush()
  harness.render()

  const select = accountSelect(harness.element(), MASK_B)
  const before = harness.requests.length
  select.props.onChange({ target: { value: 'own' } })
  await flush()
  await flush()

  assert.equal(posts.length, 1, 'the choice must be saved')
  assert.deepEqual(posts[0].accounts, { [MASK_B]: 'own' })
  assert.equal(posts[0].strategy, 'load-balance', 'the rest of the policy rides along unchanged')
  assert.ok(harness.requests.length > before, 'and the card reloads the grouping afterwards')
})

test('the cap control appears only for load balance', async (t) => {
  const { harness } = mount(t, { strategy: 'rotate' })
  await flush()
  harness.render()
  assert.equal(selectByClass(harness.element(), 'dts-account-cap'), null,
    'the cap means nothing while another strategy is selected, so it must not be offered')

  const balanced = mount(t, { strategy: 'load-balance', accountCap: 2 })
  await flush()
  balanced.harness.render()
  const cap = selectByClass(balanced.harness.element(), 'dts-account-cap')
  assert.ok(cap, 'load balance must offer the cap')
  assert.equal(cap.props.value, '2', 'and show the stored value')
  assert.deepEqual(optionValues(cap), ['1', '2', '3', '4', '5', '6', '7', '8'])
})

test('changing the cap posts it', async (t) => {
  const { harness, posts } = mount(t, { strategy: 'load-balance', accountCap: 1 })
  await flush()
  harness.render()

  selectByClass(harness.element(), 'dts-account-cap').props.onChange({ target: { value: '4' } })
  await flush()
  await flush()

  assert.equal(posts.length, 1)
  assert.equal(posts[0].accountCap, 4)
  assert.equal(posts[0].strategy, 'load-balance')
})
