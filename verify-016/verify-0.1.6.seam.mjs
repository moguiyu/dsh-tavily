/**
 * Live seam verification against the harness line this machine actually runs
 * (currently 0.1.6-alpha.1, resolved through ~/.dsh/profiles/node_modules) and
 * the published / installed @moguiyu/dsh-tavily from
 * ~/.dsh/profiles/web/node_modules.
 *
 * Setup (one-time, the symlink dir is git-ignored):
 *   mkdir -p verify-016/node_modules
 *   ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai" verify-016/node_modules/@deepseek-ai
 *   ln -sfn "$HOME/.dsh/profiles/web/node_modules/@moguiyu" verify-016/node_modules/@moguiyu
 *   node verify-016/verify-0.1.6.seam.mjs
 *
 * Boots the real SettingsProvider / ToolRuntime / SystemPrompt of the running
 * harness line, then checks the §8 gates that are checkable without a browser:
 * which settings seam the plugin feature-detects, that describe() serves the
 * namespace, that a real settings.update drives the switch pipeline (state
 * file), and that tavily_search is registered on the real tool runtime while
 * web_search is never involved.
 *
 * Every label reports the harness version *actually resolved*, so this script
 * cannot claim to have verified a line it did not run against. The peer-range
 * check asserts this repo's declared ranges accept that same version — the
 * pre-publish metadata gate that silently drifted when 0.1.6 shipped (§4).
 */
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

const installedDir = join(process.env.HOME, '.dsh/profiles/web/node_modules/@moguiyu/dsh-tavily')
const installedPkg = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))

console.log('harness line: ' + HARNESS +
  '  (' + HARNESS_DEPS.map((d) => d + ' ' + harnessVersions['@deepseek-ai/' + d]).join(', ') + ')')
console.log('harness cordis: ' + cordisPkg.version)
console.log('plugin under test: @moguiyu/dsh-tavily ' + installedPkg.version)

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
check('settings service attached (real ' + HARNESS + ' provider)', () => assert.ok(settings))

const descriptors = settings.describe()
const ns = descriptors.find((d) => d.ns === 'tavily-search')
check('describe() serves the tavily-search namespace', () => assert.ok(ns, JSON.stringify(descriptors.map((d) => d.ns))))
check('row config is the composition base layer', () => assert.deepEqual(ns.base, { enabled: true }))
check("applies resolved to 'live' (the documented installSection line)", () => assert.equal(ns.applies, 'live'))
console.log('   -> seam selection: installSection=' + typeof settings.installSection +
  ', register=' + typeof settings.register + ', applies=' + ns.applies)

const tools = ctx.get('tools')
check('tavily_search registered on the real ' + HARNESS + ' tool runtime', () => assert.ok(tools.get('tavily_search')))
check('web_search is never registered or replaced here', () => assert.equal(tools.get('web_search'), undefined))
check('the plugin does not inject the web seam', () => assert.ok(!combined.inject.includes('web')))

// Metadata gate (§4, §9 gate 6): the repo's declared peer ranges must accept the
// very harness we just booted. A new host tuple does NOT cascade through
// prerelease comparators, so this fails loudly the moment a line ships
// undeclared — which is exactly what happened when 0.1.6 landed.
const harnessRequire = createRequire(join(process.env.HOME, '.dsh/profiles/node_modules/@deepseek-ai/dsh-settings/package.json'))
const semver = harnessRequire('semver')
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
check('repo peer ranges accept the running ' + HARNESS, () => {
  for (const dir of ['packages/dsh-tavily', 'packages/dsh-tavily-backend', 'packages/dsh-tool-tavily-search']) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'))
    for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (dep === '@deepseek-ai/cordis') continue
      const running = harnessVersions[dep]
      assert.ok(running, 'no resolved version for ' + dep)
      assert.ok(semver.satisfies(running, range), pkg.name + ': ' + dep + '@' + running + ' does not satisfy "' + range + '"')
    }
  }
})

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
console.log('live ' + HARNESS + ' seam verification: PASS (' + results.length + ' checks)')
