import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as combinedPlugin from '../src/index.js'

/**
 * The rc.7 plugin-management seam: the Host registers a `tavily-search`
 * settings namespace (the join key for the Plugins configuration tab) and
 * every switch write converges on `settings.update`, whose watcher persists
 * the choice and restarts the row. This suite drives a mock settings service
 * through that pipeline.
 */

function request(enabled) {
  return {
    method: 'POST',
    url: '/api/tavily-tool',
    on(event, callback) {
      if (event === 'data') queueMicrotask(() => callback(Buffer.from(JSON.stringify({ enabled }))))
      if (event === 'end') queueMicrotask(() => callback())
      return this
    },
  }
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
}

/** Boot the combined plugin with a mock settings service that records and can re-fire. */
async function boot(home, config = { enabled: true }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const holder = { fiber: null }
  const routes = {}
  const registeredRoutes = new Set()
  const settingsMock = {
    registerCalls: [],
    updateCalls: [],
    watchers: [],
    fire(next) {
      const watcher = this.watchers[this.watchers.length - 1]
      if (watcher !== undefined) queueMicrotask(() => watcher(next, undefined))
    },
    register(ns, schema, options) {
      this.registerCalls.push({ ns, schema, options })
      const self = this
      return {
        watch(callback) {
          self.watchers.push(callback)
          return () => {}
        },
        update() {
          return Promise.resolve()
        },
        get() {
          return { enabled: config.enabled }
        },
      }
    },
    update(ns, patch) {
      this.updateCalls.push({ ns, patch })
      this.fire({ enabled: patch.enabled })
      return Promise.resolve()
    },
  }
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin({
    name: 'web-server-test',
    apply(inner) {
      inner.provide('webServer', {
        register(route) {
          if (registeredRoutes.has(route.path)) throw new Error('duplicate exact route ' + route.path)
          registeredRoutes.add(route.path)
          routes[route.path] = route.handler
          return () => {
            registeredRoutes.delete(route.path)
            delete routes[route.path]
          }
        },
      })
    },
  })
  await ctx.plugin({
    name: 'loader-test',
    apply(inner) {
      inner.provide('loader', {
        resolve(id) {
          if (id === 'include:dsh-tavily') {
            return holder.fiber === null ? undefined : { fiber: holder.fiber }
          }
          return {
            fiber: {
              update() {
                return Promise.resolve()
              },
            },
          }
        },
      })
    },
  })
  await ctx.plugin({
    name: 'credentials-test',
    apply(inner) {
      inner.provide('credentials', {
        resolve: async () => ({ value: 'tvly-test', source: 'test' }),
        describe: async () => ({ configured: true }),
        set: async () => {},
        unset: async () => {},
      })
    },
  })
  await ctx.plugin({
    name: 'settings-test',
    apply(inner) {
      inner.provide('settings', {
        register: (ns, schema, options) => settingsMock.register(ns, schema, options),
        update: (ns, patch) => settingsMock.update(ns, patch),
      })
    },
  })
  const fiber = ctx.plugin(combinedPlugin, config)
  await fiber
  holder.fiber = fiber
  return {
    ctx,
    fiber,
    routes,
    settings: settingsMock,
    async dispose() {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

test('registers the tavily-search settings namespace for rc.7 plugin management', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-ns-'))
  const bench = await boot(home)
  try {
    assert.equal(combinedPlugin.TAVILY_NS, 'tavily-search')
    assert.equal(bench.settings.registerCalls.length, 1)
    const call = bench.settings.registerCalls[0]
    assert.equal(call.ns, 'tavily-search')
    assert.deepEqual(call.options.base, { enabled: true })
    assert.equal(call.options.applies, 'restart')
    assert.equal(typeof call.schema, 'function')
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a settings-namespace commit disables the tool through the watcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-ns-'))
  const bench = await boot(home, { enabled: true })
  try {
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])
    bench.settings.fire({ enabled: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(existsSync(join(home, 'tavily-tool.json')), true)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')), { enabled: false })
    assert.deepEqual(bench.ctx.tools.schemas(), [])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('route toggle converges on settings.update and re-enables the tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-ns-'))
  const bench = await boot(home, { enabled: true })
  try {
    const off = response()
    await bench.routes['/api/tavily-tool'](request(false), off)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
    assert.deepEqual(bench.settings.updateCalls, [{ ns: 'tavily-search', patch: { enabled: false } }])
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')), { enabled: false })
    assert.deepEqual(bench.ctx.tools.schemas(), [])

    const on = response()
    await bench.routes['/api/tavily-tool'](request(true), on)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(on.body.enabled, true)
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('no web provider seam is registered (web_search is never replaced)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-ns-'))
  const bench = await boot(home)
  try {
    assert.equal(bench.routes['/api/tavily-provider'], undefined)
    assert.equal(typeof bench.routes['/api/tavily-tool'], 'function')
    assert.equal(typeof bench.routes['/api/tavily-usage'], 'function')
    assert.equal(typeof bench.routes['/api/tavily-manager'], 'function')
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})