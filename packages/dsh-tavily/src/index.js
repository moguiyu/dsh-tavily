/**
 * `@moguiyu/dsh-tavily` host half: a Tavily `web_search` provider plus direct
 * extract, map, and crawl tools with local key management.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STRATEGIES, isValidStrategy, maskValue, parseKeyList, orderKeys, readJsonFile } from './lib.js'
import { TavilySearchProvider } from './provider.js'
import { TavilyApiClient } from './tavily.js'

export const name = 'dsh-tavily'

export const inject = ['tools', 'web', 'webServer', 'credentials']

const USAGE_TTL_MS = 60000
const usageCache = new Map()

function requiredUrlValue(input, name) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!URL.canParse(value)) throw new Error(name + ' must be an absolute URL')
  const protocol = new URL(value).protocol
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(name + ' must use HTTP or HTTPS')
  return value
}

function requiredUrl(args, name) {
  return requiredUrlValue(args[name], name)
}

function requiredUrls(args) {
  if (!Array.isArray(args.urls) || args.urls.length === 0) throw new Error('urls must contain at least one URL')
  return args.urls.map((value, index) => requiredUrlValue(value, 'urls[' + index + ']'))
}

function optionalString(args, name) {
  if (args[name] === undefined) return undefined
  if (typeof args[name] !== 'string' || args[name].trim().length === 0) throw new Error(name + ' must be a non-empty string')
  return args[name].trim()
}

function optionalStringList(args, name) {
  if (args[name] === undefined) return undefined
  if (!Array.isArray(args[name])) throw new Error(name + ' must be an array of non-empty strings')
  return args[name].map((value, index) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(name + '[' + index + '] must be a non-empty string')
    }
    return value.trim()
  })
}

function optionalPositiveInt(args, name) {
  if (args[name] === undefined) return undefined
  if (!Number.isInteger(args[name]) || args[name] < 1) throw new Error(name + ' must be a positive integer')
  return args[name]
}

function optionalBoolean(args, name) {
  if (args[name] === undefined) return undefined
  if (typeof args[name] !== 'boolean') throw new Error(name + ' must be a boolean')
  return args[name]
}

function include(body, key, value) {
  if (value !== undefined) body[key] = value
  return body
}

function navigationRequest(args, { crawl }) {
  const body = { url: requiredUrl(args, 'url') }
  include(body, 'instructions', optionalString(args, 'instructions'))
  include(body, 'max_depth', optionalPositiveInt(args, 'max_depth'))
  include(body, 'max_breadth', optionalPositiveInt(args, 'max_breadth'))
  include(body, 'limit', optionalPositiveInt(args, 'limit'))
  include(body, 'select_paths', optionalStringList(args, 'select_paths'))
  include(body, 'select_domains', optionalStringList(args, 'select_domains'))
  include(body, 'allow_external', optionalBoolean(args, 'allow_external'))
  if (crawl) {
    include(body, 'extract_depth', args.extract_depth)
    include(body, 'format', args.format)
    include(body, 'include_favicon', optionalBoolean(args, 'include_favicon'))
    include(body, 'chunks_per_source', optionalPositiveInt(args, 'chunks_per_source'))
  }
  return body
}

function projectPage(result) {
  if (result === null || typeof result !== 'object' || typeof result.url !== 'string' || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...(typeof result.raw_content === 'string' ? { rawContent: result.raw_content } : {}),
    ...(Array.isArray(result.images) ? { images: result.images.filter((image) => typeof image === 'string') } : {}),
    ...(typeof result.favicon === 'string' ? { favicon: result.favicon } : {}),
  }
}

function projectPages(response) {
  return Array.isArray(response?.results) ? response.results.flatMap((result) => {
    const page = projectPage(result)
    return page === undefined ? [] : [page]
  }) : []
}

function projectFailures(response) {
  return Array.isArray(response?.failed_results) ? response.failed_results.flatMap((result) => {
    if (result === null || typeof result !== 'object') return []
    const value = {
      ...(typeof result.url === 'string' ? { url: result.url } : {}),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
    }
    return Object.keys(value).length === 0 ? [] : [value]
  }) : []
}

function responseTime(response) {
  return typeof response?.response_time === 'number' ? response.response_time : undefined
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    rawContent: { type: 'string' },
    images: { type: 'array', items: { type: 'string' } },
    favicon: { type: 'string' },
  },
}

const EXTRACT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: { type: 'array', required: true, items: PAGE_SCHEMA },
    failedResults: {
      type: 'array',
      required: true,
      items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, error: { type: 'string' } } },
    },
    responseTime: { type: 'number' },
  },
}

const MAP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: { type: 'string' },
    urls: { type: 'array', required: true, items: { type: 'string' } },
    responseTime: { type: 'number' },
  },
}

const CRAWL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: { type: 'string' },
    results: { type: 'array', required: true, items: PAGE_SCHEMA },
    responseTime: { type: 'number' },
  },
}

/** Resolve the configured key list, retaining the legacy primary-key fallback. */
export async function resolveTavilyKeys(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return []
  for (const ref of ['TAVILY_API_KEYS', 'TAVILY_API_KEY']) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined && typeof resolved.value === 'string') {
      const keys = parseKeyList(resolved.value)
      if (keys.length > 0) return keys
    }
  }
  return []
}

/** Register the Tavily provider and Tavily's extract, map, and crawl model tools. */
export function apply(ctx) {
  const client = new TavilyApiClient({ resolveKeys: () => resolveTavilyKeys(ctx) })
  ctx.web.registerSearchProvider(new TavilySearchProvider(client))

  ctx.tools.register(defineTool({
    name: 'tavily_extract',
    description: 'Extract complete content from one or more HTTP(S) URLs through Tavily. Use it to retrieve pages directly when a URL is known.',
    parameters: {
      urls: { type: 'array', required: true, items: { type: 'string' }, description: 'HTTP(S) URLs to extract.' },
      extract_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Extraction depth. Advanced retrieves more page structure.' },
      include_images: { type: 'boolean', description: 'Include extracted image URLs.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'Content format.' },
      include_favicon: { type: 'boolean', description: 'Include favicon URLs when Tavily provides them.' },
      query: { type: 'string', description: 'Optional intent used to rank extracted chunks by relevance.' },
    },
    output: { schema: EXTRACT_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const body = { urls: requiredUrls(args) }
      include(body, 'extract_depth', args.extract_depth)
      include(body, 'include_images', optionalBoolean(args, 'include_images'))
      include(body, 'format', args.format)
      include(body, 'include_favicon', optionalBoolean(args, 'include_favicon'))
      include(body, 'query', optionalString(args, 'query'))
      const response = await client.request('extract', body, exec.signal)
      return {
        results: projectPages(response),
        failedResults: projectFailures(response),
        ...(responseTime(response) === undefined ? {} : { responseTime: responseTime(response) }),
      }
    },
  }))

  const navigationParameters = {
    url: { type: 'string', required: true, description: 'The HTTP(S) URL to map or crawl.' },
    instructions: { type: 'string', description: 'Natural-language guidance for which pages to include.' },
    max_depth: { type: 'number', description: 'Maximum link depth to explore.' },
    max_breadth: { type: 'number', description: 'Maximum links to follow from one page.' },
    limit: { type: 'number', description: 'Maximum pages to process.' },
    select_paths: { type: 'array', items: { type: 'string' }, description: 'URL path regular expressions to include.' },
    select_domains: { type: 'array', items: { type: 'string' }, description: 'Domain regular expressions to include.' },
    allow_external: { type: 'boolean', description: 'Whether to include external links.' },
  }

  ctx.tools.register(defineTool({
    name: 'tavily_map',
    description: 'Discover URLs in a website through Tavily without extracting their page content. Use it to inspect site structure before selecting pages to extract or crawl.',
    parameters: navigationParameters,
    output: { schema: MAP_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const response = await client.request('map', navigationRequest(args, { crawl: false }), exec.signal)
      const urls = Array.isArray(response?.results)
        ? response.results.flatMap((result) => typeof result === 'string' ? [result] : (typeof result?.url === 'string' ? [result.url] : []))
        : []
      return {
        ...(typeof response?.base_url === 'string' ? { baseUrl: response.base_url } : {}),
        urls,
        ...(responseTime(response) === undefined ? {} : { responseTime: responseTime(response) }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavily_crawl',
    description: 'Crawl a website through Tavily and return the complete extracted content of discovered pages.',
    parameters: {
      ...navigationParameters,
      extract_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Extraction depth for each crawled page.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'Content format for each crawled page.' },
      include_favicon: { type: 'boolean', description: 'Include favicon URLs when Tavily provides them.' },
      chunks_per_source: { type: 'number', description: 'Maximum extracted chunks returned per crawled source.' },
    },
    output: { schema: CRAWL_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const response = await client.request('crawl', navigationRequest(args, { crawl: true }), exec.signal)
      return {
        ...(typeof response?.base_url === 'string' ? { baseUrl: response.base_url } : {}),
        results: projectPages(response),
        ...(responseTime(response) === undefined ? {} : { responseTime: responseTime(response) }),
      }
    },
  }))

  applyBackend(ctx)
}
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

  ctx.webServer.register({
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

}
