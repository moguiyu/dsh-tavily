/**
 * `@moguiyu/dsh-tavily` combined package: the advanced `tavily_search` model
 * tool plus the local HTTP backend for usage and key management. The
 * implementations live in the two standalone packages and are composed here,
 * so there is exactly one copy of each:
 *
 * - tool half — `@moguiyu/dsh-tool-tavily-search` {@link installTavilyTool};
 * - backend half — `@moguiyu/dsh-tavily-backend` {@link installBackend}.
 *
 * This package adds the plugin-management seam: the Host installs the
 * `tavily-search` settings section (the key the Plugins configuration tab
 * pairs the card against). The switch value lives both in that namespace and
 * in `~/.dsh/tavily-tool.json`; every write path converges on
 * `settings.update` (or the state file when no settings service exists),
 * persisted first, then the row restarts itself so the tool registers or
 * unregisters cleanly.
 *
 * The settings-card switch controls ONLY the opt-in `tavily_search` tool. The
 * built-in `web_search` tool is never replaced: this package registers no web
 * search provider and never rewrites `web.searchProvider` — `web_search`
 * keeps its native provider.
 */
import z from '@deepseek-ai/schemastery'
import { isToolEnabled, installTavilyTool } from '@moguiyu/dsh-tool-tavily-search'
import { installBackend, readToolState, restoreToolState, writeToolState } from '@moguiyu/dsh-tavily-backend'

export const name = 'dsh-tavily'

export const inject = ['tools', 'webServer', 'credentials', 'systemPrompt', 'loader']

export const Config = z.object({
  enabled: z.boolean().default(false),
})

/**
 * Settings namespace owned by this package. It is the join key between the
 * Host half and the browser card: the Plugins configuration tab serves this
 * namespace and dispatches the card registered under the same key. A plain
 * lowercase-hyphenated string, valid on every supported host line: rc.7/rc.8
 * treat the namespace as a branded string (runtime-identical), and 0.1.2
 * validates and brands it on registration (`settingsNamespace()` was
 * removed upstream).
 */
export const TAVILY_NS = 'tavily-search'

export function apply(ctx, config) {
  // The switch value the current fiber is acting on. Every write path updates
  // this before the row restart so a watcher re-fired after a restart no-ops.
  let lastApplied = isToolEnabled(config)
  // Settings seam state: the attached provider (null on hosts without one)
  // and the authoritative switch source — the resolved section while the
  // provider is attached, the composition entry otherwise.
  let settingsProvider = null
  let settingsSource = () => config

  /** Persist the switch first, then restart this row so the tool (un)registers. */
  async function applySwitchLocal(enabled) {
    if (enabled === lastApplied) return
    lastApplied = enabled
    const previous = readToolState()
    writeToolState(enabled)
    try {
      const loader = ctx.get('loader')
      const self = loader !== undefined && loader !== null ? loader.resolve('include:dsh-tavily') : undefined
      if (self === undefined || self === null || self.fiber === undefined) {
        throw new Error('dsh-tavily: row include:dsh-tavily is not loaded')
      }
      await self.fiber.update({ enabled }, true)
    } catch (error) {
      lastApplied = previous !== null ? previous.enabled : (config.enabled !== false)
      restoreToolState(previous)
      throw error
    }
  }

  /** Re-judge the switch from a resolved settings value (either seam's shape). */
  function applySwitchValue(value) {
    const nextEnabled = value !== null && typeof value === 'object' && typeof value.enabled === 'boolean'
      ? value.enabled
      : false
    applySwitchLocal(nextEnabled).catch((error) => {
      ctx.logger.warn('tavily-search: applying settings switch failed: %s', error instanceof Error ? error.message : String(error))
    })
  }

  // First-class settings integration: install the `tavily-search` section so
  // the Plugins configuration surface serves it and pairs this package's
  // card. Runtime-optional on purpose: the row boots (state-file path) even
  // on hosts that never provide a settings service. Two host seams are
  // supported by feature detection, so ONE package version covers both host
  // lines:
  //
  // - 0.1.2 (`installSection`) — the row config is the composition entry
  //   (base layer while a provider is attached, fallback value when one
  //   detaches); `onChange` re-judges the switch on attach, on detach, and
  //   on every committed change.
  // - rc.7/rc.8 (`register`) — the row config is the composition base layer
  //   and the scope watcher re-judges the switch on every committed change
  //   (`applies: 'restart'`, the 0.2.0 behavior).
  ctx.inject(['settings'], (settingsCtx) => {
    const provider = settingsCtx.settings
    try {
      if (typeof provider.installSection === 'function') {
        provider.installSection(ctx, TAVILY_NS, Config, config, {
          setSource: (current) => { settingsSource = current },
          onChange: () => { applySwitchValue(settingsSource()) },
        })
        settingsProvider = provider
        return
      }
      if (typeof provider.register === 'function') {
        const scope = provider.register(TAVILY_NS, Config, {
          base: { enabled: config.enabled },
          applies: 'restart',
        })
        if (scope !== undefined && scope !== null && typeof scope.watch === 'function') {
          scope.watch((next) => { applySwitchValue(next) })
          settingsProvider = provider
        } else {
          ctx.logger.warn('tavily-search: settings scope exposes no watcher; using the state-file path')
        }
        return
      }
      ctx.logger.warn('tavily-search: settings service exposes neither installSection nor register; using the state-file path')
    } catch (error) {
      ctx.logger.warn('tavily-search: settings section installation failed: %s', error instanceof Error ? error.message : String(error))
    }
  })

  installBackend(ctx, {
    enabled: () => isToolEnabled(config),
    async applySwitch(enabled) {
      // Every write converges on one pipeline: the settings namespace when a
      // settings service is attached (its watcher persists and restarts this
      // row), or the plain state-file path otherwise.
      if (settingsProvider !== null) {
        await settingsProvider.update(TAVILY_NS, { enabled })
      } else {
        await applySwitchLocal(enabled)
      }
    },
  })

  if (!isToolEnabled(config)) return
  installTavilyTool(ctx)
}
