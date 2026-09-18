import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../src/index.js'

// The combined package is now the ONLY package, so this suite guards the
// composition rather than any switch. Two designs were removed here on
// purpose and must not come back: the tool-level on/off switch and the
// composing-row restart it needed. See `docs/agents/verification.md`.

function bench() {
  const tools = []
  const sections = []
  const routes = new Map()
  const teardowns = []

  const credentials = {
    async resolve() { return undefined },
    async set() {},
    async describe() { return { configured: false } }
  }
  const systemPrompt = {
    section(value) {
      sections.push(value)
      return () => { const i = sections.indexOf(value); if (i >= 0) sections.splice(i, 1) }
    }
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => { const i = tools.indexOf(definition); if (i >= 0) tools.splice(i, 1) }
      }
    },
    systemPrompt,
    credentials,
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      }
    },
    get(key) { return key === 'credentials' ? credentials : key === 'systemPrompt' ? systemPrompt : undefined },
    effect(callback) { teardowns.push(callback()) }
  }

  apply(ctx)
  return { tools, sections, routes, teardowns }
}

test('the plugin declares exactly the services it consumes', () => {
  assert.equal(name, 'dsh-tavily')
  assert.deepEqual(inject, ['tools', 'webServer', 'credentials', 'systemPrompt'])
  // `loader` must stay out: it existed only for the row restart.
  assert.equal(inject.includes('loader'), false, 'the loader seam is for the removed row restart')
})

test('composing the plugin registers the four Tavily tools', () => {
  const { tools } = bench()
  assert.deepEqual(
    tools.map((definition) => definition.name),
    ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl']
  )
})

test('composing the plugin registers both prompt sections', () => {
  const { sections } = bench()
  assert.deepEqual(sections.map((section) => section.name), ['tool:tavily_search', 'tool:tavily_direct'])
})

test('key and usage routes come up, and no tool-switch route exists', () => {
  const { routes } = bench()
  assert.ok(routes.has('/api/tavily-usage'), '/api/tavily-usage must be served')
  assert.ok(routes.has('/api/tavily-manager'), '/api/tavily-manager must be served')
  // The tool-level on/off is gone. Routing it back would revive a switch the
  // tool half can no longer honour, because there is no disposer contract left.
  assert.equal(routes.has('/api/tavily-tool'), false, 'the tool switch route must not come back')
  assert.equal(routes.has('/api/tavily-toggle'), false, 'the legacy toggle alias must not come back')
})

test('teardown unregisters every tool, prompt section, and route', () => {
  const { tools, sections, routes, teardowns } = bench()
  assert.equal(tools.length, 4)
  // Every registration goes through ctx.effect, so the fiber owns them all.
  assert.ok(teardowns.length >= 1, 'apply must hand the fiber its teardowns')
  for (const teardown of teardowns) teardown()
  assert.deepEqual(tools, [], 'unloading the row must leave nothing registered')
  assert.deepEqual(sections, [], 'unloading the row must drop the prompt sections too')
  assert.deepEqual([...routes.keys()], [], 'the routes are fiber effects as well')
})

test('the built-in web_search is never registered or replaced', () => {
  const { tools } = bench()
  assert.equal(tools.some((definition) => definition.name === 'web_search'), false)
})
