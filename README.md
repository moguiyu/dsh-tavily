# dsh-tavily

English | [简体中文](README.zh-CN.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/moguiyu/dsh-tavily--packages-dsh-tavily/) [![推荐 dshfind](https://img.shields.io/badge/%E6%8E%A8%E8%8D%90-dshfind-ffd700?labelColor=555555)](https://dshfind.com/zh/plugins/moguiyu/dsh-tavily?ref=badge)

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as an **opt-in extra search tool** — with **multiple API keys**, **rotation/failover**, **live usage gauge**, **direct `extract` / `map` / `crawl` tools**, and a settings card in the Plugins configuration tab.

The built-in `web_search` tool is **never replaced**: Tavily is an *option* on top of the native search, not a swap-in for it. This plugin registers no web-search provider and never rewrites `web.searchProvider`.

<p align="center">
  <img src="assets/tavily-search.png" alt="Tavily Search settings card: masked key list with the green primary dot, per-key usage circles, the key-usage strategy selector, and the advanced-tool switch — as served under Settings → Plugins → plugin configuration" width="560" />
</p>

## Highlights

- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Live usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- ⚡ **Direct Tavily tools** — `tavily_extract` reads a known URL's content, `tavily_map` discovers a site's links, and `tavily_crawl` pulls an entire site, all under the same key rotation.

## Install

Either of these installs the `dsh-tavily` row (both resolve to the same plugin, but install with `--profile <name>`):

```sh
# from the repository — always the latest source
dsh plugin --profile web add github:moguiyu/dsh-tavily

# from the npm release — the stable, marketplace-counted version
dsh plugin --profile web add @moguiyu/dsh-tavily
```

After refreshing the browser, the **Tavily Search** card appears under **Settings → Plugins → plugin configuration**. It only appears when the Host half is actually composed — the configuration tab dispatches the card keyed by the namespace the Host serves.

> **Requirements** — DSH is a development preview (`0.1.x-rc/alpha`); the keyed plugin-config card needs **0.1.2-alpha.2 or newer**. The npm name is the scoped `@moguiyu/dsh-tavily`, not the similarly-named community `dsh-tavily` provider-swap plugin.

## Packages

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Recommended plugin: `tavily_search` + `tavily_extract` / `tavily_map` / `tavily_crawl` tools + settings card + local backend + `tavily-search` namespace |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | Standalone settings backend (key manager, usage, tool switch) |
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | Standalone advanced Tavily tools — `tavily_search`, `tavily_extract`, `tavily_map`, `tavily_crawl` (no UI) |

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list; `tavily_search` rotates through it, retrying on HTTP 401/429.
- `TAVILY_API_KEY` — primary key auto-synced to the first key.

Both are managed automatically by the settings card. Keys never leave the server unmasked, and no state file holds key material.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## Advanced Tavily tools

The advanced model-facing tools are **opt-in and off by default**. They exist for direct Tavily operations and are independent of `web_search`:

- `tavily_search` — full search surface (`search_depth`, `topic`, `days`, domain filters, `include_answer`, `include_raw_content`);
- `tavily_extract` — pull the complete content of known HTTP(S) URLs;
- `tavily_map` — discover a site's links without fetching page content;
- `tavily_crawl` — crawl a site and return the extracted content of its pages.

- enabling them never changes the default `web_search` (the built-in DeepSeek provider stays, along with its native schema);
- disabling them only unregisters the extra Tavily tools.

The switch lives in the `tavily-search` settings namespace (settings.yaml) and is mirrored to `~/.dsh/tavily-tool.json` so every restart reads the same value.

## State files

- `~/.dsh/tavily-manager.json` — saved key dates + strategy
- `~/.dsh/tavily-tool.json` — advanced tool `{ "enabled": boolean }` (mirror of the settings namespace)
- `~/.dsh/tavily-toggle.json` — legacy pre-0.2 tool state; read for migration only

Mode `600`, no secrets stored.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

MIT
