/**
 * `@moguiyu/dsh-tavily` — the combined plugin, and now the only package.
 *
 * Both halves live here, so there is no cross-package contract left to skew:
 *
 * - the model tools (`tools.js`) — `tavily_search`, `tavily_extract`,
 *   `tavily_map`, `tavily_crawl`, with key rotation and failover on 401/429;
 * - key and usage management (`backend.js`) — `/api/tavily-usage` and
 *   `/api/tavily-manager`;
 * - the browser card (`client.js`) — keys, usage, and strategy.
 *
 * Composing the plugin registers the tools. There is NO tool-level on/off:
 * the Plugins page's own bundle toggle is the only one. Two earlier designs
 * are gone deliberately, both recorded in `docs/agents/verification.md`:
 *
 * 1. A row restart. On 0.1.6 it re-mounts the fiber into a scope the agent
 *    does not see, so the tools ended up registered nowhere and stayed
 *    missing, process-wide, until dsh restarted.
 * 2. A tool-level switch split across packages. The combined package needed a
 *    disposer from the tool half, but its dependency range still allowed the
 *    old tool half, so `installTavilyTool` returned `undefined` and turning
 *    the switch off threw. One package removes the range as a failure mode.
 *
 * The built-in `web_search` tool is never replaced: no web search provider is
 * registered, `web.searchProvider` / `DSH_WEB_SEARCH_PROVIDER` are never
 * rewritten, and `ctx.web` is untouched.
 */
import { installTavilyTool } from './tools.js'
import { installBackend } from './backend.js'

export const name = 'dsh-tavily'

export const inject = ['tools', 'webServer', 'credentials', 'systemPrompt']

export function apply(ctx) {
  const disposeTools = installTavilyTool(ctx)
  installBackend(ctx)

  // The fiber owns the teardown: unloading the row — including the Plugins
  // page's runtime unload on 0.1.6-alpha.2 — unregisters every tool and
  // prompt section this row added.
  ctx.effect(() => () => { disposeTools() })
}
