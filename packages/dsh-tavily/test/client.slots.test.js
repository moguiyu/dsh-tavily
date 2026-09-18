import assert from 'node:assert/strict'
import { test } from 'node:test'

import { factory } from '../src/client.js'

// The card's slot contract moved in 0.1.6-alpha.2: the keyed
// `settings.plugin.item` slot was replaced by the Plugins page's `plugins.*`
// family. `slots.inject` only fires for a slot the host actually declares, so
// the bundle must inject both — its own module graph is the only place that
// knows which one exists on the running line. Registering into neither (or
// only the retired one) makes the card vanish with no error anywhere.

const noop = () => null

function reactStub() {
  return {
    createElement: noop,
    useState: (initial) => [initial, noop],
    useCallback: (fn) => fn,
    useEffect: noop,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null })
  }
}

function mount() {
  const plugin = factory((name) => name === 'react' ? reactStub() : { IconChevronDownOutline14: noop })
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject: (name, callback) => { injected.push(name); callback() },
      register: (options) => { registered.push(options); return noop }
    }
  }
  plugin.apply(ctx)
  return { plugin, injected, registered }
}

test('the client bundle declares the slots service', () => {
  const { plugin } = mount()
  assert.deepEqual(plugin.inject, ['slots'])
})

test('the card registers into the 0.1.6-alpha.2 Plugins page slot, keyed by bundle name', () => {
  const { injected, registered } = mount()
  assert.ok(
    injected.includes('plugins.bundle.config'),
    'inject plugins.bundle.config: the Plugins page is where a bundle configures itself from 0.1.6-alpha.2'
  )
  const entry = registered.find((options) => options.name === 'plugins.bundle.config')
  assert.ok(entry, 'the card must register into plugins.bundle.config')
  assert.equal(
    entry.key,
    '@moguiyu/dsh-tavily',
    'plugins.bundle.config is keyed by the bundle package name, not the settings namespace'
  )
})

test('the card still registers into the rc.7 through 0.1.6-alpha.1 settings slot', () => {
  const { registered } = mount()
  const entry = registered.find((options) => options.name === 'settings.plugin.item')
  assert.ok(
    entry,
    'keep registering settings.plugin.item: dropping it makes the card vanish on rc.7 through 0.1.6-alpha.1'
  )
  assert.equal(entry.key, 'tavily-search', 'the legacy keyed slot is keyed by the settings namespace')
})

test('both slots are injected, so exactly one mounts per harness line', () => {
  const { injected } = mount()
  assert.deepEqual(
    [...injected].sort(),
    ['plugins.bundle.config', 'settings.plugin.item'],
    'dual injection is the feature detection; a single name means one harness line loses its card'
  )
})
