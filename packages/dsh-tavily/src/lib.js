/**
 * Pure helpers for the Tavily backend (exported for tests).
 */
import { readFileSync } from 'node:fs'

export const STRATEGIES = ['rotate', 'low-usage-first', 'high-usage-first', 'load-balance']

export function isValidStrategy(value) {
  return STRATEGIES.includes(value)
}

/**
 * Concurrent requests allowed per Tavily account in `load-balance` mode. One is
 * the safe default: Tavily's published limits are per environment/key
 * (100 requests/minute on a free Development key) and every key of one account
 * shares that budget and its credit pool.
 */
export const DEFAULT_ACCOUNT_CAP = 1
export const MAX_ACCOUNT_CAP = 8

export function clampAccountCap(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_ACCOUNT_CAP
  return Math.min(MAX_ACCOUNT_CAP, Math.max(DEFAULT_ACCOUNT_CAP, Math.round(n)))
}

/** The `/usage` `account` fields that identify an account; order is canonical. */
const ACCOUNT_FIELDS = [
  'current_plan', 'plan', 'plan_limit', 'plan_usage', 'paygo_limit', 'paygo_usage',
  'search_usage', 'extract_usage', 'map_usage', 'crawl_usage', 'research_usage',
]

/**
 * Fingerprint a Tavily `/usage` `account` block. Tavily publishes no account id,
 * but every key of one account reports the identical account block at the same
 * moment (observed live: two keys both at search_usage 846 / extract 129 / map
 * 23), so an equal fingerprint is the only account-level signal available.
 * Returns `null` when the block carries no recognizable field, which means
 * "makes no claim about the account" rather than "its own account".
 */
export function accountFingerprint(account) {
  if (account === null || account === undefined || typeof account !== 'object' || Array.isArray(account)) return null
  const parts = []
  for (const field of ACCOUNT_FIELDS) {
    const value = account[field]
    if (value === undefined || value === null) continue
    parts.push(field + '=' + String(value))
  }
  return parts.length === 0 ? null : parts.join('|')
}

/**
 * Assign stable account group ids to the stored keys.
 *
 * `entries` is `[{ masked, fingerprint }]` in credential-list order; `previous`
 * is the persisted `accounts` map. A `manual: true` entry is kept verbatim —
 * that is the user's override — and offers its group id to keys that turn out
 * to share its account. Inferred ids survive a re-run: a cluster carries over
 * the id its own members already had instead of being renumbered, so usage
 * drifting between fetches cannot reshuffle the groups.
 */
export function groupAccounts(entries, previous) {
  const prior = previous !== null && previous !== undefined && typeof previous === 'object' && !Array.isArray(previous)
    ? previous
    : {}
  const assigned = {}
  const used = new Set()
  const manualGroupByFingerprint = new Map()

  for (const entry of entries) {
    const before = prior[entry.masked]
    if (before === null || before === undefined || typeof before !== 'object') continue
    if (before.manual !== true) continue
    if (typeof before.group !== 'string' || before.group.length === 0) continue
    assigned[entry.masked] = { group: before.group, manual: true }
    used.add(before.group)
    if (typeof entry.fingerprint === 'string' && entry.fingerprint.length > 0 && !manualGroupByFingerprint.has(entry.fingerprint)) {
      manualGroupByFingerprint.set(entry.fingerprint, before.group)
    }
  }

  const clusters = new Map()
  for (const entry of entries) {
    if (assigned[entry.masked] !== undefined) continue
    const fingerprint = typeof entry.fingerprint === 'string' && entry.fingerprint.length > 0 ? entry.fingerprint : null
    if (fingerprint === null) continue
    const members = clusters.get(fingerprint)
    if (members === undefined) clusters.set(fingerprint, [entry.masked])
    else members.push(entry.masked)
  }

  let next = 1
  for (const [fingerprint, members] of clusters) {
    const carried = new Map()
    for (const masked of members) {
      const before = prior[masked]
      if (before !== null && before !== undefined && typeof before === 'object' &&
        typeof before.group === 'string' && before.group.length > 0) {
        carried.set(before.group, (carried.get(before.group) ?? 0) + 1)
      }
    }
    let group = manualGroupByFingerprint.get(fingerprint)
    if (group === undefined) {
      let best = null
      let bestCount = 0
      for (const [id, count] of carried) {
        if (count > bestCount) {
          best = id
          bestCount = count
        }
      }
      if (best !== null) group = best
    }
    if (group === undefined) {
      while (used.has('acct-' + next)) next += 1
      group = 'acct-' + next
      next += 1
    }
    used.add(group)
    for (const masked of members) assigned[masked] = { group, manual: false }
  }

  const out = {}
  for (const entry of entries) {
    if (assigned[entry.masked] !== undefined) out[entry.masked] = assigned[entry.masked]
  }
  return out
}

/**
 * Mask a key for display: `first12…last4`; comma-separated lists are masked
 * per part. Never reveals more than a fingerprint.
 */
export function maskValue(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value.split(',').map((part) => {
    const p = part.trim()
    if (p.length <= 12) return '••••'
    return p.slice(0, 12) + '…' + p.slice(-4)
  }).join(', ')
}

/** Split a comma-separated credential value into trimmed, deduped keys. */
export function parseKeyList(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  const out = []
  for (const part of value.split(',')) {
    const key = part.trim()
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Order keys according to a strategy. `usageOf(key)` returns a number or null
 * (unknown usage is treated as 0). `rotate` keeps the given order, and so does
 * `load-balance`: that mode is about how many requests may be in flight per
 * account, not about which key comes first.
 */
export function orderKeys(values, strategy, usageOf) {
  if (strategy === 'rotate' || strategy === 'load-balance') return [...values]
  const usageOfKey = (value) => {
    const usage = usageOf(value)
    return usage !== null && typeof usage === 'number' ? usage : 0
  }
  const sorted = [...values]
  sorted.sort((a, b) => strategy === 'low-usage-first'
    ? usageOfKey(a) - usageOfKey(b)
    : usageOfKey(b) - usageOfKey(a))
  return sorted
}

/** Read a JSON object file; `fallback` on missing or unparsable content. */
export function readJsonFile(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}
