import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createHarness,
  deferred,
  flush,
  hasSweepArc,
  jsonResponse,
  labelOf,
  memoryStorage,
  progressCircle,
  usageButton,
} from '../test-support/client-harness.js'

// The usage cell is slow: `/api/tavily-usage` asks Tavily for every key's
// counters. The card must therefore (a) never look "empty" while that is in
// flight, (b) show the last values it already has, (c) animate to the fresh
// numbers when they land, and (d) do it without ever persisting key material.
//
// The tests drive the real component through a small hook-capable React
// stand-in: function components are called eagerly and hooks share one cursor
// sequence, which is enough because rows only ever append after the parent's
// hooks. It is a harness, not a renderer — no DOM, no layout.

const SNAPSHOT_KEY = 'dsh-tavily:usage-snapshot:v1'
const MASK = 'tvly-dev-9UP…aEfc'
const OTHER_MASK = 'tvly-dev-azX…0FFz'

function managerPayload() {
  return {
    ok: true,
    keys: [
      { masked: MASK, savedAt: '2026-08-16T11:25:59.291Z', primary: true, removable: true },
      { masked: OTHER_MASK, savedAt: '2026-08-16T11:39:21.896Z', primary: false, removable: true },
    ],
    strategy: 'low-usage-first',
    accounts: {},
    accountCap: 1,
    writable: { keys: true, primary: false },
  }
}

function usagePayload(planUsage) {
  return {
    ok: true,
    perKey: [{ ok: true, masked: MASK, usage: planUsage, planUsage, planLimit: 1000 }],
    accounts: {},
    accountCap: 1,
    totals: { keys: 1, okKeys: 1, usage: planUsage, planUsage, planLimit: 1000 },
  }
}

function snapshot(planUsage) {
  return JSON.stringify({
    version: 1,
    at: '2026-09-30T02:20:00.000Z',
    rows: { [MASK]: { ok: true, usage: planUsage, planUsage, planLimit: 1000 } },
  })
}

test('the first load with nothing stored announces loading instead of a bare dash', async (t) => {
  const usage = deferred()
  const harness = createHarness(t, {
    routes: {
      '/api/tavily-manager': () => jsonResponse(managerPayload()),
      '/api/tavily-usage': () => usage.promise,
    },
  })

  harness.render()
  await flush()
  harness.render()

  const button = usageButton(harness.element())
  assert.ok(button, 'the usage cell must render')
  assert.equal(button.props['data-loading'], 'true', 'a slow first load is a loading state, not an empty one')
  assert.equal(button.props['aria-busy'], 'true')
  assert.equal(labelOf(button), '—', 'no numbers are known yet')
  assert.ok(hasSweepArc(harness.element()), 'the indeterminate sweep arc marks the in-flight load')
})

test('the last stored usage is shown immediately while the refresh is in flight', async (t) => {
  const usage = deferred()
  const storage = memoryStorage({ [SNAPSHOT_KEY]: snapshot(520) })
  const harness = createHarness(t, {
    storage,
    routes: {
      '/api/tavily-manager': () => jsonResponse(managerPayload()),
      '/api/tavily-usage': () => usage.promise,
    },
  })

  harness.render()
  await flush()
  harness.render()

  const button = usageButton(harness.element())
  assert.equal(labelOf(button), '52%', 'the stored value renders before the network answers')
  assert.equal(button.props['data-stale'], 'true', 'and it is marked as not-yet-refreshed')
  assert.equal(button.props['data-loading'], 'true', 'while still announcing the refresh')
  assert.ok(hasSweepArc(harness.element()))
})

test('fresh usage replaces the stored value, clears loading, and is persisted', async (t) => {
  const storage = memoryStorage({ [SNAPSHOT_KEY]: snapshot(520) })
  const harness = createHarness(t, {
    storage,
    routes: {
      '/api/tavily-manager': () => jsonResponse(managerPayload()),
      '/api/tavily-usage': () => Promise.resolve(jsonResponse(usagePayload(900))),
    },
  })

  harness.render()
  await flush()
  harness.render()

  const button = usageButton(harness.element())
  assert.equal(labelOf(button), '90%', 'the fresh number wins')
  assert.equal(button.props['data-loading'], 'false')
  assert.equal(button.props['data-stale'], 'false')
  assert.equal(hasSweepArc(harness.element()), false, 'the sweep arc goes away when the load settles')

  const stored = JSON.parse(storage.map.get(SNAPSHOT_KEY))
  assert.equal(stored.rows[MASK].planUsage, 900, 'the fresh value becomes the next stale-first value')
  assert.equal(stored.version, 1)
  assert.equal(stored.rows[MASK].planLimit, 1000)
})

test('the ring grows from the stored percent to the fresh percent across frames', async (t) => {
  // Growth needs a value already on screen, so the usage response is staged:
  // the card paints the stored 52% first, then animates to the fresh 90%.
  const usage = deferred()
  const harness = createHarness(t, {
    storage: memoryStorage({ [SNAPSHOT_KEY]: snapshot(520) }),
    routes: {
      '/api/tavily-manager': () => jsonResponse(managerPayload()),
      '/api/tavily-usage': () => usage.promise,
    },
  })

  harness.render()
  await flush()
  harness.render()
  assert.equal(labelOf(usageButton(harness.element())), '52%')

  usage.resolve(jsonResponse(usagePayload(900)))
  await flush()
  harness.render()

  const framesSeen = []
  for (const at of [0, 100, 325, 700]) {
    if (harness.stepFrame(at)) {
      harness.render()
      framesSeen.push(labelOf(usageButton(harness.element())))
    }
  }

  assert.ok(framesSeen.length >= 2, 'the count-up runs across frames')
  assert.ok(
    framesSeen.some((label) => label !== '52%' && label !== '90%'),
    'at least one frame shows an intermediate value, so the growth is animated: ' + JSON.stringify(framesSeen)
  )
  assert.equal(framesSeen[framesSeen.length - 1], '90%', 'the animation lands exactly on the fresh value')

  const progress = progressCircle(harness.element())
  assert.match(String(progress.props.style.transition), /stroke-dashoffset/, 'the ring itself is transitioned, not just the number')
  assert.equal(
    typeof progress.props.style.strokeDashoffset,
    'number',
    'a presentation attribute alone does not reliably transition, so the offset must also be a style value'
  )
})

test('keys and usage are requested in parallel', async (t) => {
  const manager = deferred()
  const usage = deferred()
  const harness = createHarness(t, {
    routes: {
      '/api/tavily-manager': () => manager.promise,
      '/api/tavily-usage': () => usage.promise,
    },
  })

  harness.render()
  await flush()

  assert.deepEqual(
    harness.requests.map((request) => request.path),
    ['/api/tavily-manager', '/api/tavily-usage'],
    'the slow usage endpoint must not wait for the keys endpoint'
  )
})
