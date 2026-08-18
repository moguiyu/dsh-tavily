/**
 * `@moguiyu/dsh-tavily-backend`: one row registering the Tavily settings
 * routes on the harness webServer. It owns key/usage management and the
 * opt-in switch for the advanced `tavily_search` model tool. The built-in
 * `web_search` tool is never replaced — no web search provider is registered
 * and `web.searchProvider` is never touched.
 *
 * The combined `@moguiyu/dsh-tavily` package composes this same backend
 * through {@link installBackend}, supplying a settings-namespace-aware
 * switch instead of the standalone state-file pipeline.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { STRATEGIES, maskValue, parseKeyList, orderKeys, readJsonFile } from './lib.js'

export const name = 'tavily-backend'

export const inject = ['webServer', 'credentials', 'loader']

const USAGE_TTL_MS = 60000
const usageCache = new Map()

const MANAGER_STATE = 'tavily-manager.json'
const TOOL_STATE = 'tavily-tool.json'
const LEGACY_TOGGLE_STATE = 'tavily-toggle.json'
const LEGACY_STATE = 'tavily-settings.json'
const REFS = ['TAVILY_API_KEYS', 'TAVILY_API_KEY']
const TOOL_ROW = 'include:tool-tavily-search'

export function readToolState() {
  for (const file of [TOOL_STATE, LEGACY_TOGGLE_STATE]) {
    const state = readState(file)
    if (state !== null && typeof state === 'object' && typeof state.enabled === 'boolean') return state
  }
  return null
}

export function readToolEnabled() {
  const state = readToolState()
  return state === null ? false : state.enabled
}

/** Persist the advanced-tool switch (shared with the combined package). */
export function writeToolState(enabled) {
  writeState(TOOL_STATE, { enabled })
}

/** Restore a previously read switch state; `null` removes the file. */
export function restoreToolState(state) {
  if (state !== null) writeToolState(state.enabled)
  else rmSync(statePath(TOOL_STATE), { force: true })
}

function statePath(file) {
  return join(resolveDshHome(), file)
}

function readState(file) {
  return readJsonFile(statePath(file), {})
}

function writeState(file, state) {
  writeFileSync(statePath(file), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text.length > 0 ? JSON.parse(text) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function fetchUsageDetailsFor(key) {
  const cached = usageCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < USAGE_TTL_MS) return cached.details
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let response
    try {
      response = await fetch('https://api.tavily.com/usage', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return null
    const json = await response.json()
    const account = json !== null && typeof json === 'object' ? json.account : undefined
    const keyUsage = json !== null && typeof json === 'object' ? json.key : undefined
    const usage = keyUsage !== undefined && typeof keyUsage.usage === 'number'
      ? keyUsage.usage
      : (account !== undefined && typeof account.plan_usage === 'number' ? account.plan_usage : null)
    const planUsage = account !== undefined && typeof account.plan_usage === 'number'
      ? account.plan_usage
      : (keyUsage !== undefined && typeof keyUsage.usage === 'number' ? keyUsage.usage : null)
    const planLimit = account !== undefined && typeof account.plan_limit === 'number'
      ? account.plan_limit
      : (keyUsage !== undefined && typeof keyUsage.limit === 'number' ? keyUsage.limit
        : (keyUsage !== undefined && typeof keyUsage.plan_limit === 'number' ? keyUsage.plan_limit : null))
    const currentPlan = account !== undefined && typeof account.plan === 'string'
      ? account.plan
      : (keyUsage !== undefined && typeof keyUsage.plan === 'string' ? keyUsage.plan : null)
    if (usage === null && planUsage === null) return null
    const details = { usage, planUsage, planLimit, currentPlan }
    usageCache.set(key, { at: Date.now(), details })
    return details
  } catch {
    return null
  }
}

async function fetchUsageFor(key) {
  const details = await fetchUsageDetailsFor(key)
  if (details === null) return null
  if (details.planLimit !== null && details.planLimit > 0 && details.planUsage !== null) {
    return (details.planUsage / details.planLimit) * 100
  }
  return details.usage !== null ? details.usage : details.planUsage
}

async function collectStoredKeys(credentials) {
  const out = []
  const seen = new Set()
  for (const ref of REFS) {
    let hit
    try {
      hit = await credentials.resolve(ref)
    } catch {
      continue
    }
    if (hit === undefined || typeof hit.value !== 'string') continue
    for (const key of parseKeyList(hit.value)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}

/**
 * Register the Tavily settings routes on `ctx.webServer`:
 * `/api/tavily-usage`, `/api/tavily-manager`, `/api/tavily-tool` (+ the
 * backward-compatible `/api/tavily-toggle` alias). The switch is exposed
 * through `hooks` so every consumer routes the toggle through its own
 * persistence pipeline:
 *
 * - `hooks.enabled()` — current advanced-tool switch state;
 * - `hooks.applySwitch(enabled)` — persist the choice and hot-restart the
 *   owning row. The standalone backend restarts `include:tool-tavily-search`;
 *   the combined package writes through the `tavily-search` settings
 *   namespace instead.
 */
export function installBackend(ctx, hooks) {
  const credentials = ctx.get('credentials')

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  // ── key manager payload ────────────────────────────────────────────────────
  async function buildManagerPayload(keys) {
    const state = readState(MANAGER_STATE)
    const keySavedAt = state.keySavedAt !== undefined && typeof state.keySavedAt === 'object' ? state.keySavedAt : {}
    if (Object.keys(keySavedAt).length === 0 && credentials !== undefined) {
      // Migrate dates recorded by the pre-0.2 layout (ref-keyed legacy file).
      const legacy = readJsonFile(statePath(LEGACY_STATE), null)
      if (legacy !== null && typeof legacy === 'object') {
        for (const ref of REFS) {
          const entry = legacy[ref]
          if (entry !== null && typeof entry === 'object' && typeof entry.savedAt === 'string') {
            try {
              const hit = await credentials.resolve(ref)
              if (hit !== undefined) keySavedAt[maskValue(hit.value)] = entry.savedAt
            } catch {
              /* keep going */
            }
          }
        }
      }
    }
    const primaryMasked = keys.length > 0 ? maskValue(keys[0]) : null
    const display = keys.map((value) => {
      const masked = maskValue(value)
      return {
        masked,
        savedAt: keySavedAt[masked] !== undefined ? keySavedAt[masked] : null,
      }
    }).sort((a, b) => {
      if (a.savedAt === b.savedAt) return 0
      if (a.savedAt === null) return 1
      if (b.savedAt === null) return -1
      return a.savedAt < b.savedAt ? -1 : 1
    })
    return {
      keys: display.map((entry) => ({
        masked: entry.masked,
        savedAt: entry.savedAt,
        primary: entry.masked === primaryMasked,
      })),
      strategy: isValidStrategy(state.strategy) ? state.strategy : 'rotate',
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-usage',
    handler: async (_req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const keys = await collectStoredKeys(credentials)
        if (keys.length === 0) return send(res, 200, { ok: false, error: 'no Tavily API key configured' })
        const state = readState(MANAGER_STATE)
        const keySavedAt = state.keySavedAt !== undefined && typeof state.keySavedAt === 'object' ? state.keySavedAt : {}
        const orderedKeys = keys.slice().sort((a, b) => {
          const am = keySavedAt[maskValue(a)] !== undefined ? keySavedAt[maskValue(a)] : null
          const bm = keySavedAt[maskValue(b)] !== undefined ? keySavedAt[maskValue(b)] : null
          if (am === bm) return 0
          if (am === null) return 1
          if (bm === null) return -1
          return am < bm ? -1 : 1
        })
        const perKey = []
        for (const key of orderedKeys) {
          try {
            const usage = await fetchUsageDetailsFor(key)
            perKey.push(usage !== null
              ? { ok: true, masked: maskValue(key), ...usage }
              : { ok: false, masked: maskValue(key), error: 'usage unavailable' })
          } catch (error) {
            perKey.push({ ok: false, masked: maskValue(key), error: String(error && error.message ? error.message : error) })
          }
        }
        const okRows = perKey.filter((row) => row.ok)
        return send(res, 200, {
          ok: true,
          perKey,
          totals: {
            keys: keys.length,
            okKeys: okRows.length,
            usage: okRows.reduce((sum, row) => sum + (row.usage || 0), 0),
            planUsage: okRows.reduce((sum, row) => sum + (row.planUsage || 0), 0),
            planLimit: okRows.every((row) => row.planLimit !== null) ? okRows.reduce((sum, row) => sum + row.planLimit, 0) : null,
          },
        })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'tavily-backend: route /api/tavily-usage')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-manager',
    handler: async (req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const url = new URL(req.url || '/', 'http://x')
        if (req.method === 'GET') {
          const reveal = url.searchParams.get('reveal')
          const keys = await collectStoredKeys(credentials)
          if (reveal !== null) {
            const match = keys.find((key) => maskValue(key) === reveal)
            if (match === undefined) return send(res, 404, { ok: false, error: 'key not found' })
            return send(res, 200, { ok: true, value: match })
          }
          return send(res, 200, { ok: true, ...(await buildManagerPayload(keys)) })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const strategy = isValidStrategy(body.strategy) ? body.strategy : 'rotate'
          const addValues = Array.isArray(body.add)
            ? body.add.map((item) => typeof item === 'string' ? item.trim() : '').filter((value) => value.length > 0)
            : []
          const removeMasked = Array.isArray(body.remove)
            ? body.remove.filter((item) => typeof item === 'string' && item.length > 0)
            : []

          let stored = await collectStoredKeys(credentials)
          if (removeMasked.length > 0) {
            stored = stored.filter((key) => !removeMasked.includes(maskValue(key)))
          }
          let values = [...stored]
          for (const value of addValues) {
            if (!values.includes(value)) values.push(value)
          }
          if (values.length === 0) {
            await credentials.unset('TAVILY_API_KEYS')
            await credentials.unset('TAVILY_API_KEY')
          } else {
            if (strategy !== 'rotate') {
              const usageRows = await Promise.all(values.map(async (value) => ({ value, usage: await fetchUsageFor(value) })))
              const usageOf = (value) => {
                const row = usageRows.find((r) => r.value === value)
                return row !== undefined && row.usage !== null ? row.usage : null
              }
              values = orderKeys(values, strategy, usageOf)
            }
            await credentials.set('TAVILY_API_KEYS', values.join(','))
            await credentials.set('TAVILY_API_KEY', values[0])
          }

          const state = readState(MANAGER_STATE)
          const keySavedAt = state.keySavedAt !== undefined && typeof state.keySavedAt === 'object' ? state.keySavedAt : {}
          const now = new Date().toISOString()
          for (const value of values) {
            const masked = maskValue(value)
            if (keySavedAt[masked] === undefined) keySavedAt[masked] = now
          }
          writeState(MANAGER_STATE, { keySavedAt, strategy })

          return send(res, 200, { ok: true, ...(await buildManagerPayload(values)) })
        }
        return send(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'tavily-backend: route /api/tavily-manager')

  // ── advanced tool on/off (does NOT touch web.searchProvider) ──────────────
  const toolToggleHandler = async (req, res) => {
    try {
      if (req.method === 'GET') {
        return send(res, 200, { ok: true, enabled: hooks.enabled() })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const enabled = body !== null && typeof body === 'object' && body.enabled === true
        await hooks.applySwitch(enabled)
        return send(res, 200, { ok: true, enabled })
      }
      return send(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/tavily-tool', handler: toolToggleHandler }), 'tavily-backend: route /api/tavily-tool')
  // Backward-compatible alias for cards from before the provider/tool split.
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/tavily-toggle', handler: toolToggleHandler }), 'tavily-backend: route /api/tavily-toggle')
}

export function apply(ctx) {
  const loader = ctx.get('loader')

  async function applyToolEnabled(enabled) {
    if (loader === undefined) return
    const tool = loader.resolve(TOOL_ROW)
    if (tool === undefined || tool === null || tool.fiber === undefined) return
    await tool.fiber.update({ enabled }, true)
  }

  installBackend(ctx, {
    enabled: () => readToolEnabled(),
    async applySwitch(enabled) {
      // Persist first: the row update restarts the tool row, whose apply()
      // reads this file to decide whether to register.
      const previous = readToolState()
      writeToolState(enabled)
      try {
        await applyToolEnabled(enabled)
      } catch (error) {
        restoreToolState(previous)
        throw error
      }
    },
  })
}
