import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBackend } from '../src/index.js'

// Hermetic run: every state read/write goes to a throwaway home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-route-'))

const routes = new Map()

function stubContext() {
  const sets = []
  const credentials = {
    async resolve() { return undefined },
    async set(ref, value) { sets.push({ ref, value }) },
    async unset(ref) { sets.push({ ref }) },
  }
  const ctx = {
    get(name) { return name === 'credentials' ? credentials : undefined },
    effect(run) { run(); return () => {} },
    webServer: {
      register(entry) { routes.set(entry.path, entry.handler); return () => {} },
    },
  }
  installBackend(ctx, { enabled: () => false, applySwitch: async () => {} })
  return { credentials, sets }
}

function callRoute(path, init = {}) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} not registered`)
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code },
      end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) },
    }
    const req = new EventEmitter()
    req.method = init.method ?? 'GET'
    req.url = path + (init.query ?? '')
    process.nextTick(() => {
      if (init.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(init.body)))
      req.emit('end')
    })
    handler(req, res)
  })
}

test('GET /api/tavily-manager loads without ReferenceError', async () => {
  const { sets } = stubContext()
  const res = await callRoute('/api/tavily-manager')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.keys, [])
  assert.equal(res.body.strategy, 'rotate')
  assert.equal(sets.length, 0)
})

test('POST /api/tavily-manager saves via credentials and falls back to rotate', async () => {
  const { sets } = stubContext()
  const key = 'tvly-dev-1234567890abcdef'
  const res = await callRoute('/api/tavily-manager', {
    method: 'POST',
    body: { add: [key], strategy: 'bogus' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.strategy, 'rotate')
  // Key material goes to the credentials seam only, never into state files.
  assert.deepEqual(sets, [
    { ref: 'TAVILY_API_KEYS', value: key },
    { ref: 'TAVILY_API_KEY', value: key },
  ])
})
