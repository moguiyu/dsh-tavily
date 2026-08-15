# @yourscope/dsh-tool-tavily-search

Registers the `tavily_search` model tool and the **Tavily Search** settings card for the
DeepSeek Harness web UI.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`). Keys are
  resolved from the `TAVILY_API_KEYS` credential on every call; round-robin rotation with
  failover on HTTP 401/429.
- **Settings card** (`settings.plugin.item`, id `tavily-search`) — expandable card matching
  the native plugin-config design: flat key list (masked values, saved dates, show/edit/delete
  icons), key-usage strategy selector, usage gauge, and the on/off switch for the `web`
  provider.

Host half: plain ESM (`src/index.js`). Client half: prebuilt `window.__ModuleLoader__` bundle
at `lib/client.js`, generated from `src/client.js` via `pnpm build`.

See the [workspace README](../../README.md) for install and configuration.
