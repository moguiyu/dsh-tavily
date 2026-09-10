/**
 * Live seam verification against the harness line this machine actually runs
 * (0.1.5-rc.2 through ~/.dsh/profiles/node_modules) and the published /
 * installed @moguiyu/dsh-tavily from ~/.dsh/profiles/web/node_modules.
 *
 * Setup (one-time, the symlink dir is git-ignored):
 *   mkdir -p verify-015/node_modules
 *   ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai" verify-015/node_modules/@deepseek-ai
 *   ln -sfn "$HOME/.dsh/profiles/web/node_modules/@moguiyu" verify-015/node_modules/@moguiyu
 *   node verify-015/seam.mjs
 *
 * Boots the real SettingsProvider / ToolRuntime / SystemPrompt of the running
 * harness line, then checks the §8 gates that are checkable without a browser:
 * which settings seam the plugin feature-detects, that describe() serves the
 * namespace, that a real settings.update drives the switch pipeline (state
 * file), and that tavily_search is registered on the real tool runtime while
 * web_search is never involved.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-015-'))
const home = process.env.DSH_HOME
console.log('DSH_HOME=' + home)

const { Context } = await import('@deepseek-ai/cordis')
const { default: SettingsProvider } = await import('@deepseek-ai/dsh-settings')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const combined = await import('@moguiyu/dsh-tavily')
const cordisPkg = (await import('@deepseek-ai/cordis/package.json', { with: { type: 'json' } })).default

const profilePkg = join(process.env.HOME, '.dsh/profiles/web/node_modules/@moguiyu/dsh-tavily/package.json')
console.log('plugin under test: @moguiyu/dsh-tavily ' + JSON.parse(readFileSync(profilePkg, 'utf8')).version)
console.log('harness cordis: ' + cordisPkg.version)

const settingsFile = join(home, 'settings.json')
class FileSettingsProvider extends SettingsProvider {
  get writable() { return true }
  get documentPath() { return settingsFile }
  async load() {
    try { return JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { return {} }
  }
  async persist(ns, section) {
    const doc = await this.load()
    doc[ns] = section
    writeFileSync(settingsFile, JSON.stringify(doc, null, 2))
  }
}

const ctx = new Context()
const routes = new Map()
const restartCalls = []

await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, {})
await ctx.plugin({
  name: 'web-server-test',
  apply(inner) {
    inner.provide('webServer', {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    })
  },
})
await ctx.plugin({
  name: 'loader-test',
  apply(inner) {
    inner.provide('loader', {
      resolve(id) {
        restartCalls.push(id)
        return { fiber: { update: async () => { restartCalls.push(id + ':update') } } }
      },
    })
  },
})
await ctx.plugin({
  name: 'credentials-test',
  apply(inner) {
    inner.provide('credentials', {
      resolve: async () => ({ value: 'fake-key', source: 'test' }),
      describe: async () => ({ configured: true }),
      set: async () => {},
      unset: async () => {},
    })
  },
})
await ctx.plugin(FileSettingsProvider)

const fiber = ctx.plugin(combined, { enabled: true })
await fiber

const results = []
const check = (name, fn) => { fn(); results.push('ok - ' + name) }

const settings = ctx.get('settings')
check('settings service attached (real 0.1.5 provider)', () => assert.ok(settings))

const descriptors = settings.describe()
const ns = descriptors.find((d) => d.ns === 'tavily-search')
check('describe() serves the tavily-search namespace', () => assert.ok(ns, JSON.stringify(descriptors.map((d) => d.ns))))
check('row config is the composition base layer', () => assert.deepEqual(ns.base, { enabled: true }))
check("applies resolved to 'live' (the documented installSection line)", () => assert.equal(ns.applies, 'live'))
console.log('   -> seam selection: installSection=' + typeof settings.installSection +
  ', register=' + typeof settings.register + ', applies=' + ns.applies)

const tools = ctx.get('tools')
check('tavily_search registered on the real 0.1.5 tool runtime', () => assert.ok(tools.get('tavily_search')))
check('web_search is never registered or replaced here', () => assert.equal(tools.get('web_search'), undefined))
check('the plugin does not inject the web seam', () => assert.ok(!combined.inject.includes('web')))
check('backend routes registered on the real webServer seam', () => {
  for (const p of ['/api/tavily-usage', '/api/tavily-manager', '/api/tavily-tool']) assert.ok(routes.has(p), p)
})

await settings.update('tavily-search', { enabled: false })
await new Promise((r) => setTimeout(r, 30))
check('settings.update drives the switch pipeline (state file mirrors the namespace)', () => {
  const stateFile = join(home, 'tavily-tool.json')
  assert.ok(existsSync(stateFile), stateFile)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { enabled: false })
})
check('the row restart went through the loader seam', () =>
  assert.ok(restartCalls.includes('include:dsh-tavily:update'), JSON.stringify(restartCalls)))

console.log(results.join('\n'))
console.log('live 0.1.5-rc.2 seam verification: PASS (' + results.length + ' checks)')
