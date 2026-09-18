# dsh-tavily

English | [简体中文](README.zh-CN.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/moguiyu/dsh-tavily--packages-dsh-tavily/) [![推荐 dshfind](https://img.shields.io/badge/%E6%8E%A8%E8%8D%90-dshfind-ffd700?labelColor=555555)](https://dshfind.com/zh/plugins/moguiyu/dsh-tavily?ref=badge)

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — **multiple API keys**, **rotation and failover**, a **live usage gauge**, the direct **`extract` / `map` / `crawl`** tools, and a key-management card on the **Plugins** page.

The built-in `web_search` tool is **never replaced**: Tavily is an *addition* to the native search, not a swap-in for it. This plugin registers no web-search provider and never rewrites `web.searchProvider`.

<p align="center">
  <img src="assets/tavily-search.png" alt="The Tavily card on the Plugins page: masked key list with the green primary dot, per-key usage circles, and the key-usage strategy selector" width="760" />
</p>

## Highlights

- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH UI.
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

After refreshing the browser, open the **Plugins** page in the sidebar and select **dsh-tavily**: the card renders on the bundle's own page, between its description and its rows.

> **Requirements** — DSH is a development preview (`0.1.x-rc/alpha`). The tools and the key/usage routes work on every supported line, `0.1.0-rc.7` onward. The **card needs `0.1.6-alpha.2` or newer**, where DSH moved plugin configuration from Settings to the Plugins page; on older lines the plugin is fully functional and simply has no card. The npm name is the scoped `@moguiyu/dsh-tavily`, not the similarly-named community `dsh-tavily` provider-swap plugin.

> **Compatibility** — `0.3.0` is a single self-contained package: the tools, the routes and the card all live in `@moguiyu/dsh-tavily`, which uses only the long-stable `ctx.tools` / `ctx.webServer` / `ctx.credentials` / `ctx.systemPrompt` seams. There is no version-specific code path left to feature-detect. Peer ranges list one comparator per host tuple (`^0.1.0-rc.7`, `^0.1.1-rc.1`, `^0.1.2-alpha.2`, `^0.1.3-alpha.1`, `^0.1.5-0`, `^0.1.6-0`), because prerelease comparators never cascade — a new host line means a new comparator, not a widened old one.

## Packages

**One package.** Earlier releases also shipped `@moguiyu/dsh-tavily-backend` and `@moguiyu/dsh-tool-tavily-search`. From `0.3.0` both are folded into `@moguiyu/dsh-tavily`, which is now self-contained; the two old packages are deprecated and no longer updated.

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Everything: `tavily_search` + `tavily_extract` / `tavily_map` / `tavily_crawl`, the key/usage routes, and the Plugins-page card |

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list; the tools rotate through it, retrying on HTTP 401/429.
- `TAVILY_API_KEY` — primary key auto-synced to the first key.

Both are managed automatically by the card. Keys never leave the server unmasked, and no state file holds key material.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## Tavily tools

`tavily_search` plus the direct tools, all independent of `web_search`:

- `tavily_search` — full search surface (`search_depth`, `topic`, `days`, domain filters, `include_answer`, `include_raw_content`);
- `tavily_extract` — pull the complete content of known HTTP(S) URLs;
- `tavily_map` — discover a site's links without fetching page content;
- `tavily_crawl` — crawl a site and return the extracted content of its pages.

Composing the plugin registers them; there is no separate tool-level switch. To turn them off, disable the plugin with the toggle on its Plugins page — the built-in `web_search` keeps its native provider either way, and its schema is never touched.

## State files

- `~/.dsh/tavily-manager.json` — saved key dates + strategy

Mode `600`, no secrets stored.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

MIT
