import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractBody,
  buildNavBody,
  clampInt,
  isToolEnabled,
  normalizeArgs,
  normalizeExtractArgs,
  normalizeNavArgs,
  projectCrawl,
  projectExtract,
  projectMap,
} from '../src/index.js'

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

test('isToolEnabled: persisted state wins over plugin config', () => {
  assert.equal(isToolEnabled({ enabled: true }, { enabled: false }), false)
  assert.equal(isToolEnabled({ enabled: false }, { enabled: true }), true)
})

test('isToolEnabled: falls back to plugin config when no state is stored', () => {
  assert.equal(isToolEnabled({ enabled: true }, null), true)
  assert.equal(isToolEnabled({ enabled: false }, null), false)
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
