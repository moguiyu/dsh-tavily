/**
 * `@moguiyu/dsh-tool-tavily-search` host half: the `tavily_search` model tool.
 * Keys resolve from the `TAVILY_API_KEYS` credential per call; rotation is
 * round-robin with failover on 401/429. HTTP goes through global fetch (Node 22+).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-tavily-search'

export const inject = ['tools']

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
