/**
 * Pure helpers for the Tavily backend (exported for tests).
 */

export const STRATEGIES = ['rotate', 'low-usage-first', 'high-usage-first']

export function isValidStrategy(value) {
  return STRATEGIES.includes(value)
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
 * (unknown usage is treated as 0). `rotate` keeps the given order.
 */
export function orderKeys(values, strategy, usageOf) {
  if (strategy === 'rotate') return [...values]
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
    const { readFileSync } = awaitImportFs()
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function awaitImportFs() {
  return import('node:fs')
}
