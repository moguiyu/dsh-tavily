# dsh-tavily

Tavily web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) with **multiple API keys**, **automatic rotation/failover**, **live usage gauge**, and a full settings card.

## Highlights

- 🔑 **Multiple Tavily API keys** — manage a flat key list from the DSH settings UI.
- 🔁 **Key rotation & failover** — round-robin across keys; automatically retries on HTTP 401/429.
- 📊 **Usage gauge** — per-key Tavily usage and totals, fetched server-side without exposing keys.
- 🎛️ **Settings card** — add/remove/reveal keys, choose usage strategy, toggle `web_search` provider.
- 🧩 **One installable DSH plugin** — model tool, settings card, and local backend in a single package.

## Package

| Package | Role |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | Single plugin: `tavily_search` tool + settings card + local backend |

## Install

Easiest — one command, one plugin:

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

Or from npm:

```sh
dsh plugin --profile web add @moguiyu/dsh-tavily
```

For full `web_search` provider switching, add the provider row and config to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
  - id: web-search-tavily
    name: '@crayonlu/dsh-web-search-tavily'
  - id: dsh-tavily
    name: '@moguiyu/dsh-tavily'
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
