# dsh-tavily

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) with **multiple API keys**, **automatic rotation/failover**, **live usage gauge**, and a full settings card.

## Highlights

- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- 🎛️ **Settings card** — add/remove/reveal keys, choose usage strategy, toggle `web_search` provider.
- 🧩 **Two installable DSH packages** — model tool + local HTTP backend.

## Packages

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | `tavily_search` model tool + Tavily Search settings card |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | Local routes for usage, key management, and provider toggle |

## Install

```sh
dsh plugin --profile web add @moguiyu/dsh-tool-tavily-search
dsh plugin --profile web add @moguiyu/dsh-tavily-backend
```

Or directly from GitHub:

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

Then add the rows to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
  - id: web-search-tavily
    name: '@crayonlu/dsh-web-search-tavily'
  - id: tool-tavily-search
    name: '@moguiyu/dsh-tool-tavily-search'
  - id: tavily-backend
    name: '@moguiyu/dsh-tavily-backend'
- id: web
  config:
    searchProvider: tavily
```

After refreshing the browser, the card appears under **Settings → Plugins → plugin configuration** (`tavily-search`).

## Credentials

- `TAVILY_API_KEYS` — comma-separated key list used by `tavily_search`
- `TAVILY_API_KEY` — primary key auto-synced to the first key, used by `web_search`

Both are managed automatically by the settings card.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — re-order keys by live Tavily usage on save.

## On/off switch

Toggle the built-in `web_search` provider between `tavily` and the native `deepseek-official` provider. The choice persists in `~/.dsh/tavily-toggle.json`.

## State files

- `~/.dsh/tavily-manager.json` — saved key dates + strategy
- `~/.dsh/tavily-toggle.json` — `{ "enabled": boolean }`

Mode `600`, no secrets stored.

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
