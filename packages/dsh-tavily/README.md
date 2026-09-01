# @moguiyu/dsh-tavily

Combined plugin: the opt-in advanced Tavily model tools (`tavily_search`, `tavily_extract`,
`tavily_map`, `tavily_crawl`), the **Tavily Search** settings card, and the local HTTP backend
for key/usage management.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`). Opt-in and
  off by default.
- **`tavily_extract` / `tavily_map` / `tavily_crawl`** — read a known URL's content, map a
  site's links, or crawl a site and return its pages. Same key-rotation/failover as search.
- **Settings card** — key list, usage gauge, strategy selector, and the advanced-tool switch.
- **Plugin-config settings card** — the Host installs the `tavily-search` settings section
  and the card is keyed by it (keyed `settings.plugin.item`), so the Plugins configuration tab
  serves the card exactly when this plugin is composed (needs DSH **0.1.0-rc.7 or newer**,
  including `0.1.2-alpha.x` — both seam generations are detected at runtime).
  The switch writes the namespace and restarts the row; the choice is mirrored to
  `~/.dsh/tavily-tool.json`.
- **`web_search` is never replaced** — no `ctx.web` provider is registered and
  `web.searchProvider` is never rewritten; the built-in DeepSeek `web_search` keeps its
  native provider and schema. Tavily is an extra, opt-in search option.

Host half: plain ESM (`src/index.js`). Client half: prebuilt `window.__ModuleLoader__` bundle
at `lib/client.js`, generated from `src/client.js` via `pnpm build`.

The host half composes the two standalone packages instead of carrying a second copy of the
implementation: the tool comes from [`@moguiyu/dsh-tool-tavily-search`](../dsh-tool-tavily-search)
and the routes/switch pipeline from [`@moguiyu/dsh-tavily-backend`](../dsh-tavily-backend).
Both are regular dependencies, installed automatically with this package.

See the [workspace README](../../README.md) for install and configuration.
