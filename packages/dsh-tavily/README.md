# @moguiyu/dsh-tavily

Everything in one package: the advanced Tavily model tools (`tavily_search`, `tavily_extract`,
`tavily_map`, `tavily_crawl`, `tavily_research`, `tavily_get_research`), the key/usage HTTP
routes, and the browser card on the **Plugins** page.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`).
- **`tavily_extract` / `tavily_map` / `tavily_crawl`** — read a known URL's content, map a
  site's links, or crawl a site and return its pages. Same key-rotation/failover as search.
- **`tavily_research` / `tavily_get_research`** — Tavily's Research endpoint: queue a task
  (`model`: `mini` / `pro` / `auto`, plus `citation_format`, `output_length`, domain filters and an
  optional `output_schema`), wait for it, and get a synthesized, cited report; the second tool
  collects a task that outlived the first call. Research is billed per request and far above
  search — **mini 4-110 credits, pro 15-250**, against 1-2 for a search — so it is a per-call
  choice, never a default. `timeout_seconds: 0` queues the task and returns its id immediately.
- **Card** — key list, usage gauge, and the strategy selector. It registers into the Plugins
  page's `plugins.bundle.config` slot, keyed `@moguiyu/dsh-tavily`, and needs DSH
  **0.1.6-alpha.2 or newer** — the release that retired `settings.plugin.item` and moved plugin
  configuration off the Settings page. On older lines the tools and routes work; there is simply
  no card.
- **`web_search` is never replaced** — no `ctx.web` provider is registered and
  `web.searchProvider` is never rewritten; the built-in `web_search` keeps its native provider
  and schema.

Host half: plain ESM (`src/index.js`, `src/tools.js`, `src/backend.js`, `src/lib.js`). Client
half: prebuilt `window.__ModuleLoader__` bundle at `lib/client.js`, generated from
`src/client.js` via `pnpm build`.

Earlier releases split this across `@moguiyu/dsh-tool-tavily-search` and
`@moguiyu/dsh-tavily-backend`, which this package imported as regular dependencies. From 0.3.0
both are folded in here: one package means no dependency range can drift behind the contract,
which is exactly how the old tool-level switch broke. Both old packages are deprecated.

There is no tool-level on/off switch. Composing the plugin registers the tools, and the Plugins
page's own bundle toggle is the only on/off.

## Compatibility

Verified on `0.1.6-alpha.2`, `0.1.7-rc.2`, `0.2.0-rc.2`, the `0.2.1-rc` line and the `0.2.2-rc`
line, and expected to work on every declared line back to `0.1.0-rc.7`; the peer ranges list one
comparator per host line. Installability is decided by those peer ranges, so a harness upgrade
never needs a plugin-side flag — and an in-place update from the Plugins page is safe: the plugin
disposes the tool half on removal, so the replacing version always starts from a clean slate.

See the [workspace README](https://github.com/moguiyu/dsh-tavily#readme) for install and
configuration.
