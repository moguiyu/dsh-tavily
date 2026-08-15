# AGENTS.md — dsh-tavily

Publishable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins
for Tavily-backed web search. The harness is a developer preview (`0.1.0-rc.x`); its plugin
APIs can change without notice. Global agent instructions still apply.

## 1. Mission

Ship the two packages in `packages/` as standards-compliant, publishable dsh plugins and keep
them working against the running harness:

- **`@moguiyu/dsh-tool-tavily-search`** — the `tavily_search` model tool (key rotation,
  failover on 401/429) plus the **Tavily Search** settings card for the web UI.
- **`@moguiyu/dsh-tavily-backend`** — one row registering three local HTTP routes
  (`/api/tavily-usage`, `/api/tavily-manager`, `/api/tavily-toggle`) plus the persisted
  on/off switch for the `web` provider.

The system assists a human operator of a DSH instance. It never exposes secrets: keys are
masked server-side, only a per-click `reveal` returns a full value, and state files hold no
key material.

## 2. Current state

- Scaffolded and committed; `node --test` green (5 tool + 7 backend tests); the client bundle
  `lib/client.js` builds from `src/client.js` and is syntax-checked.
- **Not done:** decide publish path (npm vs GitHub-only), publish, add the
  `dsh-plugin` GitHub topic / curated lists, optionally migrate the live deployment.

## 3. Domain model

- **Credentials** (harness seam, `~/.dsh/.credentials.yaml` or env):
  - `TAVILY_API_KEYS` — comma-separated list; order encodes the strategy; used by `tavily_search`.
  - `TAVILY_API_KEY` — the primary key, **auto-synced to the first key in the list**; used by
    the `web_search` seam provider. Never edit by hand; the backend owns both refs.
- **Strategies** (`src/lib.js`): `rotate` (round-robin + next-key on 401/429),
  `low-usage-first` / `high-usage-first` (on save the backend queries live Tavily `/usage`
  and re-orders; unknown usage counts as 0). The first key becomes primary.
- **State files** (mode 600, dates only): `~/.dsh/tavily-manager.json`
  (`keySavedAt` keyed by masked form + `strategy`), `~/.dsh/tavily-toggle.json`
  (`{ "enabled": boolean }`).
- **Settings card**: `settings.plugin.item`, id `tavily-search`, label "Tavily Search";
  expandable box matching native plugin-config cards; icon-only row actions; green dot =
  primary key.

## 4. DSH runtime facts and gotchas (verified the hard way — read before touching runtime behavior)

- **Composition**: profiles compose rows from bundles + `$DSH_HOME/profiles/<name>/cordis.patch.yml`
  (hot-reloaded). New rows activate live; a failing row activation **rolls back the whole
  include update**.
- **Service-row config changes do NOT hot-apply**: changing a Service row's config (e.g.
  `web.searchProvider`) updates the row options but does **not** restart the live fiber —
  the running service keeps its constructor-captured config. The toggle works around this via
  `loader.resolve('include:web').fiber.update({ searchProvider }, true)` — an **internal,
  undocumented API** coupled to the row id; keep it guarded and document it as fragile.
- **Client module registry** (`clientModules`) caches each package's "has `dsh.client`?"
  scan result (`pkgMeta`) for the process lifetime: a package that activated without a client
  declaration is invisible to the web shell until a **process restart**. Bundle *content*
  changes, however, are served fresh on page refresh (`cache-control: no-cache`; the `?rev=`
  query is only a cache-buster).
- **`exports` must include `"./package.json"`**: the registry resolves
  `require.resolve('<pkg>/package.json')`, which fails loudly otherwise. The same goes for the
  main loader's ESM import of new packages.
- **Client bundles** are committed artifacts in the `window.__ModuleLoader__.load({ id,
  factory })` format; `factory(require)` must be **fully self-contained** (no module-scope
  references) because `scripts/build-client.mjs` serializes it with `Function.prototype.toString`.
  The bundle returns `{ apply, inject }`.
- **`dsh plugin` forwards to pnpm**; packages without a `dsh.bundle` export print a warning and
  need manual patch rows. Git-hosted installs with a `prepare` script need an `allowBuilds`
  entry in the profile's `pnpm-workspace.yaml`.
- Missing client bundle at scan time fails `clientModules` composition loudly.

## 5. Standards checklist (what "publish-ready" means here)

Official `@deepseek-ai/*` packages and the published `@crayonlu/dsh-web-search-tavily` set the
bar: scoped name, `"type": "module"`, `exports` with `./invariant` (+ `./client` for dual-face),
`files` whitelist, `LICENSE` file, README with install + patch rows, `node --test` suite,
`./invariant` companion registering with `ctx.invariants`, `dsh.client` declaration with a
minimal `inject` list, `ctx.logger` (not console), peer ranges like `^0.1.0-rc.6`.

## 6. Development workflow

```sh
pnpm install
pnpm test          # node --test per package
pnpm build         # regenerates packages/dsh-tool-tavily-search/lib/client.js from src/client.js
```

- Keep `src/client.js` self-contained; run `pnpm build` and `node --check lib/client.js` after
  client edits; commit the regenerated artifact.
- Keep pure logic in exported functions (tool: `normalizeArgs`, `clampInt`; backend: `src/lib.js`)
  so tests run without a live harness.
- When a DSH instance is running locally, verify live: `curl http://127.0.0.1:3080/api/tavily-usage`,
  `/api/tavily-manager`, `/api/tavily-toggle`; `web_search` probe distinguishes providers by
  answer/snippets (Tavily) vs title-only sources (native DeepSeek).

## 7. Deployment context (optional migration)

The live GUI deployment (`~/.dsh/profiles/web`) currently runs earlier bare-name copies
(`dsh-tool-tavily-search`, `dsh-tavily-usage`, `dsh-tavily-manager`, `dsh-tavily-toggle` plus
the `@crayonlu/dsh-web-search-tavily` provider) installed directly under
`~/.dsh/profiles/node_modules/`. This repo is the canonical replacement. Migration = install
the scoped packages via `dsh plugin add`, swap the patch rows to the scoped names, remove the
old dirs. The three host packages map to the single `dsh-tavily-backend` row.

## 8. Verification gates before publishing

1. All tests pass and the bundle builds from clean state.
2. No secrets, keys, or session material in the repo (grep for `tvly-`, `sk-`).
3. Placeholders resolved (`@moguiyu`, `https://github.com/moguiyu/dsh-tavily.git`, MIT copyright).
4. README install instructions work from a clean profile.
5. Live-verified: all three routes, toggle off/on fallback, strategy reorder, reveal.
