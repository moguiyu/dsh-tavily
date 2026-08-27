/**
 * `@moguiyu/dsh-tool-tavily-search` host half: the advanced `tavily_search`
 * model tool plus the extra Tavily direct tools (`tavily_extract`,
 * `tavily_map`, `tavily_crawl`). Keys resolve from the `TAVILY_API_KEYS`
 * credential per call; rotation is round-robin with failover on 401/429.
 *
 * These tools are OPT-IN and default to off. They are independent of the
 * built-in `web_search` provider: enabling them never changes
 * `web.searchProvider` and never registers a web search provider. The
 * settings card persists the choice in `~/.dsh/tavily-tool.json`; the
 * backend package hot-restarts this row after a toggle.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-tavily-search'

export const inject = ['tools', 'credentials', 'systemPrompt']

export const Config = z.object({
  enabled: z.boolean().default(false),
})

const TAVILY_BASE_URL = 'https://api.tavily.com'
const TOOL_STATE = 'tavily-tool.json'
const LEGACY_TOGGLE_STATE = 'tavily-toggle.json'

/** Read the persisted advanced-tool switch; `null` when absent or unreadable. */
export function readToolState() {
  for (const file of [TOOL_STATE, LEGACY_TOGGLE_STATE]) {
    try {
      const parsed = JSON.parse(readFileSync(join(resolveDshHome(), file), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') return parsed
    } catch {
      /* fall through to the next source */
    }
  }
  return null
}

/** The persisted switch wins; otherwise the plugin config decides. */
export function isToolEnabled(config, state = readToolState()) {
  if (state !== null) return state.enabled
  return config.enabled !== false
}

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

/** POST to `https://api.tavily.com/<operation>`; returns a normalized outcome. */
async function callOperation(operation, body, key, exec, timeoutMs) {
  const combined = combineSignals(exec.signal, timeoutMs)
  try {
    const response = await fetch(`${TAVILY_BASE_URL}/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + key,
        'user-agent': 'dsh-tool-tavily-search/0.1.12',
      },
      body: JSON.stringify(body),
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
      throw new Error(`tavily_${operation}: ${message}`)
    }
    return { kind: 'ok', statusCode: response.status, json: await response.json() }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`tavily_${operation}: request timed out or was aborted`)
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

/* ---------------------------------------------------------------------------
 * tavily_extract / tavily_map / tavily_crawl argument normalization, body
 * builders, and response projections. Exported (pure) for tests so they run
 * without a live Tavily harness.
 * ------------------------------------------------------------------------- */

function requiredUrlValue(input, name) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!URL.canParse(value)) throw new Error(`${name} must be an absolute URL`)
  const protocol = new URL(value).protocol
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`${name} must use HTTP or HTTPS`)
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
  if (typeof args[name] !== 'string' || args[name].trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return args[name].trim()
}

function optionalStringList(args, name) {
  if (args[name] === undefined) return undefined
  if (!Array.isArray(args[name])) throw new Error(`${name} must be an array of non-empty strings`)
  return args[name].map((value, index) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${name}[${index}] must be a non-empty string`)
    }
    return value.trim()
  })
}

function optionalPositiveInt(args, name) {
  if (args[name] === undefined) return undefined
  if (!Number.isInteger(args[name]) || args[name] < 1) throw new Error(`${name} must be a positive integer`)
  return args[name]
}

function optionalBoolean(args, name) {
  if (args[name] === undefined) return undefined
  if (typeof args[name] !== 'boolean') throw new Error(`${name} must be a boolean`)
  return args[name]
}

function optionalEnum(args, name, allowed) {
  if (args[name] === undefined) return undefined
  if (typeof args[name] !== 'string' || !allowed.includes(args[name])) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  }
  return args[name]
}

function include(body, key, value) {
  if (value !== undefined) body[key] = value
  return body
}

/** Normalize `tavily_extract` arguments. */
export function normalizeExtractArgs(args) {
  return {
    urls: requiredUrls(args),
    extractDepth: optionalEnum(args, 'extract_depth', ['basic', 'advanced']),
    includeImages: optionalBoolean(args, 'include_images'),
    format: optionalEnum(args, 'format', ['markdown', 'text']),
    includeFavicon: optionalBoolean(args, 'include_favicon'),
    query: optionalString(args, 'query'),
  }
}

/** Normalize `tavily_map` / `tavily_crawl` arguments. */
export function normalizeNavArgs(args, { crawl }) {
  const out = {
    crawl,
    url: requiredUrl(args, 'url'),
    instructions: optionalString(args, 'instructions'),
    maxDepth: optionalPositiveInt(args, 'max_depth'),
    maxBreadth: optionalPositiveInt(args, 'max_breadth'),
    limit: optionalPositiveInt(args, 'limit'),
    selectPaths: optionalStringList(args, 'select_paths'),
    selectDomains: optionalStringList(args, 'select_domains'),
    allowExternal: optionalBoolean(args, 'allow_external'),
  }
  if (crawl) {
    out.extractDepth = optionalEnum(args, 'extract_depth', ['basic', 'advanced'])
    out.format = optionalEnum(args, 'format', ['markdown', 'text'])
    out.includeFavicon = optionalBoolean(args, 'include_favicon')
    out.chunksPerSource = optionalPositiveInt(args, 'chunks_per_source')
  }
  return out
}

export function buildExtractBody(input) {
  const body = { urls: input.urls }
  include(body, 'extract_depth', input.extractDepth)
  include(body, 'include_images', input.includeImages)
  include(body, 'format', input.format)
  include(body, 'include_favicon', input.includeFavicon)
  include(body, 'query', input.query)
  return body
}

export function buildNavBody(input) {
  const body = { url: input.url }
  include(body, 'instructions', input.instructions)
  include(body, 'max_depth', input.maxDepth)
  include(body, 'max_breadth', input.maxBreadth)
  include(body, 'limit', input.limit)
  include(body, 'select_paths', input.selectPaths)
  include(body, 'select_domains', input.selectDomains)
  include(body, 'allow_external', input.allowExternal)
  if (input.crawl) {
    include(body, 'extract_depth', input.extractDepth)
    include(body, 'format', input.format)
    include(body, 'include_favicon', input.includeFavicon)
    include(body, 'chunks_per_source', input.chunksPerSource)
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

function projectUrls(response) {
  return Array.isArray(response?.results)
    ? response.results.flatMap((result) => typeof result === 'string' ? [result] : (typeof result?.url === 'string' ? [result.url] : []))
    : []
}

function responseTime(response) {
  return typeof response?.response_time === 'number' ? response.response_time : undefined
}

/** Project a `tavily_extract` response. */
export function projectExtract(response) {
  const out = { results: projectPages(response), failedResults: projectFailures(response) }
  const rt = responseTime(response)
  if (rt !== undefined) out.responseTime = rt
  return out
}

/** Project a `tavily_map` response. */
export function projectMap(response) {
  const out = { urls: projectUrls(response) }
  if (typeof response?.base_url === 'string') out.baseUrl = response.base_url
  const rt = responseTime(response)
  if (rt !== undefined) out.responseTime = rt
  return out
}

/** Project a `tavily_crawl` response. */
export function projectCrawl(response) {
  const out = { results: projectPages(response) }
  if (typeof response?.base_url === 'string') out.baseUrl = response.base_url
  const rt = responseTime(response)
  if (rt !== undefined) out.responseTime = rt
  return out
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

const NAVIGATION_PARAMETERS = {
  url: { type: 'string', required: true, description: 'The HTTP(S) URL to map or crawl.' },
  instructions: { type: 'string', description: 'Natural-language guidance for which pages to include.' },
  max_depth: { type: 'number', description: 'Maximum link depth to explore.' },
  max_breadth: { type: 'number', description: 'Maximum links to follow from one page.' },
  limit: { type: 'number', description: 'Maximum pages to process.' },
  select_paths: { type: 'array', items: { type: 'string' }, description: 'URL path regular expressions to include.' },
  select_domains: { type: 'array', items: { type: 'string' }, description: 'Domain regular expressions to include.' },
  allow_external: { type: 'boolean', description: 'Whether to include external links.' },
}

/**
 * Register the `tavily_search`, `tavily_extract`, `tavily_map`, and
 * `tavily_crawl` model tools on `ctx`. Call only when the tool set is
 * enabled — `apply` guards with {@link isToolEnabled}. Shared with the
 * combined `@moguiyu/dsh-tavily` package so the implementation lives in
 * exactly one place.
 *
 * No web search provider is registered here: `web_search` keeps its native
 * provider and `ctx.web` is never touched.
 */
export function installTavilyTool(ctx) {
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

  /** Run `body` through the rotation/failover loop; returns the response JSON. */
  async function requestWithRotation(operation, body, timeoutMs, exec, detail) {
    const { keys, source } = await resolveKeys()
    if (keys.length === 0) {
      throw new Error(`tavily_${operation}: TAVILY_API_KEYS is not configured — add it via the Tavily Search settings card or ~/.dsh/.credentials.yaml (comma-separated)`)
    }
    const attempts = keys.length
    let lastRetryable = 0
    for (let attempt = 0; attempt < attempts; attempt++) {
      const index = (rotation + attempt) % keys.length
      const key = keys[index]
      const started = Date.now()
      const outcome = await callOperation(operation, body, key, exec, timeoutMs)
      if (outcome.kind === 'ok') {
        rotation = (index + 1) % keys.length
        const extra = typeof detail === 'function' ? detail(outcome.json) : {}
        ctx.logger.info(`tavily_${operation}: ok %j`, { ...extra, status: outcome.statusCode, ms: Date.now() - started, keys: keys.length, source })
        return outcome.json
      }
      lastRetryable = outcome.statusCode
      rotation = (index + 1) % keys.length
      ctx.logger.info(`tavily_${operation}: key %d/%d returned HTTP %d, rotating`, index + 1, keys.length, outcome.statusCode)
    }
    throw new Error(`tavily_${operation}: all ${attempts} configured key(s) failed with HTTP ${lastRetryable} (invalid key or rate limit)`)
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
    async execute(args, exec) {
      const input = normalizeArgs(args)
      const json = await requestWithRotation('search', buildBody(input), 30000, exec, (j) => ({
        query: input.query,
        results: Array.isArray(j.results) ? j.results.length : 0,
      }))
      return projectResults(json)
    },
  }))

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
      const json = await requestWithRotation('extract', buildExtractBody(normalizeExtractArgs(args)), 60000, exec)
      return projectExtract(json)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavily_map',
    description: 'Discover URLs in a website through Tavily without extracting their page content. Use it to inspect site structure before selecting pages to extract or crawl.',
    parameters: NAVIGATION_PARAMETERS,
    output: { schema: MAP_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const json = await requestWithRotation('map', buildNavBody(normalizeNavArgs(args, { crawl: false })), 60000, exec)
      return projectMap(json)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavily_crawl',
    description: 'Crawl a website through Tavily and return the complete extracted content of discovered pages.',
    parameters: {
      ...NAVIGATION_PARAMETERS,
      extract_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Extraction depth for each crawled page.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'Content format for each crawled page.' },
      include_favicon: { type: 'boolean', description: 'Include favicon URLs when Tavily provides them.' },
      chunks_per_source: { type: 'number', description: 'Maximum extracted chunks returned per crawled source.' },
    },
    output: { schema: CRAWL_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const json = await requestWithRotation('crawl', buildNavBody(normalizeNavArgs(args, { crawl: true })), 120000, exec)
      return projectCrawl(json)
    },
  }))

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'tool:tavily_search',
      order: 111,
      text: 'Use the tavily_search tool for web search powered by the Tavily API. It supports result count, search depth, news topic with a freshness window, domain allow/deny filters, and an optional generated answer (include_answer). Cite the returned URLs as markdown links in your answer.',
    })
    systemPrompt.section({
      name: 'tool:tavily_direct',
      order: 112,
      text: 'For pages already known by URL, use tavily_extract to pull their full content, tavily_map to discover a site\'s links without fetching content, and tavily_crawl to capture the extracted content of an entire site. These are optional extras on top of the built-in web_search tool, which is never replaced.',
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

export function apply(ctx, config) {
  if (!isToolEnabled(config)) return
  installTavilyTool(ctx)
}
