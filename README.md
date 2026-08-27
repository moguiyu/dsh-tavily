# dsh-tavily

English | [简体中文](README.zh-CN.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/moguiyu/dsh-tavily--packages-dsh-tavily/) [![推荐 dshfind](https://img.shields.io/badge/%E6%8E%A8%E8%8D%90-dshfind-ffd700?labelColor=555555)](https://dshfind.com/zh/plugins/moguiyu/dsh-tavily?ref=badge)

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as an **opt-in extra search tool** — with **multiple API keys**, **rotation/failover**, **live usage gauge**, and a settings card in the Plugins configuration tab.

The built-in `web_search` tool is **never replaced**: Tavily is an *option* on top of the native search, not a swap-in for it. This plugin registers no web-search provider and never rewrites `web.searchProvider`.

<p align="center">
  <img src="assets/tavily-search.png" alt="Tavily Search settings card: masked key list with the green primary dot, per-key usage circles, the key-usage strategy selector, and the advanced-tool switch — as served under Settings → Plugins → plugin configuration" width="560" />
</p>

## Highlights

- 🧩 **Plugin-config settings card** — a native card under **Settings → Plugins → plugin configuration**: add, remove and reveal keys, pick the key-usage strategy, and opt into the advanced `tavily_search` tool.
- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Live usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- 🚫 **`web_search` untouched** — no `ctx.web` provider is registered; the card switch only enables/disables the extra `tavily_search` tool.

## Install

One command installs the workspace bundle, which composes the combined `dsh-tavily` row:

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

After refreshing the browser, the **Tavily Search** card appears under **Settings → Plugins → plugin configuration**. It only appears when the Host half is actually composed — the configuration tab dispatches the card keyed by the namespace the Host serves.

> **Requirements** — DSH is a development preview (`0.1.0-rc.x`); the keyed plugin-config card needs **0.1.0-rc.7 or newer**. The npm name is the scoped `@moguiyu/dsh-tavily`, not the similarly-named community `dsh-tavily` provider-swap plugin.

## Packages

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Recommended plugin: `tavily_search` tool + settings card + local backend + `tavily-search` namespace |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | Standalone settings backend (key manager, usage, tool switch) |
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | Standalone advanced `tavily_search` tool (no UI) |

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list; `tavily_search` rotates through it, retrying on HTTP 401/429.
- `TAVILY_API_KEY` — primary key auto-synced to the first key.

Both are managed automatically by the settings card. Keys never leave the server unmasked, and no state file holds key material.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## Advanced `tavily_search` tool

The advanced model-facing tool is **opt-in and off by default**. It exists for direct Tavily-only parameters (`search_depth`, `topic`, `days`, domain filters, `include_answer`, `include_raw_content`) and is independent of `web_search`:

- enabling it never changes the default `web_search` (the built-in DeepSeek provider stays, along with its native schema);
- disabling it only unregisters the extra `tavily_search` tool.

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
