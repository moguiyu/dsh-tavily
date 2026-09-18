/**
 * Live seam verification against the harness line this machine actually runs
 * (currently 0.1.6-alpha.1, resolved through ~/.dsh/profiles/node_modules) and
 * the published / installed @moguiyu/dsh-tavily from
 * ~/.dsh/profiles/web/node_modules.
 *
 * Setup (one-time, the symlink dir is git-ignored). The plugin link must point
 * at the WORKING TREE, not at node_modules/@moguiyu: pnpm can relink that entry
 * to a published store copy, and this script would then silently verify a
 * released version instead of the sources under edit.
 *   mkdir -p verify-016/node_modules
 *   ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai" verify-016/node_modules/@deepseek-ai
 *   mkdir -p verify-016/node_modules/@moguiyu
 *   ln -sfn "$PWD/packages/dsh-tavily" verify-016/node_modules/@moguiyu/dsh-tavily
 *   node verify-016/verify-0.1.6.seam.mjs
 *
 * Boots the real ToolRuntime / SystemPrompt / webServer of the running harness
 * line, then checks the gates that are checkable without a browser: the four
 * Tavily tools register on the real tool runtime, `web_search` is never
 * involved, and the plugin injects neither the web seam nor the loader seam.
 *
 * The loader seam matters: it existed only so the switch could restart the
 * composing row, which on 0.1.6 re-mounted the fiber into a scope the agent
 * does not see. The plugin no longer injects it at all, and this script
 * asserts nothing ever resolves through it.
 *
 * It also asserts the REMOVALS, because a silent re-introduction is the failure
 * mode here: no `tavily-search` settings namespace, and no `/api/tavily-tool`
 * or `/api/tavily-toggle` route.
 * */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-016-'))
const home = process.env.DSH_HOME
console.log('DSH_HOME=' + home)

const { Context } = await import('@deepseek-ai/cordis')
const { default: SettingsProvider } = await import('@deepseek-ai/dsh-settings')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const combined = await import('@moguiyu/dsh-tavily')
const cordisPkg = (await import('@deepseek-ai/cordis/package.json', { with: { type: 'json' } })).default

const HARNESS_DEPS = ['dsh-settings', 'dsh-tools', 'dsh-home-paths']
const harnessVersions = {}
for (const dep of HARNESS_DEPS) {
  const meta = await import('@deepseek-ai/' + dep + '/package.json', { with: { type: 'json' } })
  harnessVersions['@deepseek-ai/' + dep] = meta.default.version
}
// The whole install moves in lockstep; the seam package names the line.
const HARNESS = harnessVersions['@deepseek-ai/dsh-settings']

const combinedPkg = (await import('@moguiyu/dsh-tavily/package.json', { with: { type: 'json' } })).default
const combinedDir = fileURLToPath(new URL('node_modules/@moguiyu/dsh-tavily', import.meta.url))

console.log('harness line: ' + HARNESS +
  '  (' + HARNESS_DEPS.map((d) => d + ' ' + harnessVersions['@deepseek-ai/' + d]).join(', ') + ')')
console.log('harness cordis: ' + cordisPkg.version)
console.log('plugin under test: @moguiyu/dsh-tavily ' + combinedPkg.version + '  (' + combinedDir + ')')

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
const tools = ctx.get('tools')
const TOOL_NAMES = ['tavily_search', 'tavily_extract', 'tavily_map', 'tavily_crawl']

check('all four Tavily tools registered on the real ' + HARNESS + ' tool runtime', () => {
  for (const n of TOOL_NAMES) assert.ok(tools.get(n), n)
})
check('web_search is never registered or replaced here', () => assert.equal(tools.get('web_search'), undefined))
check('the plugin does not inject the web seam', () => assert.ok(!combined.inject.includes('web')))
check('the plugin does not inject the loader seam (no row restart is possible)', () =>
  assert.ok(!combined.inject.includes('loader'), 'loader existed only for the removed row restart'))

// REMOVAL GATES. The switch owned a settings namespace; both are gone, and a
// silent re-introduction would revive a contract the tool half can no longer
// honour. These fail loudly if either comes back.
check('the plugin registers no settings namespace', () => {
  const descriptors = settings.describe()
  assert.equal(descriptors.find((d) => d.ns === 'tavily-search'), undefined,
    'the tavily-search namespace belonged to the removed switch')
})

// Metadata gate (§4): the repo's declared peer ranges must accept the very
// harness we just booted. A new host tuple does NOT cascade through prerelease
// comparators, so this fails the moment a line ships undeclared — which is
// exactly what happened when 0.1.6 landed.
const harnessRequire = createRequire(join(process.env.HOME, '.dsh/profiles/node_modules/@deepseek-ai/dsh-settings/package.json'))
const semver = harnessRequire('semver')
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
check('repo peer ranges accept the running ' + HARNESS, () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/dsh-tavily', 'package.json'), 'utf8'))
  for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (dep === '@deepseek-ai/cordis') continue
    const running = harnessVersions[dep]
    assert.ok(running, 'no resolved version for ' + dep)
    assert.ok(semver.satisfies(running, range), pkg.name + ': ' + dep + '@' + running + ' does not satisfy "' + range + '"')
  }
})

check('key and usage routes registered on the real webServer seam', () => {
  for (const p of ['/api/tavily-usage', '/api/tavily-manager']) assert.ok(routes.has(p), p)
})
check('no tool-switch route exists', () => {
  for (const p of ['/api/tavily-tool', '/api/tavily-toggle']) assert.equal(routes.has(p), false, p)
})
check('nothing ever resolved through the loader seam', () => assert.deepEqual(restartCalls, []))

// Unloading the fiber must leave nothing registered — this is the guarantee
// that replaced the switch (and what the Plugins page's runtime unload uses).
await fiber.dispose()
check('unloading the row unregisters every tool', () => {
  for (const n of TOOL_NAMES) assert.equal(tools.get(n), undefined, n)
})

console.log(results.join('\n'))
console.log('live ' + HARNESS + ' seam verification: PASS (' + results.length + ' checks)')
