import assert from 'node:assert/strict'
import { test } from 'node:test'

import { factory } from '../src/client.js'

// The card has exactly ONE home: the Plugins page's keyed
// `plugins.bundle.config` slot, keyed by the bundle's package name. Two
// earlier registrations are gone and must not come back:
//
// - `settings.plugin.item`, retired by 0.1.6-alpha.2. It was keyed by a
//   settings namespace this package no longer registers, so re-adding it would
//   register a card that can never pair with a namespace.
// - a collapsible, self-titled card. The page draws the title, the icon, and
//   the crumb; the entry supplies the form.

function mount() {
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null })
  }
  const plugin = factory((name) => name === 'react' ? react : {})
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject: (name, callback) => { injected.push(name); callback() },
      register: (options, component) => { registered.push({ options, component }); return () => {} }
    }
  }
  plugin.apply(ctx)
  return { plugin, injected, registered }
}

test('the client bundle declares the slots service', () => {
  const { plugin } = mount()
  assert.deepEqual(plugin.inject, ['slots'])
})

test('the card registers into the Plugins page bundle-config slot, keyed by bundle name', () => {
  const { injected, registered } = mount()
  assert.deepEqual(injected, ['plugins.bundle.config'], 'the Plugins page is the only host')
  assert.equal(registered.length, 1)
  const { options } = registered[0]
  assert.equal(options.name, 'plugins.bundle.config')
  assert.equal(options.key, '@moguiyu/dsh-tavily', 'keyed by the bundle package name')
})

test('the retired settings slot is not injected', () => {
  const { injected } = mount()
  assert.equal(
    injected.includes('settings.plugin.item'),
    false,
    'settings.plugin.item was retired in 0.1.6-alpha.2 and this package registers no namespace key'
  )
})

test('the summary view is a one-liner string and the page view is the form', () => {
  const { registered } = mount()
  const { component } = registered[0]
  const summary = component({ view: 'summary' })
  assert.equal(typeof summary, 'string', 'the page renders the summary under its own title')
  assert.ok(summary.length > 0)
  const page = component({ view: 'page' })
  assert.equal(typeof page, 'object', 'the page view must be the form element')
  assert.notEqual(page, null)
})

test('the card renders with no props too (the page view is the default)', () => {
  const { registered } = mount()
  const page = registered[0].component(undefined)
  assert.equal(typeof page, 'object')
})
