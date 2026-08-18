# @moguiyu/dsh-tool-tavily-search

Registers the opt-in advanced `tavily_search` model tool for the DeepSeek Harness.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`). Keys are
  resolved from the `TAVILY_API_KEYS` credential on every call; round-robin rotation with
  failover on HTTP 401/429.
- **Opt-in, default off** — the plugin `Config.enabled` defaults to `false`; the switch state
  persisted by the settings card (`~/.dsh/tavily-tool.json`) only affects this tool.
- **Headless** — this package ships no settings card. Install
  [`@moguiyu/dsh-tavily`](../dsh-tavily) (tool + card + backend in one row) for the **Tavily
  Search** card under Settings → Plugins → plugin configuration.
- Built-in `web_search` is **never** replaced: this package registers no provider and never
  writes `web.searchProvider`. Tavily is an extra, opt-in search option alongside the native
  tool.

Host half: plain ESM (`src/index.js`).

See the [workspace README](../../README.md) for install and configuration.
