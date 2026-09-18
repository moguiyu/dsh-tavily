/**
 * Routes half of `@moguiyu/dsh-tavily`: key and usage management on the
 * harness webServer (`/api/tavily-usage`, `/api/tavily-manager`). The
 * built-in `web_search` tool is never replaced — no web search provider is
 * registered and `web.searchProvider` is never touched.
 *
 * There is no `/api/tavily-tool` switch route: the tool-level on/off is gone
 * (see `tools.js`). Key management is not a capability gate — it only edits
 * the credentials the tools read.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { STRATEGIES, isValidStrategy, maskValue, parseKeyList, orderKeys, readJsonFile } from './lib.js'

const USAGE_TTL_MS = 60000
const usageCache = new Map()

const MANAGER_STATE = 'tavily-manager.json'
const LEGACY_STATE = 'tavily-settings.json'
const REFS = ['TAVILY_API_KEYS', 'TAVILY_API_KEY']

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

/** Resolve one credential ref to its string value, or `null` when absent. */
async function resolveRef(credentials, ref) {
  try {
    const hit = await credentials.resolve(ref)
    return hit !== undefined && hit !== null && typeof hit.value === 'string' ? hit.value : null
  } catch {
    return null
  }
}

/**
 * Whether a ref can be written here. The launching environment's variables are
 * inherited READ-ONLY: `set`/`unset` throw for them (`describe().writable === false`).
 * Assume writable when the service cannot say.
 */
async function refWritable(credentials, ref) {
  try {
    const info = await credentials.describe(ref)
    return info === undefined || info === null || info.writable !== false
  } catch {
    return true
  }
}

/**
 * The managed key list, and where it came from.
 *
 * `TAVILY_API_KEYS` is AUTHORITATIVE. `TAVILY_API_KEY` — the derived primary — is
 * read only as a fallback, for a deployment that sets nothing else. The two used to
 * be unioned, and that was a bug with two faces: an environment-supplied
 * `TAVILY_API_KEY` re-added its key on every read, so that key could never be deleted
 * from the card; and every write then tried to re-sync the primary, which the
 * launching environment owns, so the write threw AFTER the list had already changed.
 */
async function collectStoredKeys(credentials) {
  const fromList = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEYS') ?? '')
  if (fromList.length > 0) return { values: dedupe([...fromList]), source: 'list' }
  const fromPrimary = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEY') ?? '')
  return { values: dedupe([...fromPrimary]), source: fromPrimary.length > 0 ? 'primary' : 'list' }
}

function dedupe(values) {
  const out = []
  const seen = new Set()
  for (const key of values) {
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Keep the derived primary in step with the list, best effort. The tools read
 * `TAVILY_API_KEYS`, so a primary the environment owns must never fail the request.
 */
async function syncPrimary(credentials, value) {
  if (!(await refWritable(credentials, 'TAVILY_API_KEY'))) return false
  try {
    if (value === null) await credentials.unset('TAVILY_API_KEY')
    else await credentials.set('TAVILY_API_KEY', value)
    return true
  } catch {
    return false
  }
}

/**
 * Register the Tavily key/usage routes on `ctx.webServer`:
 * `/api/tavily-usage` and `/api/tavily-manager`.
 *
 * Every route is registered through `ctx.effect`, so the calling fiber owns
 * it and unloading the row leaves nothing registered.
 */
export function installBackend(ctx) {
  const credentials = ctx.get('credentials')

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  // ── key manager payload ────────────────────────────────────────────────────
  async function buildManagerPayload(keys, source = 'list') {
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
    // The card needs to know what it may change. A ref inherited from the
    // launching environment is read-only, and saying so beats a raw 500 from
    // `set` after the list has already been written.
    const keysWritable = credentials === undefined ? true : await refWritable(credentials, 'TAVILY_API_KEYS')
    const primaryWritable = credentials === undefined ? true : await refWritable(credentials, 'TAVILY_API_KEY')
    const removable = source === 'list' ? keysWritable : primaryWritable
    return {
      keys: display.map((entry) => ({
        masked: entry.masked,
        savedAt: entry.savedAt,
        primary: entry.masked === primaryMasked,
        removable,
      })),
      strategy: isValidStrategy(state.strategy) ? state.strategy : 'rotate',
      source,
      writable: { keys: keysWritable, primary: primaryWritable },
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-usage',
    handler: async (_req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const { values: keys } = await collectStoredKeys(credentials)
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
          const { values: keys, source } = await collectStoredKeys(credentials)
          if (reveal !== null) {
            const match = keys.find((key) => maskValue(key) === reveal)
            if (match === undefined) return send(res, 404, { ok: false, error: 'key not found' })
            return send(res, 200, { ok: true, value: match })
          }
          return send(res, 200, { ok: true, ...(await buildManagerPayload(keys, source)) })
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

          let { values: stored, source } = await collectStoredKeys(credentials)
          if (removeMasked.length > 0) {
            stored = stored.filter((key) => !removeMasked.includes(maskValue(key)))
          }
          let values = [...stored]
          for (const value of addValues) {
            if (!values.includes(value)) values.push(value)
          }

          // A ref the launching environment supplies is inherited READ-ONLY: set and
          // unset throw for it. Decide that BEFORE writing anything. The old order
          // wrote `TAVILY_API_KEYS` first and then threw on the derived-primary sync,
          // so the card reported a failure for a write that had half happened — and
          // the unioned read then put the deleted key straight back.
          const canWriteList = await refWritable(credentials, 'TAVILY_API_KEYS')
          const canWritePrimary = await refWritable(credentials, 'TAVILY_API_KEY')
          const READONLY_LIST = 'TAVILY_API_KEYS is supplied read-only by the launching environment, so the key list cannot be changed here. Unset it in the shell you start dsh from, or manage keys in ~/.dsh/.credentials.yaml.'
          const READONLY_PRIMARY = 'That key comes from TAVILY_API_KEY, which the launching environment supplies read-only. Unset it in the shell you start dsh from.'
          if (!canWriteList && (addValues.length > 0 || removeMasked.length > 0)) {
            return send(res, 409, { ok: false, error: READONLY_LIST })
          }
          if (!canWritePrimary && source === 'primary' && removeMasked.length > 0) {
            return send(res, 409, { ok: false, error: READONLY_PRIMARY })
          }
          // Emptying the list while an inherited primary still carries a key would
          // read straight back as that key, so refuse rather than appear to undo itself.
          if (values.length === 0 && !canWritePrimary) {
            const inherited = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEY') ?? '')
            if (inherited.length > 0) return send(res, 409, { ok: false, error: READONLY_PRIMARY })
          }

          if (values.length === 0) {
            await credentials.unset('TAVILY_API_KEYS')
            await syncPrimary(credentials, null)
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
            await syncPrimary(credentials, values[0])
          }

          const state = readState(MANAGER_STATE)
          const keySavedAt = state.keySavedAt !== undefined && typeof state.keySavedAt === 'object' ? state.keySavedAt : {}
          const now = new Date().toISOString()
          for (const value of values) {
            const masked = maskValue(value)
            if (keySavedAt[masked] === undefined) keySavedAt[masked] = now
          }
          writeState(MANAGER_STATE, { keySavedAt, strategy })

          return send(res, 200, { ok: true, ...(await buildManagerPayload(values, source)) })
        }
        return send(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'tavily-backend: route /api/tavily-manager')

}
