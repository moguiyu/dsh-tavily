# @moguiyu/dsh-tavily

Registers a Tavily `WebSearchProvider` into DSH's `ctx.web` capability seam under the `tavily`
provider id. Its bundle config selects that provider for DSH's native `web_search` tool.

- **`web_search`** — the native DSH tool, served by Tavily with generated answers and citeable sources.
- **`tavily_extract`** — extract complete page content from known URLs.
- **`tavily_map`** — discover URLs in a site without extracting their content.
- **`tavily_crawl`** — discover and extract content across a site.
- **Settings card** (`settings.plugin.item`, id `tavily-search`) — masked key management, usage strategy, and usage gauge.

Every Tavily operation resolves `TAVILY_API_KEYS` on request, rotates through the configured keys,
and retries the next key after HTTP 401 or 429. `TAVILY_API_KEY` remains a legacy fallback.

Host half: plain ESM (`src/index.js`). Client half: prebuilt `window.__ModuleLoader__` bundle
at `lib/client.js`, generated from `src/client.js` via `pnpm build`.

See the [workspace README](../../README.md) for install and configuration.
