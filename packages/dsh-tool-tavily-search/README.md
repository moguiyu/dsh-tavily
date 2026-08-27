# @moguiyu/dsh-tool-tavily-search

Registers the opt-in advanced Tavily model tools for the DeepSeek Harness: search, extract,
map, and crawl.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`). Keys are
  resolved from the `TAVILY_API_KEYS` credential on every call; round-robin rotation with
  failover on HTTP 401/429.
- **`tavily_extract`** — retrieve the complete content of known HTTP(S) URLs
  (`urls`, `extract_depth`, `include_images`, `format`, `include_favicon`, `query`).
- **`tavily_map`** — discover a site's links without fetching page content (`url`,
  `instructions`, `max_depth`, `max_breadth`, `limit`, `select_paths`, `select_domains`,
  `allow_external`).
- **`tavily_crawl`** — crawl a site and return the extracted content of its pages (all `map`
  navigation params plus `extract_depth`, `format`, `include_favicon`, `chunks_per_source`).
- **Opt-in, default off** — the plugin `Config.enabled` defaults to `false`; the switch state
  persisted by the settings card (`~/.dsh/tavily-tool.json`) affects this tool set.
- **Headless** — this package ships no settings card. Install
  [`@moguiyu/dsh-tavily`](../dsh-tavily) (tool + card + backend in one row) for the **Tavily
  Search** card under Settings → Plugins → plugin configuration.
- Built-in `web_search` is **never** replaced: this package registers no provider and never
  writes `web.searchProvider`. Tavily is an extra, opt-in search option alongside the native
  tool.

Host half: plain ESM (`src/index.js`).

See the [workspace README](../../README.md) for install and configuration.
