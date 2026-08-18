# dsh-tavily

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) with **multiple API keys**, **automatic rotation/failover**, **live usage gauge**, and a full settings card.

## Highlights

- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- 🎛️ **Settings card** — add/remove/reveal keys, choose usage strategy, and inspect usage.
- 🧩 **Native web provider** — supplies DSH's built-in `web_search` tool through Tavily.
- 🛠️ **Tavily retrieval tools** — adds `tavily_extract`, `tavily_map`, and `tavily_crawl`.

## Package

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Tavily `web_search` provider, three direct retrieval tools, settings card, and local backend |

## Install

Easiest — one command, one plugin:

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

Or from npm:

```sh
dsh plugin --profile web add @moguiyu/dsh-tavily
```

The plugin's bundle config selects Tavily for DSH's native `web_search` provider. A profile that overrides the web provider must retain:

```yaml
- insert:
  - id: dsh-tavily
    name: '@moguiyu/dsh-tavily'
- id: web
  config:
    searchProvider: tavily
```

After refreshing the browser, the card appears under **Settings → Plugins → plugin configuration** (`tavily-search`).

## Migration from 0.1.x

Version 0.2.0 replaces the direct `tavily_search` model tool with DSH's native `web_search` provider and adds `tavily_extract`, `tavily_map`, and `tavily_crawl`.

Remove `@moguiyu/dsh-tool-tavily-search` and `@moguiyu/dsh-tavily-backend` from the DSH profile before installing `@moguiyu/dsh-tavily`. Do not install the legacy packages alongside this package: they register the same settings card and backend routes. Existing `TAVILY_API_KEYS` credentials and `tavily-manager.json` state are reused.

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list used by `web_search`, `tavily_extract`, `tavily_map`, and `tavily_crawl`
- `TAVILY_API_KEY` — legacy primary-key fallback, automatically synced to the first managed key

Both are managed automatically by the settings card.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## Model tools

With the plugin enabled, the model receives exactly these Tavily-related tools:

- `web_search` — DSH's native web-search tool, backed by the Tavily provider.
- `tavily_extract` — retrieve complete content from known URLs.
- `tavily_map` — discover URLs across a site.
- `tavily_crawl` — discover and extract content across a site.

## State files

- `~/.dsh/tavily-manager.json` — saved key dates + strategy

Mode `600`, no secrets stored.

## Screenshot

![Tavily Search for DSH](assets/tavily-search.png)

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

MIT

---

[简体中文](README.zh-CN.md)
