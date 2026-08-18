# dsh-tavily

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as an **opt-in extra search tool**, with **multiple API keys**, **rotation/failover**, **live usage gauge**, and a settings card wired into the rc.7 plugin management.

The built-in `web_search` tool is **never replaced**: Tavily is an *option* on top of the native search, not a swap-in for it. This repo registers no web-search provider and never rewrites `web.searchProvider`.

## Highlights

- 🧩 **rc.7 plugin management** — the Host registers the `tavily-search` settings namespace; the card is keyed by it, so **Settings → Plugins → plugin configuration** pairs and serves it as soon as the deployment composes the plugin.
- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- 🎛️ **Settings card** — add/remove/reveal keys, choose usage strategy, and opt into the advanced `tavily_search` model tool.
- 🚫 **`web_search` untouched** — no `ctx.web` provider is registered; the card switch only enables/disables the extra `tavily_search` tool.

## Packages

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Recommended plugin: `tavily_search` tool + settings card + local backend + `tavily-search` namespace |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | Standalone settings backend (key manager, usage, tool switch) |
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | Standalone advanced `tavily_search` tool (no UI) |

## Install

One command installs the workspace bundle, which inserts the combined `dsh-tavily` row:

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

After refreshing the browser, the **Tavily Search** card appears under **Settings → Plugins → plugin configuration** (`tavily-search`). It only appears when the Host half is actually composed — the rc.7 configuration tab dispatches the card keyed by the namespace the Host serves.

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list; `tavily_search` rotates through it, retrying on HTTP 401/429.
- `TAVILY_API_KEY` — primary key auto-synced to the first key.

Both are managed automatically by the settings card. Keys never leave the server unmasked, and no state file holds key material.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## Advanced `tavily_search` tool

The advanced model-facing tool is **opt-in and off by default**. It exists for direct Tavily-only parameters (`search_depth`, `topic`, `days`, domain filters, `include_answer`, `include_raw_content`) and is independent of `web_search`:

- enabling it never changes the default `web_search` (the built-in DeepSeek provider stays,
  along with its native schema);
- disabling it only unregisters the extra `tavily_search` tool.

The switch lives in the `tavily-search` settings namespace (settings.yaml) and is mirrored to `~/.dsh/tavily-tool.json` so every restart reads the same value.

## State files

- `~/.dsh/tavily-manager.json` — saved key dates + strategy
- `~/.dsh/tavily-tool.json` — advanced tool `{ "enabled": boolean }` (mirror of the settings namespace)
- `~/.dsh/tavily-toggle.json` — legacy pre-0.2 tool state; read for migration only

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
