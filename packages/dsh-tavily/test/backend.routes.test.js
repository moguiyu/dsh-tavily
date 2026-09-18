import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBackend } from '../src/backend.js'

// Hermetic run: every state read/write goes to a throwaway home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-route-'))

const routes = new Map()

const READONLY = (ref, verb) =>
  `credentials-local: "${ref}" is supplied read-only by the launching environment, so ${verb} would be shadowed; unset it in the shell you start dsh from instead`

/**
 * A credentials double that behaves like `credentials-local`: a ref supplied by
 * the launching environment resolves with `source: 'env'`, reports
 * `writable: false`, and THROWS from set/unset.
 */
function stubContext(options = {}) {
  const store = new Map(Object.entries(options.values ?? {}))
  const readonly = new Set(options.readonly ?? [])
  const sets = []
  const credentials = {
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: readonly.has(ref) ? 'env' : 'file' }
    },
    async describe(ref) {
      if (!store.has(ref)) return { configured: false, writable: true }
      return { configured: true, source: readonly.has(ref) ? 'env' : 'file', writable: !readonly.has(ref) }
    },
    async set(ref, value) {
      if (readonly.has(ref)) throw new Error(READONLY(ref, 'set'))
      sets.push({ ref, value })
      store.set(ref, value)
    },
    async unset(ref) {
      if (readonly.has(ref)) throw new Error(READONLY(ref, 'unset'))
      sets.push({ ref })
      store.delete(ref)
    },
  }
  const ctx = {
    get(name) { return name === 'credentials' ? credentials : undefined },
    effect(run) { run(); return () => {} },
    webServer: {
      register(entry) { routes.set(entry.path, entry.handler); return () => {} },
    },
  }
  installBackend(ctx)
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

const KEY_A = 'tvly-dev-aaaaaaaaaaaaaaaa'
const KEY_B = 'tvly-dev-bbbbbbbbbbbbbbbb'
const KEY_C = 'tvly-dev-cccccccccccccccc'

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

// ── environment-inherited refs (credentials-local supplies them read-only) ────

test('an inherited TAVILY_API_KEY does not resurrect a key deleted from the list', async () => {
  // The reported bug: the list held A and B, the environment ALSO supplied A as
  // TAVILY_API_KEY, and collecting keys unioned the two refs — so A came back on
  // every read and could never be deleted from the card.
  stubContext({ values: { TAVILY_API_KEYS: `${KEY_A},${KEY_B}`, TAVILY_API_KEY: KEY_A }, readonly: ['TAVILY_API_KEY'] })
  const before = await callRoute('/api/tavily-manager')
  assert.deepEqual(before.body.keys.map((k) => k.masked).length, 2)

  const res = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: [before.body.keys[0].masked] } })
  assert.equal(res.status, 200, 'a read-only primary must not fail the request')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.keys.length, 1, 'the deleted key must not reappear from the environment')
  assert.equal(res.body.keys[0].removable, true)
})

test('the inherited primary is not unioned into the visible list', async () => {
  stubContext({ values: { TAVILY_API_KEYS: KEY_A, TAVILY_API_KEY: KEY_C }, readonly: ['TAVILY_API_KEY'] })
  const res = await callRoute('/api/tavily-manager')
  assert.deepEqual(res.body.keys.map((k) => k.masked), ['tvly-dev-aaa…aaaa'])
  assert.equal(res.body.source, 'list')
  assert.equal(res.body.writable.keys, true)
  assert.equal(res.body.writable.primary, false)
})

test('a read-only TAVILY_API_KEYS is refused before anything is written', async () => {
  const { sets } = stubContext({ values: { TAVILY_API_KEYS: KEY_A }, readonly: ['TAVILY_API_KEYS', 'TAVILY_API_KEY'] })
  const res = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [KEY_B] } })
  assert.equal(res.status, 409, 'refuse, do not 500 mid-write')
  assert.match(res.body.error, /read-only by the launching environment/)
  assert.deepEqual(sets, [], 'nothing may be written when the list is read-only')
})

test('keys fall back to the primary only when the list is unset', async () => {
  stubContext({ values: { TAVILY_API_KEY: KEY_C }, readonly: ['TAVILY_API_KEY'] })
  const res = await callRoute('/api/tavily-manager')
  assert.equal(res.body.source, 'primary')
  assert.equal(res.body.keys.length, 1)
  assert.equal(res.body.keys[0].removable, false, 'the card must be able to disable delete')
})

test('emptying the list while an inherited primary still holds a key is refused', async () => {
  stubContext({ values: { TAVILY_API_KEYS: KEY_A, TAVILY_API_KEY: KEY_C }, readonly: ['TAVILY_API_KEY'] })
  const res = await callRoute('/api/tavily-manager', { method: 'POST', body: { add: [], remove: ['tvly-dev-aaa…aaaa'] } })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /TAVILY_API_KEY/)
})
