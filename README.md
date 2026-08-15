# dsh-tavily

Publishable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins
for Tavily-backed web search. Everything is a plugin: the search tool, the settings UI, the
key management backend, and the on/off switch for the built-in `web_search` tool.

> Status: developer-preview quality. DSH itself is a developer preview (`0.1.0-rc.x`) and its
> plugin APIs may change. Both packages follow the conventions of the official `@deepseek-ai/*`
> packages (composition rows, `dsh.client` declarations, `./invariant` companions, `node --test`).

## Packages

| Package | Role |
|---|---|
| [`@yourscope/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | `tavily_search` model tool (key rotation, failover on 401/429) + the **Tavily Search** settings card (expandable plugin-config card: key list, usage strategy, usage gauge, on/off switch) |
| [`@yourscope/dsh-tavily-backend`](packages/dsh-tavily-backend) | Local HTTP backend: `/api/tavily-usage`, `/api/tavily-manager` (flat key list + strategies + saved dates), `/api/tavily-toggle` (web_search provider switch, persisted) |

## Install

```sh
# from npm (after publishing)
dsh plugin --profile web add @yourscope/dsh-tool-tavily-search
dsh plugin --profile web add @yourscope/dsh-tavily-backend

# or directly from git (no npm publish needed)
dsh plugin --profile web add github:yourname/dsh-tavily
```

Then add the rows to `$DSH_HOME/profiles/web/cordis.patch.yml` (hot-reloaded):

```yaml
- insert:
  - id: web-search-tavily
    name: '@crayonlu/dsh-web-search-tavily'
  - id: tool-tavily-search
    name: '@yourscope/dsh-tool-tavily-search'
  - id: tavily-backend
    name: '@yourscope/dsh-tavily-backend'
- id: web
  config:
    searchProvider: tavily
```

`web-search-tavily` is the community `WebSearchProvider` (any provider works — it only has to
register under the `tavily` id, which is what the `web` row selects).

After installing, refresh the browser page. The card appears under **Settings → Plugins →
plugin configuration** (id `tavily-search`).

## Credentials

Stored through the harness credential seam (`~/.dsh/.credentials.yaml` or the environment):

- `TAVILY_API_KEYS` — comma-separated key list (used by `tavily_search`; order encodes the strategy)
- `TAVILY_API_KEY` — the primary key, auto-synced to the first key in the list (used by `web_search`)

Both are managed automatically by the settings card — never edit them by hand.

## Key usage strategy

- **Rotate each key** — round-robin; on 401/429 the next key is tried.
- **Lowest usage first / Highest usage first** — on save, the backend queries live Tavily
  usage and re-orders the list; the first key becomes the primary (`web_search` key).

## On/off switch

The switch in the card header toggles the `web` provider between `tavily` and the native
`deepseek-official` provider — when off, `web_search` runs natively and **no Tavily key is
needed**. The choice persists in `~/.dsh/tavily-toggle.json` and is re-applied at boot.

> Note: the switch flips the live `web` row fiber through the loader's internal update API.
> This works on current DSH (`0.1.0-rc.x`) but is not a documented seam; a DSH update may
> change it. The persisted state + boot re-apply keeps the choice durable regardless.

## State files (mode 600, no secrets)

- `~/.dsh/tavily-manager.json` — per-key saved dates (`keySavedAt`, keyed by masked form) + strategy
- `~/.dsh/tavily-toggle.json` — `{ "enabled": boolean }`

## Development

```sh
pnpm install
pnpm test          # node --test across packages
pnpm build         # regenerates packages/dsh-tool-tavily-search/lib/client.js from src/client.js
```

The client bundle (`lib/client.js`) is a committed artifact in the `window.__ModuleLoader__.load`
format the dsh web shell requires; regenerate it with `pnpm build` after editing
`src/client.js`.

## Publishing

1. Replace the `@yourscope` scope with your npm scope (or tell the maintainer).
2. Fill `repository.url` in each `package.json`.
3. `pnpm publish -r` (or `npm publish --workspaces`).
4. Add the `dsh-plugin` GitHub topic and submit to the curated lists
   ([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
   [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)).

## License

MIT
