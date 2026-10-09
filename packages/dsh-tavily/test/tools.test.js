import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractBody,
  buildNavBody,
  buildResearchBody,
  clampInt,
  isTerminalResearchStatus,
  normalizeArgs,
  normalizeExtractArgs,
  normalizeNavArgs,
  normalizeResearchArgs,
  projectCrawl,
  projectExtract,
  projectMap,
  projectResearch,
} from '../src/tools.js'

test('clampInt', () => {
  assert.equal(clampInt(3, 1, 20, 5), 3)
  assert.equal(clampInt(0, 1, 20, 5), 1)
  assert.equal(clampInt(99, 1, 20, 5), 20)
  assert.equal(clampInt(undefined, 1, 20, 5), 5)
  assert.equal(clampInt('abc', 1, 20, 5), 5)
  assert.equal(clampInt(2.6, 1, 20, 5), 3)
})

test('normalizeArgs: query is required and trimmed', () => {
  assert.throws(() => normalizeArgs({}), /non-empty string/)
  assert.throws(() => normalizeArgs({ query: '   ' }), /non-empty string/)
  assert.equal(normalizeArgs({ query: '  hello  ' }).query, 'hello')
})

test('normalizeArgs: defaults and clamping', () => {
  const args = normalizeArgs({ query: 'x' })
  assert.equal(args.maxResults, 5)
  assert.equal(args.searchDepth, 'basic')
  assert.equal(args.topic, 'general')
  assert.equal(args.days, undefined)
  assert.equal(args.includeAnswer, false)
  assert.deepEqual(args.includeDomains, [])
  assert.deepEqual(args.excludeDomains, [])
})

test('normalizeArgs: advanced/news/days', () => {
  const args = normalizeArgs({ query: 'x', search_depth: 'advanced', topic: 'news', days: 7, include_answer: true, max_results: 30 })
  assert.equal(args.searchDepth, 'advanced')
  assert.equal(args.topic, 'news')
  assert.equal(args.days, 7)
  assert.equal(args.includeAnswer, true)
  assert.equal(args.maxResults, 20)
})

test('normalizeArgs: domain filters', () => {
  const args = normalizeArgs({ query: 'x', include_domains: ['a.com', '', 42], exclude_domains: 'nope' })
  assert.deepEqual(args.includeDomains, ['a.com'])
  assert.deepEqual(args.excludeDomains, [])
})


test('normalizeExtractArgs: urls required, absolute http(s), trimmed', () => {
  assert.throws(() => normalizeExtractArgs({}), /at least one URL/)
  assert.throws(() => normalizeExtractArgs({ urls: [] }), /at least one URL/)
  assert.throws(() => normalizeExtractArgs({ urls: ['not a url'] }), /absolute URL/)
  assert.throws(() => normalizeExtractArgs({ urls: ['ftp://x.com'] }), /HTTP or HTTPS/)
  assert.deepEqual(normalizeExtractArgs({ urls: ['  https://a.com  '] }).urls, ['https://a.com'])
})

test('normalizeExtractArgs: optional fields validated', () => {
  const args = normalizeExtractArgs({ urls: ['https://a.com'], extract_depth: 'advanced', include_images: true, format: 'text', include_favicon: false, query: '  q  ' })
  assert.equal(args.extractDepth, 'advanced')
  assert.equal(args.includeImages, true)
  assert.equal(args.format, 'text')
  assert.equal(args.includeFavicon, false)
  assert.equal(args.query, 'q')
  assert.throws(() => normalizeExtractArgs({ urls: ['https://a.com'], extract_depth: 'deep' }), /one of basic, advanced/)
  assert.throws(() => normalizeExtractArgs({ urls: ['https://a.com'], include_images: 'yes' }), /must be a boolean/)
})

test('buildExtractBody: only includes provided fields', () => {
  const body = buildExtractBody({ urls: ['https://a.com'], extractDepth: 'advanced', includeImages: true, format: undefined, includeFavicon: undefined, query: undefined })
  assert.deepEqual(body, { urls: ['https://a.com'], extract_depth: 'advanced', include_images: true })
})

test('normalizeNavArgs: map requires absolute http(s) url', () => {
  assert.throws(() => normalizeNavArgs({}, { crawl: false }), /absolute URL/)
  assert.equal(normalizeNavArgs({ url: 'https://a.com' }, { crawl: false }).url, 'https://a.com')
})

test('normalizeNavArgs: positive ints and string lists validated', () => {
  assert.equal(normalizeNavArgs({ url: 'https://a.com', max_depth: 2, max_breadth: 3 }, { crawl: false }).maxDepth, 2)
  assert.throws(() => normalizeNavArgs({ url: 'https://a.com', max_depth: 0 }, { crawl: false }), /positive integer/)
  assert.deepEqual(normalizeNavArgs({ url: 'https://a.com', select_paths: [' /a ', 'b'] }, { crawl: false }).selectPaths, ['/a', 'b'])
  assert.throws(() => normalizeNavArgs({ url: 'https://a.com', select_paths: [1] }, { crawl: false }), /non-empty string/)
})

test('normalizeNavArgs: crawl adds its own optional fields', () => {
  const args = normalizeNavArgs({ url: 'https://a.com', extract_depth: 'advanced', format: 'markdown', chunks_per_source: 5 }, { crawl: true })
  assert.equal(args.crawl, true)
  assert.equal(args.extractDepth, 'advanced')
  assert.equal(args.format, 'markdown')
  assert.equal(args.chunksPerSource, 5)
  const map = normalizeNavArgs({ url: 'https://a.com', extract_depth: 'advanced' }, { crawl: false })
  assert.equal(map.extractDepth, undefined)
})

test('buildNavBody: map vs crawl bodies', () => {
  const map = buildNavBody({ crawl: false, url: 'https://a.com', instructions: 'blog', maxDepth: 2 })
  assert.deepEqual(map, { url: 'https://a.com', instructions: 'blog', max_depth: 2 })
  const crawl = buildNavBody({ crawl: true, url: 'https://a.com', extractDepth: 'advanced', format: 'markdown', chunksPerSource: 4 })
  assert.deepEqual(crawl, { url: 'https://a.com', extract_depth: 'advanced', format: 'markdown', chunks_per_source: 4 })
})

test('projectExtract: pages, failures, response time', () => {
  const out = projectExtract({
    results: [
      { url: 'https://a.com', raw_content: 'text', images: ['i.png', 42], favicon: 'f.ico' },
      { url: '' },
    ],
    failed_results: [{ url: 'https://bad.com', error: 'timeout' }],
    response_time: 123,
  })
  assert.deepEqual(out.results, [{ url: 'https://a.com', rawContent: 'text', images: ['i.png'], favicon: 'f.ico' }])
  assert.deepEqual(out.failedResults, [{ url: 'https://bad.com', error: 'timeout' }])
  assert.equal(out.responseTime, 123)
})

test('projectMap: urls and baseUrl', () => {
  const out = projectMap({ base_url: 'https://a.com', results: ['https://a.com/x', { url: 'https://a.com/y' }, null], response_time: 5 })
  assert.equal(out.baseUrl, 'https://a.com')
  assert.deepEqual(out.urls, ['https://a.com/x', 'https://a.com/y'])
  assert.equal(out.responseTime, 5)
})

test('projectCrawl: pages and baseUrl', () => {
  const out = projectCrawl({ base_url: 'https://a.com', results: [{ url: 'https://a.com/p', raw_content: 'c' }] })
  assert.equal(out.baseUrl, 'https://a.com')
  assert.deepEqual(out.results, [{ url: 'https://a.com/p', rawContent: 'c' }])
  assert.equal(out.responseTime, undefined)
})

test('normalizeResearchArgs: input required, `query` accepted as an alias', () => {
  assert.throws(() => normalizeResearchArgs({}), /input must be a non-empty string/)
  assert.throws(() => normalizeResearchArgs({ input: '   ' }), /input must be a non-empty string/)
  assert.equal(normalizeResearchArgs({ input: '  what is DSH?  ' }).input, 'what is DSH?')
  assert.equal(normalizeResearchArgs({ query: 'aliased' }).input, 'aliased')
})

test('normalizeResearchArgs: model default and the per-model wait default', () => {
  const auto = normalizeResearchArgs({ input: 'q' })
  assert.equal(auto.model, 'auto')
  assert.equal(auto.waitSeconds, 300)
  assert.equal(normalizeResearchArgs({ input: 'q', model: 'mini' }).waitSeconds, 120)
  assert.throws(() => normalizeResearchArgs({ input: 'q', model: 'max' }), /one of mini, pro, auto/)
})

test('normalizeResearchArgs: timeout_seconds is clamped and may be zero', () => {
  assert.equal(normalizeResearchArgs({ input: 'q', timeout_seconds: 0 }).waitSeconds, 0)
  assert.equal(normalizeResearchArgs({ input: 'q', timeout_seconds: 60 }).waitSeconds, 60)
  assert.equal(normalizeResearchArgs({ input: 'q', timeout_seconds: 5000 }).waitSeconds, 900)
  assert.throws(() => normalizeResearchArgs({ input: 'q', timeout_seconds: -1 }), /0 or more/)
  assert.throws(() => normalizeResearchArgs({ input: 'q', timeout_seconds: 'soon' }), /0 or more/)
})

test('normalizeResearchArgs: domains are capped at 20, enums validated', () => {
  assert.deepEqual(normalizeResearchArgs({ input: 'q', include_domains: [' a.com '] }).includeDomains, ['a.com'])
  const many = Array.from({ length: 21 }, (_, i) => 'd' + i + '.com')
  assert.throws(() => normalizeResearchArgs({ input: 'q', include_domains: many }), /at most 20/)
  assert.equal(normalizeResearchArgs({ input: 'q', citation_format: 'apa' }).citationFormat, 'apa')
  assert.throws(() => normalizeResearchArgs({ input: 'q', citation_format: 'ieee' }), /one of numbered, mla, apa, chicago/)
  assert.throws(() => normalizeResearchArgs({ input: 'q', output_length: 'huge' }), /one of short, standard, long/)
})

test('normalizeResearchArgs: output_schema must carry a non-empty properties object', () => {
  const schema = { properties: { author: { type: 'string', description: 'Who' } }, required: ['author'] }
  assert.deepEqual(normalizeResearchArgs({ input: 'q', output_schema: schema }).outputSchema, schema)
  assert.equal(normalizeResearchArgs({ input: 'q' }).outputSchema, undefined)
  assert.throws(() => normalizeResearchArgs({ input: 'q', output_schema: {} }), /properties object/)
  assert.throws(() => normalizeResearchArgs({ input: 'q', output_schema: 'nope' }), /JSON Schema object/)
  assert.throws(() => normalizeResearchArgs({ input: 'q', output_schema: { properties: { a: {} }, required: 'a' } }), /required must be an array/)
})

test('buildResearchBody: only includes provided fields, always input + model', () => {
  const minimal = buildResearchBody(normalizeResearchArgs({ input: 'q' }))
  assert.deepEqual(minimal, { input: 'q', model: 'auto' })
  const full = buildResearchBody(normalizeResearchArgs({
    input: 'q',
    model: 'pro',
    citation_format: 'mla',
    output_length: 'long',
    include_domains: ['a.com'],
    exclude_domains: ['b.com'],
    output_schema: { properties: { a: { type: 'string', description: 'A' } } },
  }))
  assert.deepEqual(full, {
    input: 'q',
    model: 'pro',
    citation_format: 'mla',
    output_length: 'long',
    include_domains: ['a.com'],
    exclude_domains: ['b.com'],
    output_schema: { properties: { a: { type: 'string', description: 'A' } } },
  })
})

test('isTerminalResearchStatus', () => {
  assert.equal(isTerminalResearchStatus('completed'), true)
  assert.equal(isTerminalResearchStatus('failed'), true)
  assert.equal(isTerminalResearchStatus('pending'), false)
  assert.equal(isTerminalResearchStatus('in_progress'), false)
})

test('projectResearch: in-progress and failed shapes', () => {
  assert.deepEqual(projectResearch({ request_id: 'r1', status: 'in_progress', response_time: 0.01 }),
    { requestId: 'r1', status: 'in_progress', responseTime: 0.01 })
  assert.deepEqual(projectResearch({ request_id: 'r1', status: 'failed', response_time: 1, usage: { credits: 0 } }),
    { requestId: 'r1', status: 'failed', responseTime: 1, credits: 0 })
  assert.deepEqual(projectResearch({}), { requestId: '', status: 'unknown' })
})

test('projectResearch: a completed prose report keeps content and sources', () => {
  const out = projectResearch({
    request_id: 'r1',
    status: 'completed',
    created_at: '2026-10-09T11:34:12.585747+00:00',
    content: 'Body [1]',
    sources: [
      { url: 'https://a.com', title: 'A', favicon: 'f.ico' },
      { url: 'https://b.com' },
      { title: 'no url' },
      null,
    ],
    response_time: 12.71,
    usage: { credits: 7 },
  })
  assert.equal(out.content, 'Body [1]')
  assert.equal(out.contentType, undefined)
  assert.deepEqual(out.sources, [
    { url: 'https://a.com', title: 'A', favicon: 'f.ico' },
    { url: 'https://b.com' },
  ])
  assert.equal(out.credits, 7)
  assert.equal(out.responseTime, 12.71)
  assert.equal(out.createdAt, '2026-10-09T11:34:12.585747+00:00')
})

test('projectResearch: a structured report is serialized and flagged', () => {
  const out = projectResearch({ request_id: 'r1', status: 'completed', content: { author: 'Masinter', year: 1998 } })
  assert.equal(out.contentType, 'json')
  assert.deepEqual(JSON.parse(out.content), { author: 'Masinter', year: 1998 })
})

test('projectResearch: a completed task without sources omits the key', () => {
  const out = projectResearch({ request_id: 'r1', status: 'completed', content: 'x', sources: [] })
  assert.equal(out.sources, undefined)
})
