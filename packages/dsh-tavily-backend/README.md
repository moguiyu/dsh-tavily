# @moguiyu/dsh-tavily-backend

Local HTTP backend for the Tavily Search settings card. One composition row registers
three routes on the harness `webServer`:

| Route | Purpose |
|---|---|
| `GET /api/tavily-usage` | Per-key Tavily `/usage` data + totals (no secrets) |
| `GET/POST /api/tavily-manager` | Flat key list (masked values, saved dates), strategy-ordered writes, `?reveal=<masked>` |
| `GET/POST /api/tavily-tool` | Persisted opt-in switch for the advanced `tavily_search` tool; POST hot-restarts the tool row |

`/api/tavily-toggle` remains as a compatibility alias for `/api/tavily-tool`.

State lives in `~/.dsh/tavily-manager.json` and `~/.dsh/tavily-tool.json` (mode 600, no
secrets). The backend registers **no** web search provider and never writes
`web.searchProvider` — the built-in `web_search` tool is never replaced; Tavily stays an
opt-in extra search option.

Pure helpers (`maskValue`, `parseKeyList`, `orderKeys`, …) are exported from
`src/lib.js` and unit-tested with `node --test`.

See the [workspace README](../../README.md) for install and configuration.
