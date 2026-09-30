import assert from 'node:assert/strict'
import { test } from 'node:test'

import { factory } from '../src/client.js'

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
const FRAGMENT = 'test-fragment'

function jsonResponse(value) {
  return { ok: true, async json() { return value } }
}

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    map,
  }
}

function managerPayload() {
  return {
    ok: true,
    keys: [
      { masked: MASK, savedAt: '2026-08-16T11:25:59.291Z', primary: true, removable: true },
      { masked: OTHER_MASK, savedAt: '2026-08-16T11:39:21.896Z', primary: false, removable: true },
    ],
    strategy: 'low-usage-first',
    writable: { keys: true, primary: false },
  }
}

function usagePayload(planUsage) {
  return {
    ok: true,
    perKey: [{ ok: true, masked: MASK, usage: planUsage, planUsage, planLimit: 1000 }],
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

/** A deferred promise plus the resolver, for staging slow responses. */
function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

function createHarness(t, options = {}) {
  const requests = []
  const frames = []
  const hooks = []
  const effectDeps = new Map()
  const effectCleanups = new Map()
  const memo = new Map()
  let cursor = 0
  let dirty = false
  let scheduled = []
  let element = null
  const routes = options.routes || {}

  const saved = {
    fetch: globalThis.fetch,
    window: globalThis.window,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  }
  t.after(() => {
    globalThis.fetch = saved.fetch
    if (saved.window === undefined) delete globalThis.window
    else globalThis.window = saved.window
    if (saved.raf === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = saved.raf
    if (saved.caf === undefined) delete globalThis.cancelAnimationFrame
    else globalThis.cancelAnimationFrame = saved.caf
  })

  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { localStorage: options.storage }
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('?')[0]
    requests.push({ path, init })
    const route = routes[path]
    if (route === undefined) throw new Error('unrouted request: ' + path)
    return route()
  }

  const react = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props)
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
        dirty = true
      }
      return [hooks[index], set]
    },
    useEffect(callback, deps) {
      const index = cursor++
      const previous = effectDeps.get(index)
      const changed = previous === undefined || deps === undefined ||
        deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))
      if (!changed) return
      effectDeps.set(index, deps)
      const cleanup = effectCleanups.get(index)
      if (cleanup !== undefined) cleanup()
      scheduled.push(() => { effectCleanups.set(index, callback()) })
    },
    useCallback(callback, deps) {
      const index = cursor++
      const previous = memo.get(index)
      if (previous !== undefined && deps !== undefined &&
        deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        return previous.value
      }
      memo.set(index, { deps, value: callback })
      return callback
    },
    useMemo(factoryFn, deps) {
      const index = cursor++
      const previous = memo.get(index)
      if (previous !== undefined && deps !== undefined &&
        deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        return previous.value
      }
      const value = factoryFn()
      memo.set(index, { deps, value })
      return value
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
  }

  const plugin = factory((name) => (name === 'react' ? react : {}))
  let component = null
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (options_, registered) => { component = registered; return () => {} },
    },
  }
  plugin.apply(ctx)

  const render = () => {
    let guard = 0
    do {
      dirty = false
      cursor = 0
      scheduled = []
      element = component({ view: 'page' })
      while (scheduled.length > 0) scheduled.shift()()
    } while (dirty && ++guard < 50)
  }

  return {
    requests,
    frames,
    render,
    element: () => element,
    stepFrame(at) {
      const next = frames.shift()
      if (next === undefined) return false
      next(at)
      return true
    },
  }
}

function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (node.type !== FRAGMENT) out.push(node)
    for (const child of node.children || []) flatten(child, out)
  }
  return out
}

function usageButton(element) {
  return flatten(element).find((node) => node.type === 'button' &&
    typeof node.props.title === 'string' && /usage/i.test(node.props.title))
}

function labelOf(button) {
  const span = flatten(button).find((node) => node.type === 'span')
  if (span === undefined) return null
  return span.children.filter((child) => typeof child === 'string').join('')
}

function progressCircle(element) {
  return flatten(element).find((node) => node.type === 'circle' && node.props.strokeDasharray !== undefined)
}

function hasSweepArc(element) {
  return flatten(element).some((node) => node.props.className === 'dts-ring-sweep')
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

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
