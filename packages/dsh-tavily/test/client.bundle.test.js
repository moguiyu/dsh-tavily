import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { factory, id } from '../src/client.js'

// `lib/client.js` is a committed build artifact: the browser gets exactly
// `factory.toString()`, so anything that lives outside `factory` breaks at
// runtime in the page, not here. This guards both halves — that the artifact
// was rebuilt after a source edit, and that the serialized factory still mounts
// with nothing but the loader and React.

const artifactPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

test('lib/client.js is the exact serialization of the current factory', () => {
  const expected = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(id)},\n  factory: ${factory.toString()}\n});\n`
  assert.equal(
    readFileSync(artifactPath, 'utf8'),
    expected,
    'run `pnpm build` and commit the regenerated lib/client.js'
  )
})

test('the serialized factory mounts from the artifact alone', async () => {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (bundle) => loaded.push(bundle) } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }

  assert.equal(loaded.length, 1, 'the artifact registers one module')
  assert.equal(loaded[0].id, id)

  // Nothing from this module's scope is available to the serialized copy: a
  // stray module-level reference would surface here as undefined.
  const react = {
    Fragment: 'test-fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useCallback: (callback) => callback,
    useEffect: () => {},
    useMemo: (callback) => callback(),
    useRef: () => ({ current: null }),
  }
  const plugin = loaded[0].factory((name) => (name === 'react' ? react : {}))
  assert.deepEqual(plugin.inject, ['slots'])

  const registered = []
  plugin.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.key, '@moguiyu/dsh-tavily')
  assert.equal(typeof registered[0].component({ view: 'summary' }), 'string')
})
