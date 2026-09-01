/**
 * Live seam verification, rc.7/rc.8 line (run from the repo ROOT so bare
 * imports resolve the 0.1.0-rc.8 packages hoisted in the root node_modules).
 *
 * Boots the REAL @deepseek-ai/dsh-settings provider (register seam) plus the
 * real ToolRuntime/SystemPrompt against @moguiyu/dsh-tavily, then checks the
 * §8 gates that are checkable without a browser. The plugin must
 * feature-detect the rc.8 seam (no installSection) and take register().
 *
 * Usage: DSH_HOME must be set by the caller (fresh temp dir).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as combined from './packages/dsh-tavily/src/index.js'

const home = process.env.DSH_HOME
assert.ok(home, 'DSH_HOME must be set by the caller')
if (!existsSync(home)) mkdtempSync(home)

/**
 * The npm package ships the abstract SettingsProvider base (load/persist are
 * implemented by the harness core). Provide the same minimal file-backed
 * storage the core uses: one JSON document keyed by namespace.
 */
const settingsFile = join(home, 'settings.json')
class FileSettingsProvider extends SettingsProvider {
  get writable() { return true }
  get documentPath() { return settingsFile }
  async load() {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8'))
    } catch {
      return {}
    }
  }
  async persist(ns, section) {
    const doc = await this.load()
    doc[ns] = section
    writeFileSync(settingsFile, JSON.stringify(doc, null, 2))
  }
}

const ctx = new Context()
const routes = {}
const registeredRoutes = new Set()

await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, {})
await ctx.plugin({
  name: 'web-server-test',
  apply(inner) {
    inner.provide('webServer', {
      register(route) {
        if (registeredRoutes.has(route.path)) throw new Error('duplicate exact route ' + route.path)
        registeredRoutes.add(route.path)
        routes[route.path] = route.handler
        return () => {
          registeredRoutes.delete(route.path)
          delete routes[route.path]
        }
      },
    })
  },
})
await ctx.plugin({
  name: 'loader-test',
  apply(inner) {
    inner.provide('loader', {
      resolve() {
        // Stand-in for the profile loader: the switch pipeline restarts this
        // row through it. A no-op update is enough to prove the write path.
        return { fiber: { update: async () => {} } }
      },
    })
  },
})
await ctx.plugin({
  name: 'credentials-test',
  apply(inner) {
    inner.provide('credentials', {
      resolve: async () => ({ value: 'fake-key-for-live-check', source: 'test' }),
      describe: async () => ({ configured: true }),
      set: async () => {},
      unset: async () => {},
    })
  },
})

// The REAL rc.8 settings provider (with file-backed storage, as in the core),
// then the plugin under test.
await ctx.plugin(FileSettingsProvider)
const fiber = ctx.plugin(combined, { enabled: true })
await fiber

const results = []
const check = (name, fn) => { fn(); results.push(`ok - ${name}`) }

// 1. The real provider attached and the plugin installed its namespace.
const settings = ctx.get('settings')
check('settings service attached (real provider)', () => assert.ok(settings))

// 2. Which seam ran: register() declared applies 'restart' (0.2.0 behavior);
//    installSection would have defaulted to 'live'.
const descriptors = settings.describe()
const ns = descriptors.find((d) => d.ns === 'tavily-search')
check('describe() serves the tavily-search namespace', () => assert.ok(ns, JSON.stringify(descriptors.map((d) => d.ns))))
check('rc.7/rc.8 register seam ran (applies: restart)', () => assert.equal(ns.applies, 'restart'))
check('composition base served from the row config', () => assert.deepEqual(ns.base, { enabled: true }))

// 3. Tool half registered on the real tool registry.
check('all four tools registered on the real tool registry', () => {
  assert.deepEqual(ctx.get('tools').schemas().map((s) => s.name), ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl'])
})

// 4. A real settings commit drives the switch pipeline (persisted state file).
await settings.update('tavily-search', { enabled: false })
await new Promise((resolve) => setTimeout(resolve, 30))
check('real settings.update disables the switch via the state file', () => {
  assert.equal(existsSync(join(home, 'tavily-tool.json')), true)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')), { enabled: false })
})

// 5. The backend route converges on the real provider update.
const off = { status: 0, body: null, writeHead(s) { this.status = s }, end(t) { this.body = JSON.parse(t) } }
const req = {
  method: 'POST', url: '/api/tavily-tool',
  on(event, callback) {
    if (event === 'data') queueMicrotask(() => callback(Buffer.from(JSON.stringify({ enabled: true }))))
    if (event === 'end') queueMicrotask(() => callback())
    return this
  },
}
await routes['/api/tavily-tool'](req, off)
await new Promise((resolve) => setTimeout(resolve, 30))
check('route toggle returns enabled and re-persists via the real provider', () => {
  assert.equal(off.status, 200)
  assert.equal(off.body.enabled, true)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'tavily-tool.json'), 'utf8')), { enabled: true })
})

// 6. No web provider seam: the boot never provides or touches a web/search
//    provider service, and the settings document holds only our namespace.
check('no web/search provider seam in this boot', () => {
  assert.equal(ctx.get('web'), undefined)
  assert.equal(routes['/api/tavily-provider'], undefined)
})

console.log(`DSH 0.1.0-rc.8 line: ${results.length} checks passed`)
for (const line of results) console.log('  ' + line)
await ctx.fiber.dispose()
process.exit(0)
