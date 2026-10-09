/**
 * Tool half of `@moguiyu/dsh-tavily`: the advanced `tavily_search` model tool,
 * the extra Tavily direct tools (`tavily_extract`, `tavily_map`,
 * `tavily_crawl`), and the asynchronous Research pair (`tavily_research`,
 * `tavily_get_research`). Keys resolve from the `TAVILY_API_KEYS` credential
 * per call; rotation is round-robin with failover on every per-key refusal
 * (401/429, plus Tavily's 432 plan-limit and 433 pay-as-you-go-limit codes).
 *
 * The tools are an OPTION for search, never a replacement: they are
 * independent of the built-in `web_search` provider, and registering them
 * touches `web.searchProvider` not at all.
 *
 * There is deliberately NO tool-level on/off switch. The plugin is either
 * composed or not, and the Plugins page's own toggle is the only on/off.
 * A tool-level switch needs the tool half to be disposable and re-installable
 * at runtime across two packages, and that contract is what broke twice
 * (0.1.6 row restart, then the 0.2.x dependency-range skew). Removing the
 * capability removes the failure mode; see `docs/agents/verification.md`.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clampAccountCap, maskValue, readJsonFile } from './lib.js'

const TAVILY_BASE_URL = 'https://api.tavily.com'

/**
 * Statuses that mean "this key cannot serve the request — try another one".
 * Tavily documents 432 (plan limit exceeded) and 433 (pay-as-you-go limit
 * exceeded) as conditions of the key's account, so in a multi-key pool they
 * are failover cases exactly like 401/429. Treating them as fatal made a pool
 * with one exhausted account fail calls that a healthy key could have served.
 */
const RETRYABLE_STATUS = new Set([401, 429, 432, 433])

/** Why a retryable status refused the key; the pool's exhaustion report uses it. */
const RETRYABLE_REASON = new Map([
  [401, 'invalid or missing key'],
  [429, 'rate limit'],
  [432, 'Tavily plan usage limit exceeded'],
  [433, 'Tavily pay-as-you-go limit exceeded'],
])

/**
 * Research is asynchronous: `POST /research` queues a task and returns a
 * `request_id`; `GET /research/{request_id}` reports progress, then the report.
 * We poll that task in-process so one tool call can return the finished report,
 * and fall back to the bare id when the caller's budget runs out.
 * https://docs.tavily.com/documentation/api-reference/endpoint/research
 */
const RESEARCH_POLL_INTERVAL_MS = 5000
/**
 * How long a single call waits before handing the id back. `mini` finishes
 * narrow questions in seconds (observed live: ~13s); `pro` and `auto` run for
 * minutes, so they get the longer default. The official MCP tool blocks up to
 * 5 min for mini and 15 for pro/auto; `RESEARCH_MAX_WAIT_SECONDS` matches that
 * upper bound, and the default stays short enough that an agent is not stuck.
 */
const RESEARCH_DEFAULT_WAIT_SECONDS = 300
const RESEARCH_MINI_WAIT_SECONDS = 120
const RESEARCH_MAX_WAIT_SECONDS = 900
/** Per-HTTP-request ceiling; the caller's overall wait is bounded separately. */
const RESEARCH_REQUEST_TIMEOUT_MS = 30000

/** Task statuses after which polling stops. */
const RESEARCH_TERMINAL_STATUS = new Set(['completed', 'failed'])

const MANAGER_STATE = 'tavily-manager.json'

/**
 * The concurrency policy the card writes: the strategy, the per-account cap,
 * and the account grouping the usage route inferred (or the user pinned). Read
 * per call, so a card change takes effect on the next search, and tolerant of a
 * missing or half-written file.
 */
function readConcurrencyPolicy() {
  const state = readJsonFile(join(resolveDshHome(), MANAGER_STATE), {})
  const accounts = state.accounts !== null && state.accounts !== undefined &&
    typeof state.accounts === 'object' && !Array.isArray(state.accounts)
    ? state.accounts
    : {}
  return {
    balanced: state.strategy === 'load-balance',
    cap: clampAccountCap(state.accountCap),
    accounts,
  }
}

/**
 * The account one key belongs to. A key the usage route could not group is
 * treated as its own account: the cap still applies to it, and it stays
 * parallel-safe with keys of other accounts.
 */
function accountOfKey(key, accounts) {
  const masked = maskValue(key)
  const entry = accounts[masked]
  if (entry !== null && entry !== undefined && typeof entry === 'object' &&
    typeof entry.group === 'string' && entry.group.length > 0) {
    return entry.group
  }
  return 'key:' + masked
}

/**
 * Per-account in-flight limiter. One instance per installed tool half, so every
 * tool call in the process shares it — which is the point: parallel calls queue
 * behind one free account instead of hitting it at the same time.
 */
function createAccountScheduler() {
  const active = new Map()
  const waiters = []
  const activeIn = (group) => active.get(group) ?? 0

  const detach = (waiter) => {
    if (waiter.signal !== null && waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  function wake() {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]
      if (activeIn(waiter.group) >= waiter.cap) continue
      waiters.splice(index, 1)
      index -= 1
      detach(waiter)
      // Reserve the slot here: waking two waiters must never hand out one slot.
      active.set(waiter.group, activeIn(waiter.group) + 1)
      waiter.resolve()
    }
  }

  return {
    activeIn,
    /** Resolves `true` when the caller had to wait for capacity. */
    async acquire(group, cap, signal) {
      if (activeIn(group) < cap) {
        active.set(group, activeIn(group) + 1)
        return false
      }
      const aborted = () => new Error('tavily: request aborted while waiting for account capacity')
      if (signal !== null && signal !== undefined && signal.aborted === true) throw aborted()
      await new Promise((resolve, reject) => {
        const waiter = { group, cap, resolve, signal }
        if (signal !== null && signal !== undefined) {
          waiter.onAbort = () => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            detach(waiter)
            reject(aborted())
          }
          signal.addEventListener('abort', waiter.onAbort, { once: true })
        }
        waiters.push(waiter)
      })
      // The waker already reserved this slot.
      return true
    },
    release(group) {
      const next = activeIn(group) - 1
      if (next <= 0) active.delete(group)
      else active.set(group, next)
      wake()
    },
  }
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

/** Sleep, rejecting as soon as the caller's signal aborts. */
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      reject(new Error('tavily_research: aborted while waiting for the research task'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      reject(new Error('tavily_research: aborted while waiting for the research task'))
    }
    const timer = setTimeout(() => {
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true })
  })
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

/**
 * Call one Tavily endpoint; returns a normalized outcome.
 *
 * `request` selects the transport: `method`/`path` default to a POST to
 * `/<operation>` (search, extract, map, crawl, research-create), and
 * `notFound: 'outcome'` turns a 404 into `{ kind: 'not-found' }` instead of an
 * error — `GET /research/{id}` answers 404 for a valid task id when the key
 * asking is not the one that owns it, which the retrieve path must be able to
 * step past.
 */
async function callOperation(operation, body, key, exec, timeoutMs, request = {}) {
  const method = request.method ?? 'POST'
  const path = request.path ?? operation
  const combined = combineSignals(exec.signal, timeoutMs)
  try {
    const headers = {
      accept: 'application/json',
      authorization: 'Bearer ' + key,
      'user-agent': 'dsh-tool-tavily-search/0.2.0',
    }
    const init = { method, headers, signal: combined.signal }
    if (method !== 'GET') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body ?? {})
    }
    const response = await fetch(`${TAVILY_BASE_URL}/${path}`, init)
    if (RETRYABLE_STATUS.has(response.status)) {
      return { kind: 'retryable', statusCode: response.status }
    }
    if (request.notFound === 'outcome' && response.status === 404) {
      return { kind: 'not-found', statusCode: 404 }
    }
    if (!response.ok) {
      let message = 'HTTP ' + response.status
      let errorCode
      try {
        const parsed = await response.json()
        if (parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.error === 'string') message = parsed.error
          else if (typeof parsed.detail === 'string') message = parsed.detail
          else if (parsed.error !== null && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') message = parsed.error.message
          // 432/433 and other API failures arrive as {"detail":{"error":…}}.
          else if (parsed.detail !== undefined && parsed.detail !== null && typeof parsed.detail === 'object' && typeof parsed.detail.error === 'string') message = parsed.detail.error
          const detail = parsed.detail !== null && typeof parsed.detail === 'object' ? parsed.detail : parsed
          if (typeof detail.error_code === 'string') errorCode = detail.error_code
        }
      } catch {
        /* keep the status message */
      }
      const error = new Error(`tavily_${operation}: ${message}`)
      if (errorCode !== undefined) error.errorCode = errorCode
      throw error
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

/* ---------------------------------------------------------------------------
 * tavily_research / tavily_get_research. Research is the one Tavily capability
 * the four direct tools cannot reach: `POST /research` queues an asynchronous
 * task and `GET /research/{request_id}` returns a synthesized, cited report.
 * It is deliberately NOT a search replacement either — it costs far more
 * credits (mini 4-110, pro 15-250) than a `tavily_search` call.
 * ------------------------------------------------------------------------- */

function normalizeOutputSchema(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('output_schema must be a JSON Schema object')
  const properties = value.properties
  if (properties === null || properties === undefined || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length === 0) {
    throw new Error('output_schema must include a non-empty properties object')
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string'))) {
    throw new Error('output_schema.required must be an array of property names')
  }
  return value
}

function domainList(args, name) {
  const value = optionalStringList(args, name)
  if (value === undefined) return []
  if (value.length > 20) throw new Error(`${name} accepts at most 20 entries`)
  return value
}

function clampWaitSeconds(value, model) {
  const fallback = model === 'mini' ? RESEARCH_MINI_WAIT_SECONDS : RESEARCH_DEFAULT_WAIT_SECONDS
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error('timeout_seconds must be a number of seconds, 0 or more')
  return Math.min(RESEARCH_MAX_WAIT_SECONDS, Math.round(n))
}

/**
 * Normalize `tavily_research` arguments. The API field is `input`; `query` is
 * accepted as an alias because every neighbouring tool spells it that way.
 */
export function normalizeResearchArgs(args) {
  const raw = typeof args.input === 'string' && args.input.trim().length > 0
    ? args.input
    : (typeof args.query === 'string' ? args.query : '')
  const input = raw.trim()
  if (input.length === 0) throw new Error('tavily_research: input must be a non-empty string')
  const model = optionalEnum(args, 'model', ['mini', 'pro', 'auto']) ?? 'auto'
  return {
    input,
    model,
    citationFormat: optionalEnum(args, 'citation_format', ['numbered', 'mla', 'apa', 'chicago']),
    outputLength: optionalEnum(args, 'output_length', ['short', 'standard', 'long']),
    includeDomains: domainList(args, 'include_domains'),
    excludeDomains: domainList(args, 'exclude_domains'),
    outputSchema: normalizeOutputSchema(args.output_schema),
    waitSeconds: clampWaitSeconds(args.timeout_seconds, model),
  }
}

export function buildResearchBody(input) {
  const body = { input: input.input, model: input.model }
  include(body, 'citation_format', input.citationFormat)
  include(body, 'output_length', input.outputLength)
  if (input.includeDomains.length > 0) body.include_domains = input.includeDomains
  if (input.excludeDomains.length > 0) body.exclude_domains = input.excludeDomains
  include(body, 'output_schema', input.outputSchema)
  return body
}

/** Whether a research `status` ends the polling loop. */
export function isTerminalResearchStatus(status) {
  return RESEARCH_TERMINAL_STATUS.has(status)
}

/**
 * Project a research task response from any of the three calls that produce
 * one (create, poll, retrieve). `content` is a string for a prose report and a
 * real JSON object when `output_schema` was supplied, so an object is
 * serialized and flagged rather than dropped.
 */
export function projectResearch(response) {
  const status = typeof response?.status === 'string' && response.status.length > 0 ? response.status : 'unknown'
  const out = {
    requestId: typeof response?.request_id === 'string' ? response.request_id : '',
    status,
  }
  if (typeof response?.created_at === 'string') out.createdAt = response.created_at
  if (typeof response?.model === 'string') out.model = response.model
  if (typeof response?.response_time === 'number') out.responseTime = response.response_time
  if (status === 'completed') {
    if (typeof response.content === 'string' && response.content.length > 0) out.content = response.content
    else if (response.content !== null && typeof response.content === 'object') {
      out.content = JSON.stringify(response.content, null, 2)
      out.contentType = 'json'
    }
    const sources = Array.isArray(response.sources) ? response.sources.flatMap((source) => {
      if (source === null || typeof source !== 'object' || typeof source.url !== 'string' || source.url.length === 0) return []
      return [{
        url: source.url,
        ...(typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {}),
        ...(typeof source.favicon === 'string' && source.favicon.length > 0 ? { favicon: source.favicon } : {}),
      }]
    }) : []
    if (sources.length > 0) out.sources = sources
  }
  if (response?.usage !== null && typeof response?.usage === 'object' && typeof response.usage.credits === 'number') {
    out.credits = response.usage.credits
  }
  return out
}

function renderResearch(_args, value) {
  const heading = value.status === 'completed'
    ? 'Tavily research report'
    : value.status === 'failed' ? 'Tavily research failed' : 'Tavily research ' + value.status
  const parts = [heading + ' — request ' + value.requestId]
  if (typeof value.content === 'string' && value.content.length > 0) parts.push(value.content)
  if (Array.isArray(value.sources) && value.sources.length > 0) {
    parts.push('Sources:\n' + value.sources.map((source) => {
      const label = typeof source.title === 'string' && source.title.length > 0 ? source.title : hostnameOf(source.url)
      return '- [' + label + '](' + source.url + ')'
    }).join('\n'))
  }
  if (typeof value.note === 'string' && value.note.length > 0) parts.push(value.note)
  if (typeof value.credits === 'number') parts.push('Credits used: ' + value.credits)
  return [{ type: 'text', text: parts.join('\n\n') }]
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

const RESEARCH_SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string' },
    favicon: { type: 'string' },
  },
}

const RESEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requestId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    content: { type: 'string' },
    contentType: { type: 'string' },
    createdAt: { type: 'string' },
    model: { type: 'string' },
    sources: { type: 'array', items: RESEARCH_SOURCE_SCHEMA },
    credits: { type: 'number' },
    responseTime: { type: 'number' },
    note: { type: 'string' },
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
 * Register the `tavily_search`, `tavily_extract`, `tavily_map`,
 * `tavily_crawl`, `tavily_research`, and `tavily_get_research` model tools on
 * `ctx`, and return one disposer that unregisters all of them plus the three
 * prompt sections.
 *
 * No web search provider is registered here: `web_search` keeps its native
 * provider and `ctx.web` is never touched.
 */
export function installTavilyTool(ctx, options = {}) {
  let rotation = 0
  const scheduler = createAccountScheduler()
  // Injectable so tests can drive the poll loop without waiting seconds.
  const pollIntervalMs = options.pollIntervalMs ?? RESEARCH_POLL_INTERVAL_MS

  // Every registration is collected into one disposer so the fiber tears the
  // half down cleanly: on row unload, and on the Plugins page's runtime unload
  // of the bundle (0.1.6-alpha.2 unloads without restarting anything).
  const disposers = []
  const tools = {
    register: (definition) => { disposers.push(ctx.tools.register(definition)) },
  }

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

  /** Resolve the key pool and the concurrency policy for one call. */
  async function resolvePool(operation, exec) {
    const { keys, source } = await resolveKeys()
    if (keys.length === 0) {
      throw new Error(`tavily_${operation}: TAVILY_API_KEYS is not configured — add it via the Tavily Search settings card or ~/.dsh/.credentials.yaml (comma-separated)`)
    }
    const policy = readConcurrencyPolicy()
    const groups = policy.balanced ? keys.map((key) => accountOfKey(key, policy.accounts)) : null
    const signal = exec !== null && exec !== undefined ? exec.signal : undefined
    return { keys, source, policy, groups, signal }
  }

  /** Run one request on `pool.keys[index]`, honouring the account cap. */
  async function runOnPoolKey(pool, index, operation, body, timeoutMs, exec, request) {
    const group = pool.groups === null ? null : pool.groups[index]
    if (group !== null) await scheduler.acquire(group, pool.policy.cap, pool.signal)
    try {
      return await callOperation(operation, body, pool.keys[index], exec, timeoutMs, request)
    } finally {
      if (group !== null) scheduler.release(group)
    }
  }

  /**
   * Run `body` through the rotation/failover loop.
   *
   * The first key is picked from the shared round-robin cursor, and each
   * attempt advances by exactly one slot, so one call tries every configured
   * key at most once. Folding the attempt offset into the cursor instead
   * (the earlier shape) skipped keys and repeated others whenever the pool
   * size was even.
   *
   * Under `load-balance` the slot is chosen by account capacity instead: the
   * first key, from the cursor, whose account is below the cap — so parallel
   * calls spread across accounts, and a call queues rather than opening a
   * second connection to one free account. Every other strategy keeps the
   * plain order above, untouched.
   *
   * Returns the response JSON plus the pool slot that served it, because
   * research must keep asking with the key that owns the task.
   */
  async function requestWithRotationResult(operation, body, timeoutMs, exec, detail, request) {
    const pool = await resolvePool(operation, exec)
    const { keys, source, policy, groups, signal } = pool
    const attempts = keys.length
    const first = rotation
    const tried = new Set()
    const pickBalancedIndex = (fallbackAttempt) => {
      let leastBusy = null
      let leastLoad = Infinity
      for (let step = 0; step < keys.length; step += 1) {
        const candidate = (first + step) % keys.length
        if (tried.has(candidate)) continue
        const load = scheduler.activeIn(groups[candidate])
        if (load < policy.cap) return candidate
        if (load < leastLoad) {
          leastBusy = candidate
          leastLoad = load
        }
      }
      return leastBusy === null ? (first + fallbackAttempt) % keys.length : leastBusy
    }
    let lastRetryable = 0
    for (let attempt = 0; attempt < attempts; attempt++) {
      const index = groups === null ? (first + attempt) % keys.length : pickBalancedIndex(attempt)
      tried.add(index)
      const key = keys[index]
      const group = groups === null ? null : groups[index]
      if (group !== null) {
        const waited = await scheduler.acquire(group, policy.cap, signal)
        if (waited) {
          ctx.logger.info(`tavily_${operation}: waited for account capacity %j`, { group, cap: policy.cap, keys: keys.length })
        }
      }
      const started = Date.now()
      let outcome
      try {
        outcome = await callOperation(operation, body, key, exec, timeoutMs, request)
      } finally {
        if (group !== null) scheduler.release(group)
      }
      if (outcome.kind === 'ok') {
        rotation = (index + 1) % keys.length
        const extra = typeof detail === 'function' ? detail(outcome.json) : {}
        ctx.logger.info(`tavily_${operation}: ok %j`, { ...extra, status: outcome.statusCode, ms: Date.now() - started, keys: keys.length, source })
        return { json: outcome.json, index, keys, pool }
      }
      lastRetryable = outcome.statusCode
      rotation = (index + 1) % keys.length
      ctx.logger.info(`tavily_${operation}: key %d/%d returned HTTP %d, rotating`, index + 1, keys.length, outcome.statusCode)
    }
    const reason = RETRYABLE_REASON.get(lastRetryable) ?? 'invalid key or rate limit'
    throw new Error(`tavily_${operation}: all ${attempts} configured key(s) failed with HTTP ${lastRetryable} (${reason})`)
  }

  /** The rotation loop's JSON, for callers that do not need the owning key. */
  async function requestWithRotation(operation, body, timeoutMs, exec, detail) {
    return (await requestWithRotationResult(operation, body, timeoutMs, exec, detail)).json
  }

  tools.register(defineTool({
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

  tools.register(defineTool({
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

  tools.register(defineTool({
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

  tools.register(defineTool({
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

  /** `GET /research/{id}` — the task is owned by one key, so reuse that slot. */
  const researchPath = (requestId) => 'research/' + encodeURIComponent(requestId) + '?include_usage=true'

  tools.register(defineTool({
    name: 'tavily_research',
    description: 'Run multi-source research through the Tavily Research API and return a synthesized, cited report. It starts an asynchronous research task and waits for it, so one call can return the finished report; if the wait runs out it returns the request id for tavily_get_research. Costs far more credits than tavily_search (mini 4-110, pro 15-250): use it when a written report is wanted, not for an ordinary lookup.',
    parameters: {
      input: { type: 'string', required: true, description: 'The research task or question to investigate, in full. `query` is accepted as an alias.' },
      model: { type: 'string', enum: ['mini', 'pro', 'auto'], description: 'mini for narrow, well-scoped questions; pro for broad multi-angle research; auto (default) lets Tavily choose.' },
      citation_format: { type: 'string', enum: ['numbered', 'mla', 'apa', 'chicago'], description: 'Citation style inside the report (default numbered).' },
      output_length: { type: 'string', enum: ['short', 'standard', 'long'], description: 'Typed control over report size; a target, not a hard cap (default standard).' },
      include_domains: { type: 'array', items: { type: 'string' }, description: 'Soft preference for sources, host-based; at most 20 domains.' },
      exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Hard blocklist, subdomains included; at most 20 domains.' },
      output_schema: { type: 'object', additionalProperties: true, description: 'Optional JSON Schema object describing a structured report; must include a non-empty properties object.' },
      timeout_seconds: { type: 'number', description: 'How long to wait for completion before returning the still-running task id: 0 returns immediately after queueing; defaults to 120s for mini and 300s otherwise; maximum 900.' },
    },
    output: { schema: RESEARCH_OUTPUT_SCHEMA, render: renderResearch },
    timeoutMs: (RESEARCH_MAX_WAIT_SECONDS + 60) * 1000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = normalizeResearchArgs(args)
      let started
      try {
        started = await requestWithRotationResult('research', buildResearchBody(input), RESEARCH_REQUEST_TIMEOUT_MS, exec, (json) => ({
          model: json.model,
          status: json.status,
        }))
      } catch (error) {
        if (error instanceof Error && error.errorCode === 'research_stream_required') {
          throw new Error('tavily_research: this Tavily key requires streamed research, which this plugin does not support — use the Tavily MCP row (tavily_research) for this account')
        }
        throw error
      }
      const requestId = typeof started.json?.request_id === 'string' ? started.json.request_id : ''
      if (requestId.length === 0) throw new Error('tavily_research: the API returned no request_id')

      let current = started.json
      let stopped = ''
      const deadline = Date.now() + input.waitSeconds * 1000
      const signal = exec !== null && exec !== undefined ? exec.signal : undefined
      while (!isTerminalResearchStatus(typeof current?.status === 'string' ? current.status : '') && Date.now() < deadline) {
        await sleepWithAbort(Math.min(pollIntervalMs, deadline - Date.now()), signal)
        const outcome = await runOnPoolKey(started.pool, started.index, 'research', undefined, RESEARCH_REQUEST_TIMEOUT_MS, exec, {
          method: 'GET',
          path: researchPath(requestId),
          notFound: 'outcome',
        })
        if (outcome.kind === 'ok') {
          current = outcome.json
          continue
        }
        if (outcome.kind === 'not-found') {
          stopped = 'Tavily no longer knows this request id (HTTP 404).'
          break
        }
        stopped = `Polling stopped after HTTP ${outcome.statusCode}.`
        break
      }

      const value = projectResearch(current)
      if (value.requestId.length === 0) value.requestId = requestId
      if (!isTerminalResearchStatus(value.status)) {
        const reason = stopped.length > 0
          ? stopped
          : input.waitSeconds === 0
            ? 'Queued without waiting.'
            : `Still running after ${input.waitSeconds}s.`
        value.note = reason + ' Call tavily_get_research with requestId ' + requestId + ' to collect the report when it finishes.'
      }
      return value
    },
  }))

  tools.register(defineTool({
    name: 'tavily_get_research',
    description: 'Retrieve a Tavily research task by request id: its status while it runs, and the full cited report once it has completed. Use it after tavily_research returns a task that is still running.',
    parameters: {
      request_id: { type: 'string', required: true, description: 'The requestId returned by tavily_research.' },
    },
    output: { schema: RESEARCH_OUTPUT_SCHEMA, render: renderResearch },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requestId = optionalString(args, 'request_id')
      if (requestId === undefined) throw new Error('tavily_get_research: request_id must be a non-empty string')
      const pool = await resolvePool('research', exec)
      const first = rotation
      let lastRetryable = 0
      // A task is owned by the key that created it, and a pool may span
      // accounts, so a 404 means "not this key" until every key has answered.
      for (let attempt = 0; attempt < pool.keys.length; attempt++) {
        const index = (first + attempt) % pool.keys.length
        const outcome = await runOnPoolKey(pool, index, 'research', undefined, RESEARCH_REQUEST_TIMEOUT_MS, exec, {
          method: 'GET',
          path: researchPath(requestId),
          notFound: 'outcome',
        })
        if (outcome.kind === 'ok') {
          rotation = (index + 1) % pool.keys.length
          return projectResearch(outcome.json)
        }
        if (outcome.kind === 'retryable') lastRetryable = outcome.statusCode
      }
      if (lastRetryable !== 0) {
        const reason = RETRYABLE_REASON.get(lastRetryable) ?? 'invalid key or rate limit'
        throw new Error(`tavily_research: all ${pool.keys.length} configured key(s) failed with HTTP ${lastRetryable} (${reason})`)
      }
      throw new Error(`tavily_research: no configured key knows request ${requestId} (HTTP 404) — check the id, or the key that started the task may have been removed`)
    },
  }))

  const systemPrompt = ctx.get('systemPrompt')
  const section = (value) => {
    if (systemPrompt !== undefined) disposers.push(systemPrompt.section(value))
  }
  if (systemPrompt !== undefined) {
    section({
      name: 'tool:tavily_search',
      order: 111,
      text: 'Use the tavily_search tool for web search powered by the Tavily API. It supports result count, search depth, news topic with a freshness window, domain allow/deny filters, and an optional generated answer (include_answer). Cite the returned URLs as markdown links in your answer.',
    })
    section({
      name: 'tool:tavily_direct',
      order: 112,
      text: 'For pages already known by URL, use tavily_extract to pull their full content, tavily_map to discover a site\'s links without fetching content, and tavily_crawl to capture the extracted content of an entire site. These are optional extras on top of the built-in web_search tool, which is never replaced.',
    })
    section({
      name: 'tool:tavily_research',
      order: 113,
      text: 'For a question that wants a synthesized, multi-source written report rather than a list of links, use tavily_research. It queues a Tavily research task and waits for the finished report. It costs far more credits than tavily_search (mini 4-110, pro 15-250), so prefer tavily_search for ordinary lookups and reserve research for broad or multi-angle questions. If it returns status pending or in_progress the task is still running: call tavily_get_research with the returned requestId to collect the report later.',
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

  /**
   * Unregister everything this install registered. Idempotent: every disposer
   * is popped as it runs, so a second call is a no-op.
   */
  return function disposeTavilyTool() {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn('tavily_search: tool teardown failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
  }
}


