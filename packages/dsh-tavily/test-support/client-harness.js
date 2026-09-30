import { factory } from '../src/client.js'

// Shared harness for the card's tests. It is deliberately NOT inside `test/`:
// node --test treats every file under a `test` directory as a test file, so a
// helper that lives there gets collected and run on its own.
//
// It is a hook-capable React stand-in, not a renderer: function components are
// called eagerly and hooks share one cursor sequence. That is enough because
// rows only ever append after the parent's hooks — and it lets the tests assert
// on the real component instead of on a copy of its logic.

export const FRAGMENT = 'test-fragment'

export function jsonResponse(value) {
  return { ok: true, async json() { return value } }
}

export function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    map,
  }
}

/** A deferred promise plus its resolver, for staging slow or held responses. */
export function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

export function createHarness(t, options = {}) {
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
    return route(init)
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
  plugin.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options_, registered) => { component = registered; return () => {} },
    },
  })

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

// ── reading the rendered tree ───────────────────────────────────────────────

export function flatten(node, out = []) {
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

export function byClass(element, className) {
  return flatten(element).filter((node) => node.props.className === className)
}

export function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return (node.children || []).map(textOf).join('')
  return ''
}

export function usageButton(element) {
  return flatten(element).find((node) => node.type === 'button' &&
    typeof node.props.title === 'string' && /usage/i.test(node.props.title))
}

export function labelOf(button) {
  const span = flatten(button).find((node) => node.type === 'span')
  if (span === undefined) return null
  return span.children.filter((child) => typeof child === 'string').join('')
}

export function progressCircle(element) {
  return flatten(element).find((node) => node.type === 'circle' && node.props.strokeDasharray !== undefined)
}

export function hasSweepArc(element) {
  return flatten(element).some((node) => node.props.className === 'dts-ring-sweep')
}

export function selectByClass(element, className) {
  const match = byClass(element, className)[0]
  return match === undefined ? null : match
}

export function optionValues(select) {
  return flatten(select).filter((node) => node.type === 'option').map((node) => String(node.props.value))
}

export const flush = () => new Promise((resolve) => setImmediate(resolve))
