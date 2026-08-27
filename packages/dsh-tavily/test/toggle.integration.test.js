import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as combinedPlugin from '../src/index.js'

async function boot(home, config = { enabled: true }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const holder = { fiber: null }
  const routes = {}
  const registeredRoutes = new Set()
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
  const fiber = ctx.plugin(combinedPlugin, config)
  await fiber
  holder.fiber = fiber
  return {
    ctx,
    fiber,
    routes,
    async dispose() {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

function toggleRequest(enabled) {
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

function toggleResponse() {
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

test('combined plugin honors persisted off on activation and re-enables', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  writeFileSync(join(home, 'tavily-tool.json'), JSON.stringify({ enabled: false }))
  const bench = await boot(home)
  try {
    assert.deepEqual(bench.ctx.tools.schemas(), [])

    rmSync(join(home, 'tavily-tool.json'))
    await bench.fiber.update({ enabled: true }, true)
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('combined advanced tool defaults to off with no persisted state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  const bench = await boot(home, {})
  try {
    assert.deepEqual(bench.ctx.tools.schemas(), [])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('settings-card toggle hot-unregisters and re-registers tavily_search', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  const bench = await boot(home)
  try {
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])

    const off = toggleResponse()
    await bench.routes['/api/tavily-toggle'](toggleRequest(false), off)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(off.status, 200)
    assert.deepEqual(bench.ctx.tools.schemas(), [])

    const on = toggleResponse()
    await bench.routes['/api/tavily-toggle'](toggleRequest(true), on)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(on.status, 200)
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
