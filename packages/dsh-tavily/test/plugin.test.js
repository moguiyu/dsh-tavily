import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.js'
import { TAVILY_PROVIDER_ID } from '../src/provider.js'

let fetchRestore

beforeEach(() => {
  fetchRestore = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = fetchRestore
})

function installPlugin() {
  const tools = new Map()
  const routes = []
  let provider
  const credentials = {
    async resolve(ref) {
      return ref === 'TAVILY_API_KEYS' ? { value: 'test-key' } : undefined
    },
  }
  plugin.apply({
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    web: { registerSearchProvider: (value) => { provider = value } },
    webServer: { register: (route) => { routes.push(route) } },
    get: (key) => key === 'credentials' ? credentials : undefined,
  })
  return { tools, routes, provider }
}

test('plugin registers the Tavily web provider and only the three extra tools', () => {
  const { provider, routes, tools } = installPlugin()
  assert.equal(provider.id, TAVILY_PROVIDER_ID)
  assert.deepEqual([...tools.keys()].sort(), ['tavily_crawl', 'tavily_extract', 'tavily_map'])
  assert.equal(tools.has('tavily_search'), false)
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/api/tavily-manager', '/api/tavily-usage'])
})

test('provider maps Tavily search results for the native web_search tool', async () => {
  const { provider } = installPlugin()
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.tavily.com/search')
    assert.equal(init.headers.authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(init.body), {
      query: 'DSH Tavily provider',
      max_results: 8,
      include_answer: true,
      search_depth: 'basic',
    })
    return new Response(JSON.stringify({
      answer: 'provider answer',
      results: [{ url: 'https://example.com', title: 'Example', content: 'source snippet', published_date: '2026-08-17' }],
    }), { status: 200 })
  }
  assert.deepEqual(await provider.search({ query: 'DSH Tavily provider', maxResults: 8 }), {
    content: 'provider answer',
    sources: [{ url: 'https://example.com', title: 'Example', snippet: 'source snippet', publishedAt: '2026-08-17' }],
    truncated: false,
  })
})

test('extra tools call their corresponding Tavily endpoints', async () => {
  const { tools } = installPlugin()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (url.endsWith('/extract')) {
      return new Response(JSON.stringify({
        results: [{ url: 'https://example.com', raw_content: 'extracted content', images: ['https://example.com/image.png'] }],
        failed_results: [],
      }), { status: 200 })
    }
    if (url.endsWith('/map')) return new Response(JSON.stringify({ base_url: 'https://example.com', results: ['https://example.com/docs'] }), { status: 200 })
    return new Response(JSON.stringify({ base_url: 'https://example.com', results: [{ url: 'https://example.com/docs', raw_content: 'crawled content' }] }), { status: 200 })
  }
  const exec = { signal: new AbortController().signal }
  assert.deepEqual(await tools.get('tavily_extract').execute({
    urls: ['https://example.com'], extract_depth: 'advanced', format: 'markdown', query: 'API docs',
  }, exec), {
    results: [{ url: 'https://example.com', rawContent: 'extracted content', images: ['https://example.com/image.png'] }],
    failedResults: [],
  })
  assert.deepEqual(await tools.get('tavily_map').execute({ url: 'https://example.com', limit: 10 }, exec), {
    baseUrl: 'https://example.com',
    urls: ['https://example.com/docs'],
  })
  assert.deepEqual(await tools.get('tavily_crawl').execute({ url: 'https://example.com', chunks_per_source: 3 }, exec), {
    baseUrl: 'https://example.com',
    results: [{ url: 'https://example.com/docs', rawContent: 'crawled content' }],
  })
  assert.deepEqual(calls, [
    { url: 'https://api.tavily.com/extract', body: { urls: ['https://example.com'], extract_depth: 'advanced', format: 'markdown', query: 'API docs' } },
    { url: 'https://api.tavily.com/map', body: { url: 'https://example.com', limit: 10 } },
    { url: 'https://api.tavily.com/crawl', body: { url: 'https://example.com', chunks_per_source: 3 } },
  ])
})
