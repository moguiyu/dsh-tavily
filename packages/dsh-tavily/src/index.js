/**
 * `@moguiyu/dsh-tavily` combined host half: `tavily_search` model tool plus
 * the local HTTP backend for usage, key management, and the web provider toggle.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STRATEGIES, maskValue, parseKeyList, orderKeys, readJsonFile } from './lib.js'

export const name = 'dsh-tavily'

export const inject = ['tools', 'webServer', 'credentials']

/** Clamp a number into [min, max]; `fallback` when not finite. */
export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Normalize and validate model arguments (exported for tests). */
export function normalizeArgs(args) {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query.length === 0) throw new Error('tavily_search: query must be a non-empty string')
  const maxResults = clampInt(args.max_results, 1, 20, 5)
  const searchDepth = args.search_depth === 'advanced' ? 'advanced' : 'basic'
  const topic = args.topic === 'news' ? 'news' : 'general'
  const days = args.days === undefined ? undefined : clampInt(args.days, 1, 30, undefined)
  const includeAnswer = args.include_answer === true
  const includeRawContent = args.include_raw_content === true
  const includeDomains = Array.isArray(args.include_domains)
    ? args.include_domains.filter((d) => typeof d === 'string' && d.length > 0)
    : []
  const excludeDomains = Array.isArray(args.exclude_domains)
    ? args.exclude_domains.filter((d) => typeof d === 'string' && d.length > 0)
    : []
  return { query, maxResults, searchDepth, topic, days, includeAnswer, includeRawContent, includeDomains, excludeDomains }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Combine a caller signal with a hard timeout; call dispose() after the request. */
function combineSignals(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    },
  }
}

function buildBody(input) {
  const body = {
    query: input.query,
    max_results: input.maxResults,
    search_depth: input.searchDepth,
  }
  if (input.topic === 'news') {
    body.topic = 'news'
    if (input.days !== undefined) body.days = input.days
  }
  if (input.includeAnswer) body.include_answer = true
  if (input.includeRawContent) body.include_raw_content = true
  if (input.includeDomains.length > 0) body.include_domains = input.includeDomains
  if (input.excludeDomains.length > 0) body.exclude_domains = input.excludeDomains
  return body
}

async function callTavily(input, key, exec) {
  const combined = combineSignals(exec.signal, 30000)
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + key,
        'user-agent': 'dsh-tool-tavily-search/0.1.0',
      },
      body: JSON.stringify(buildBody(input)),
      signal: combined.signal,
    })
    if (response.status === 401 || response.status === 429) {
      return { kind: 'retryable', statusCode: response.status }
    }
    if (!response.ok) {
      let message = 'HTTP ' + response.status
      try {
        const parsed = await response.json()
        if (parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.error === 'string') message = parsed.error
          else if (parsed.error !== null && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') message = parsed.error.message
        }
      } catch {
        /* keep the status message */
      }
      throw new Error('tavily_search: ' + message)
    }
    return { kind: 'ok', statusCode: response.status, json: await response.json() }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('tavily_search: request timed out or was aborted')
    }
    throw error
  } finally {
    combined.dispose()
  }
}

function projectResults(json) {
  const results = Array.isArray(json.results) ? json.results : []
  const mapped = results.map((r) => {
    const item = { url: String(r.url !== undefined && r.url !== null ? r.url : '') }
    if (typeof r.title === 'string' && r.title.length > 0) item.title = r.title
    if (typeof r.content === 'string' && r.content.length > 0) item.content = r.content
    if (typeof r.score === 'number') item.score = r.score
    if (typeof r.published_date === 'string' && r.published_date.length > 0) item.publishedAt = r.published_date
    if (typeof r.raw_content === 'string' && r.raw_content.length > 0) {
      item.rawContent = r.raw_content.length > 4000 ? r.raw_content.slice(0, 4000) + '…' : r.raw_content
    }
    return item
  })
  const value = { results: mapped }
  if (typeof json.answer === 'string' && json.answer.length > 0) value.answer = json.answer
  return value
}

function formatOutput(value) {
  const parts = []
  if (typeof value.answer === 'string' && value.answer.length > 0) parts.push(value.answer)
  if (value.results.length > 0) {
    const lines = value.results.map((r) => {
      const label = typeof r.title === 'string' && r.title.length > 0 ? r.title : hostnameOf(r.url)
      const meta = []
      if (typeof r.content === 'string' && r.content.length > 0) meta.push(r.content)
      if (typeof r.publishedAt === 'string' && r.publishedAt.length > 0) meta.push('(' + r.publishedAt + ')')
      if (typeof r.score === 'number') meta.push('(relevance ' + r.score.toFixed(2) + ')')
      const suffix = meta.length > 0 ? ' — ' + meta.join(' ') : ''
      return '- [' + label + '](' + r.url + ')' + suffix
    })
    parts.push('Sources:\n' + lines.join('\n'))
  } else {
    parts.push('No results found.')
  }
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

export function apply(ctx) {
  applyBackend(ctx)

  let rotation = 0

  async function resolveKeys() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve('TAVILY_API_KEYS')
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          const list = resolved.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          if (list.length > 0) return { keys: list, source: resolved.source }
        }
      } catch (error) {
        ctx.logger.warn('tavily_search: credential resolution failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
    return { keys: [], source: 'unconfigured' }
  }

  async function execute(args, exec) {
    const input = normalizeArgs(args)
    const { keys, source } = await resolveKeys()
    if (keys.length === 0) {
      throw new Error('tavily_search: TAVILY_API_KEYS is not configured — add it via the Tavily Search settings card or ~/.dsh/.credentials.yaml (comma-separated)')
    }
    const attempts = keys.length
    let lastRetryable = 0
    for (let attempt = 0; attempt < attempts; attempt++) {
      const index = (rotation + attempt) % keys.length
      const key = keys[index]
      const started = Date.now()
      const outcome = await callTavily(input, key, exec)
      if (outcome.kind === 'ok') {
        rotation = (index + 1) % keys.length
        const count = Array.isArray(outcome.json.results) ? outcome.json.results.length : 0
        ctx.logger.info('tavily_search: ok %j', { query: input.query, status: outcome.statusCode, results: count, ms: Date.now() - started, keys: keys.length, source })
        return projectResults(outcome.json)
      }
      lastRetryable = outcome.statusCode
      rotation = (index + 1) % keys.length
      ctx.logger.info('tavily_search: key %d/%d returned HTTP %d, rotating', index + 1, keys.length, outcome.statusCode)
    }
    throw new Error('tavily_search: all ' + attempts + ' configured key(s) failed with HTTP ' + lastRetryable + ' (invalid key or rate limit)')
  }

  ctx.tools.register(defineTool({
    name: 'tavily_search',
    description: 'Search the web through the Tavily API. Returns ranked results with titles, URLs, snippets, relevance scores, and an optional generated answer. Supports basic/advanced depth, news topic with a freshness window, and domain allow/deny filters.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      max_results: { type: 'number', description: 'Number of results to return, 1-20 (default 5).' },
      search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'basic is faster and cheaper; advanced returns deeper analysis (default basic).' },
      topic: { type: 'string', enum: ['general', 'news'], description: 'Search scope: general web or news (default general).' },
      days: { type: 'number', description: 'News freshness window in days, e.g. 7 for the last week; only applies when topic is news.' },
      include_answer: { type: 'boolean', description: 'Ask Tavily to generate a concise answer to the query (default false).' },
      include_raw_content: { type: 'boolean', description: 'Include raw page content for each result (default false; capped per result).' },
      include_domains: { type: 'array', items: { type: 'string' }, description: 'Only search within these domains.' },
      exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains from results.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                content: { type: 'string' },
                score: { type: 'number' },
                publishedAt: { type: 'string' },
                rawContent: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatOutput(value) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute,
  }))

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'tool:tavily_search',
      order: 111,
      text: 'Use the tavily_search tool for web search powered by the Tavily API. It supports result count, search depth, news topic with a freshness window, domain allow/deny filters, and an optional generated answer (include_answer). Cite the returned URLs as markdown links in your answer.',
    })
  }

  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    credentials.describe('TAVILY_API_KEYS').then((info) => {
      if (!info.configured) {
        ctx.logger.warn('tavily_search: TAVILY_API_KEYS credential is not configured; add it via the Tavily Search settings card or ~/.dsh/.credentials.yaml')
      }
    }).catch((error) => {
      ctx.logger.warn('tavily_search: credential describe failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
}
const MANAGER_STATE = 'tavily-manager.json'
const TOGGLE_STATE = 'tavily-toggle.json'
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

async function fetchUsageFor(key) {
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
    if (account !== undefined && typeof account.plan_usage === 'number') return account.plan_usage
    if (keyUsage !== undefined && typeof keyUsage.usage === 'number') return keyUsage.usage
    return null
  } catch {
    return null
  }
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

function applyBackend(ctx) {
  const credentials = ctx.get('credentials')
  const loader = ctx.get('loader')

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
    return {
      keys: keys.map((value, index) => ({
        masked: maskValue(value),
        savedAt: keySavedAt[maskValue(value)] !== undefined ? keySavedAt[maskValue(value)] : null,
        primary: index === 0,
      })),
      strategy: isValidStrategy(state.strategy) ? state.strategy : 'rotate',
    }
  }

  // ── persisted on/off + live provider flip ───────────────────────────────────
  async function applyProvider(enabled) {
    if (loader === undefined) return
    try {
      const entry = loader.resolve('include:web')
      if (entry !== undefined && entry !== null && entry.fiber !== undefined) {
        await entry.fiber.update({ searchProvider: enabled ? 'tavily' : 'deepseek-official' }, true)
      }
    } catch (error) {
      ctx.logger.warn('tavily-backend: web provider flip failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  // Re-apply the persisted choice at activation (default: enabled).
  const toggleState = readState(TOGGLE_STATE)
  if (toggleState.enabled === false) {
    void applyProvider(false)
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-usage',
    handler: async (_req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const keys = await collectStoredKeys(credentials)
        if (keys.length === 0) return send(res, 200, { ok: false, error: 'no Tavily API key configured' })
        const perKey = []
        for (const key of keys) {
          try {
            const usage = await fetchUsageFor(key)
            perKey.push(usage !== null
              ? { ok: true, usage, planUsage: usage, planLimit: null, currentPlan: null }
              : { ok: false, error: 'usage unavailable' })
          } catch (error) {
            perKey.push({ ok: false, error: String(error && error.message ? error.message : error) })
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
            planUsage: null,
            planLimit: null,
          },
        })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  })

  ctx.webServer.register({
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
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-toggle',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          return send(res, 200, { ok: true, enabled: readState(TOGGLE_STATE).enabled === true })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const enabled = body !== null && typeof body === 'object' && body.enabled === true
          writeState(TOGGLE_STATE, { enabled })
          await applyProvider(enabled)
          return send(res, 200, { ok: true, enabled })
        }
        return send(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  })
}
