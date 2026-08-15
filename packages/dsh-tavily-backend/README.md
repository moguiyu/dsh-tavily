# @yourscope/dsh-tavily-backend

Local HTTP backend for the Tavily Search settings card. One composition row registers
three routes on the harness `webServer`:

| Route | Purpose |
|---|---|
| `GET /api/tavily-usage` | Per-key Tavily `/usage` data + totals (no secrets) |
| `GET/POST /api/tavily-manager` | Flat key list (masked values, saved dates), strategy-ordered writes, `?reveal=<masked>` |
| `GET/POST /api/tavily-toggle` | Persisted on/off for the `web` provider; POST flips the live provider |

State lives in `~/.dsh/tavily-manager.json` and `~/.dsh/tavily-toggle.json` (mode 600, no
secrets). Pure helpers (`maskValue`, `parseKeyList`, `orderKeys`, …) are exported from
`src/lib.js` and unit-tested with `node --test`.

See the [workspace README](../../README.md) for install and configuration.
