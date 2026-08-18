import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as backend from '../src/index.js'

function request(body) {
  return {
    method: 'POST',
    url: '/api/tavily-tool',
    on(event, callback) {
      if (event === 'data') queueMicrotask(() => callback(Buffer.from(body)))
      if (event === 'end') queueMicrotask(() => callback())
      return this
    },
  }
}

function response() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
}

async function boot(home, loader) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const routes = {}
  await ctx.plugin({
    name: 'web-server-test',
    apply(inner) {
      inner.provide('webServer', {
        register(route) {
          routes[route.path] = route.handler
        },
      })
    },
  })
  await ctx.plugin({
    name: 'loader-test',
    apply(inner) {
      inner.provide('loader', loader)
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
  const fiber = ctx.plugin(backend, {})
  await fiber
  return {
    ctx,
    routes,
    async dispose() {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

test('tavily-tool persists the switch and hot-restarts only the tool row', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-backend-toggle-'))
  const updates = new Map()
  const loader = {
    resolve(id) {
      if (id !== 'include:tool-tavily-search') return undefined
      return {
        fiber: {
          update(config, noSave) {
            updates.set(id, { config, noSave })
            return Promise.resolve()
          },
        },
      }
    },
  }
  const bench = await boot(home, loader)
  try {
    const get = async () => {
      const res = response()
      await bench.routes['/api/tavily-tool']({ method: 'GET', url: '/api/tavily-tool' }, res)
      return res
    }

    assert.equal((await get()).body.enabled, false)

    const on = response()
    await bench.routes['/api/tavily-tool'](request(JSON.stringify({ enabled: true })), on)
    assert.equal(on.status, 200)
    assert.equal(on.body.enabled, true)
    assert.deepEqual(updates.get('include:tool-tavily-search').config, { enabled: true })
    assert.equal(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')).enabled, true)

    const off = response()
    await bench.routes['/api/tavily-tool'](request(JSON.stringify({ enabled: false })), off)
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
    assert.deepEqual(updates.get('include:tool-tavily-search').config, { enabled: false })
    assert.equal(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')).enabled, false)
    assert.equal(updates.has('include:web'), false)
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy /api/tavily-toggle alias controls the same tool switch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-backend-toggle-'))
  const updates = new Map()
  const loader = {
    resolve(id) {
      if (id !== 'include:tool-tavily-search') return undefined
      return { fiber: { update(config) { updates.set(id, config); return Promise.resolve() } } }
    },
  }
  const bench = await boot(home, loader)
  try {
    const res = response()
    await bench.routes['/api/tavily-toggle'](request(JSON.stringify({ enabled: true })), res)
    assert.equal(res.status, 200)
    assert.deepEqual(updates.get('include:tool-tavily-search'), { enabled: true })
    assert.equal(readFileSync(join(home, 'tavily-tool.json'), 'utf8').includes('true'), true)
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('tavily-tool reports failure and restores state when the tool row cannot update', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-backend-toggle-'))
  const loader = {
    resolve(id) {
      if (id !== 'include:tool-tavily-search') return undefined
      return { fiber: { update() { return Promise.reject(new Error('boom')) } } }
    },
  }
  const bench = await boot(home, loader)
  try {
    const res = response()
    await bench.routes['/api/tavily-tool'](request(JSON.stringify({ enabled: true })), res)
    assert.equal(res.status, 500)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /boom/)
    assert.equal(existsSync(join(home, 'tavily-tool.json')), false)
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('no web provider route is registered (web_search is never replaced)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-backend-toggle-'))
  const bench = await boot(home, {})
  try {
    assert.equal(bench.routes['/api/tavily-provider'], undefined)
    assert.equal(typeof bench.routes['/api/tavily-usage'], 'function')
    assert.equal(typeof bench.routes['/api/tavily-manager'], 'function')
    assert.equal(typeof bench.routes['/api/tavily-tool'], 'function')
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
