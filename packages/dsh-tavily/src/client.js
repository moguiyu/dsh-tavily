/**
 * Client half source for `@moguiyu/dsh-tavily`.
 * `factory` must stay self-contained: scripts/build-client.mjs serializes it
 * with Function.prototype.toString into the window.__ModuleLoader__ bundle.
 */
export const id = '@moguiyu/dsh-tavily'

export function factory(require) {
  const react = require('react')

  const inject = ['slots']

  const STRATEGIES = [
    { id: 'rotate', label: 'Round-robin', hint: 'Use keys in turn; on HTTP 401/429 the next key is tried automatically.' },
    { id: 'low-usage-first', label: 'Lowest usage first', hint: 'Re-orders keys by current Tavily usage, least-used first. The first key becomes primary.' },
    { id: 'high-usage-first', label: 'Highest usage first', hint: 'Re-orders keys by current Tavily usage, most-used first. The first key becomes primary.' }
  ]

  const ICONS = {
    eye: ['M1.5 8C1.5 8 4 3.5 8 3.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z', 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z'],
    eyeOff: ['M1.5 8C1.5 8 4 3.5 8 3.5c1.6 0 3 .5 4.1 1.2', 'M14.5 8C14.5 8 12 12.5 8 12.5c-1.6 0-3-.5-4.1-1.2', 'M2 2l12 12', 'M8 5.8a2.2 2.2 0 0 1 2.2 2.2'],
    pencil: ['M11.2 2.3l2.5 2.5L6 12.5l-3.3.8.8-3.3 7.7-7.7Z', 'M9.5 4l2.5 2.5'],
    trash: ['M2.5 4h11', 'M6.2 4V2.8h3.6V4', 'M4.2 4l.7 9.2h6.2L11.8 4', 'M6.5 6.5v4.2', 'M9.5 6.5v4.2'],
    check: ['M3 8.5l3.5 3.5L13 5'],
    close: ['M4 4l8 8', 'M12 4l-8 8'],
    restore: ['M8 3a5 5 0 1 0 4.9 4', 'M13.4 1.8V5H10']
  }

  const btn = { height: 28, borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', cursor: 'pointer', fontSize: 12 }
  const inputStyle = { boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', width: '100%', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'var(--ds-font-family-code, monospace)' }

  function formatDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    const pad = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function formatClock(iso) {
    if (!iso) return null
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    const pad = (n) => String(n).padStart(2, '0')
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  // `/api/tavily-usage` asks Tavily for every key's counters, so it can take a
  // while. Two rules follow: the cell must never look *empty* while that is in
  // flight, and the last values already shown must survive a page reload. Only
  // masked names and counters are stored — never key material.
  const USAGE_SNAPSHOT_KEY = 'dsh-tavily:usage-snapshot:v1'
  const RING_GROWTH_MS = 650

  function usageStorage() {
    try {
      if (typeof window === 'undefined' || window === null || !window.localStorage) return null
      return window.localStorage
    } catch (error) {
      return null
    }
  }

  function readUsageSnapshot() {
    const storage = usageStorage()
    if (storage === null) return null
    try {
      const parsed = JSON.parse(storage.getItem(USAGE_SNAPSHOT_KEY))
      if (parsed === null || typeof parsed !== 'object') return null
      if (parsed.version !== 1) return null
      if (parsed.rows === null || typeof parsed.rows !== 'object') return null
      return parsed
    } catch (error) {
      return null
    }
  }

  function writeUsageSnapshot(data) {
    const storage = usageStorage()
    if (storage === null) return
    try {
      const perKey = data !== null && data !== undefined && Array.isArray(data.perKey) ? data.perKey : []
      const rows = {}
      for (const row of perKey) {
        if (row === null || typeof row !== 'object' || typeof row.masked !== 'string') continue
        rows[row.masked] = {
          ok: row.ok === true,
          usage: typeof row.usage === 'number' ? row.usage : null,
          planUsage: typeof row.planUsage === 'number' ? row.planUsage : null,
          planLimit: typeof row.planLimit === 'number' ? row.planLimit : null
        }
      }
      if (Object.keys(rows).length === 0) return
      storage.setItem(USAGE_SNAPSHOT_KEY, JSON.stringify({ version: 1, at: new Date().toISOString(), rows: rows }))
    } catch (error) {
      /* storage is best-effort; the card still works without it */
    }
  }

  function usagePercent(row) {
    if (row === null || row === undefined || row.ok !== true) return null
    if (row.planLimit === null || row.planLimit === undefined || row.planLimit <= 0) return null
    if (row.planUsage === null || row.planUsage === undefined) return null
    return Math.min(100, Math.round((row.planUsage / row.planLimit) * 100))
  }

  /**
   * Count a number up to `target` instead of swapping it. Returns the value to
   * paint now. A first-ever value (or a non-number) is set instantly: there is
   * nothing to grow from.
   */
  function useAnimatedNumber(target, durationMs) {
    const [display, setDisplay] = react.useState(target)
    const displayRef = react.useRef(target)
    const frameRef = react.useRef(0)
    react.useEffect(() => {
      const from = typeof displayRef.current === 'number' ? displayRef.current : null
      const settle = (value) => { displayRef.current = value; setDisplay(value) }
      if (typeof target !== 'number' || from === null || from === target) {
        settle(typeof target === 'number' ? target : null)
        return undefined
      }
      if (typeof requestAnimationFrame !== 'function') {
        settle(target)
        return undefined
      }
      let started = null
      const tick = (now) => {
        const stamp = typeof now === 'number' ? now : Date.now()
        if (started === null) started = stamp
        const elapsed = durationMs > 0 ? (stamp - started) / durationMs : 1
        const t = Math.min(1, Math.max(0, elapsed))
        const eased = 1 - Math.pow(1 - t, 3)
        const next = t >= 1 ? target : Math.round(from + (target - from) * eased)
        displayRef.current = next
        setDisplay(next)
        if (t < 1) frameRef.current = requestAnimationFrame(tick)
      }
      frameRef.current = requestAnimationFrame(tick)
      return () => {
        if (typeof cancelAnimationFrame === 'function' && frameRef.current) cancelAnimationFrame(frameRef.current)
      }
    }, [target, durationMs])
    return display
  }

  function SvgIcon({ name, size, style }) {
    const paths = ICONS[name] || []
    return react.createElement('svg', { width: size || 14, height: size || 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: style },
      paths.map((d, index) => react.createElement('path', { key: index, d: d }))
    )
  }

  function IconButton({ icon, title, onClick, disabled, danger, className }) {
    return react.createElement('button', {
      type: 'button',
      title: title,
      'aria-label': title,
      disabled: disabled,
      onClick: onClick,
      className: className || 'dts-icon-btn',
      style: { width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }
    }, react.createElement(SvgIcon, { name: icon, size: 13 }))
  }

  function UsageCircle({ percent, number, loading, stale, staleAt, onClick }) {
    const radius = 15
    const circumference = 2 * Math.PI * radius
    const pct = percent != null ? Math.min(100, Math.max(0, percent)) : 0
    const dim = 44
    const animated = useAnimatedNumber(percent != null ? percent : (number != null ? number : null), RING_GROWTH_MS)
    const shown = animated != null ? animated : (number != null ? number : null)
    const offset = circumference - (pct / 100) * circumference
    const label = percent != null
      ? (shown != null ? shown + '%' : '—')
      : (shown != null ? String(shown) : '—')
    const clock = formatClock(staleAt)
    const title = loading
      ? (stale && clock !== null ? 'Updating usage… showing the values loaded at ' + clock : 'Updating usage…')
      : (stale && clock !== null ? 'Showing the values loaded at ' + clock + ' — click to refresh' : 'Reload usage')
    return react.createElement('button', {
      type: 'button',
      title: title,
      'aria-label': 'Reload usage',
      'aria-busy': loading ? 'true' : 'false',
      'data-loading': loading ? 'true' : 'false',
      'data-stale': stale ? 'true' : 'false',
      onClick: onClick,
      style: { position: 'relative', width: dim, height: dim, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
    },
      react.createElement('svg', { width: dim, height: dim, viewBox: '0 0 40 40', className: loading ? 'dts-ring dts-ring-loading' : 'dts-ring' },
        react.createElement('circle', { cx: 20, cy: 20, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 4 }),
        react.createElement('circle', {
          className: 'dts-ring-progress',
          cx: 20, cy: 20, r: radius, fill: 'none',
          stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 4, strokeLinecap: 'round',
          strokeDasharray: circumference,
          strokeDashoffset: offset,
          transform: 'rotate(-90 20 20)',
          // The offset is carried as a style value as well as an attribute:
          // presentation attributes alone do not reliably transition.
          style: { strokeDashoffset: offset, transition: 'stroke-dashoffset ' + RING_GROWTH_MS + 'ms cubic-bezier(.22,.61,.36,1)' }
        }),
        loading && react.createElement('g', { className: 'dts-ring-sweep', style: { transformOrigin: '20px 20px' } },
          react.createElement('circle', {
            cx: 20, cy: 20, r: radius, fill: 'none',
            stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 4, strokeLinecap: 'round',
            strokeDasharray: (circumference * 0.22) + ' ' + (circumference * 0.78),
            opacity: 0.45
          })
        )
      ),
      react.createElement('span', { className: 'dts-ring-label', style: { position: 'absolute', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label)
    )
  }

  function TavilySettingsCard() {
    const [server, setServer] = react.useState(null)
    const [loadError, setLoadError] = react.useState(null)
    const [strategy, setStrategy] = react.useState('rotate')
    const [removing, setRemoving] = react.useState({})
    const [replacing, setReplacing] = react.useState({})
    const [replaceDrafts, setReplaceDrafts] = react.useState({})
    const [adds, setAdds] = react.useState([])
    const [revealed, setRevealed] = react.useState({})
    const [confirm, setConfirm] = react.useState({})
    const [busy, setBusy] = react.useState(false)
    const [notice, setNotice] = react.useState(null)
    const [usage, setUsage] = react.useState(null)
    const [usageError, setUsageError] = react.useState(null)
    const [usageLoading, setUsageLoading] = react.useState(true)
    const [snapshot, setSnapshot] = react.useState(() => readUsageSnapshot())

    const refresh = react.useCallback(async () => {
      setUsageLoading(true)
      // The two endpoints are independent and the usage one is the slow half,
      // so they run together: the keys must not wait for Tavily's counters.
      const keys = (async () => {
        try {
          const response = await fetch('/api/tavily-manager', { cache: 'no-store' })
          const data = await response.json()
          if (data.ok) { setServer(data); setStrategy(data.strategy) } else { setLoadError(data.error || 'Failed to load keys') }
        } catch (error) {
          setLoadError(String(error && error.message ? error.message : error))
        }
      })()
      const counters = (async () => {
        try {
          const response = await fetch('/api/tavily-usage', { cache: 'no-store' })
          const data = await response.json()
          setUsage(data)
          setUsageError(null)
          if (data.ok) {
            writeUsageSnapshot(data)
            setSnapshot(readUsageSnapshot())
          }
        } catch (error) {
          setUsageError(String(error && error.message ? error.message : error))
        } finally {
          setUsageLoading(false)
        }
      })()
      await Promise.all([keys, counters])
    }, [])

    react.useEffect(() => { refresh() }, [refresh])

    const saveStrategy = async (next) => {
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [], remove: [], strategy: next })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Strategy save failed' }); return }
        setNotice({ ok: 'Strategy saved — effective on the next search.' })
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveAdd = async (item) => {
      const value = item.value.trim()
      if (!value) return
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [value], remove: [], strategy })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Save failed' }); return }
        setNotice({ ok: 'Key saved.' })
        setAdds((current) => current.filter((entry) => entry.id !== item.id))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveRemove = async (masked) => {
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [], remove: [masked], strategy })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Delete failed' }); return }
        setNotice({ ok: 'Key removed.' })
        setConfirm((current) => Object.assign({}, current, { [masked]: false }))
        setRemoving((current) => Object.assign({}, current, { [masked]: false }))
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveReplace = async (masked) => {
      const value = typeof replaceDrafts[masked] === 'string' ? replaceDrafts[masked].trim() : ''
      if (!value) return
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [value], remove: [masked], strategy })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Update failed' }); return }
        setNotice({ ok: 'Key updated.' })
        setReplacing((current) => Object.assign({}, current, { [masked]: false }))
        setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const toggleReveal = async (masked) => {
      if (typeof revealed[masked] === 'string') {
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        return
      }
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager?reveal=' + encodeURIComponent(masked), { cache: 'no-store' })
        const data = await response.json()
        if (data.ok) setRevealed((current) => Object.assign({}, current, { [masked]: data.value }))
        else setNotice({ error: data.error || 'Failed to reveal key' })
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const markRemoved = (masked) => {
      if (confirm[masked] !== true) {
        setConfirm((current) => Object.assign({}, current, { [masked]: true }))
        return
      }
      setConfirm((current) => Object.assign({}, current, { [masked]: false }))
      setRemoving((current) => Object.assign({}, current, { [masked]: true }))
      setRevealed((current) => Object.assign({}, current, { [masked]: false }))
      saveRemove(masked)
    }

    const restore = (masked) => {
      setRemoving((current) => Object.assign({}, current, { [masked]: false }))
      setConfirm((current) => Object.assign({}, current, { [masked]: false }))
    }

    const startReplace = (masked) => {
      setReplacing((current) => Object.assign({}, current, { [masked]: true }))
      setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
      setNotice(null)
    }

    const cancelReplace = (masked) => {
      setReplacing((current) => Object.assign({}, current, { [masked]: false }))
      setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
    }

    const headStyle = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    const cellStyle = { padding: '8px', verticalAlign: 'top' }
    const snapshotRows = snapshot !== null && typeof snapshot === 'object' && snapshot.rows !== null && typeof snapshot.rows === 'object'
      ? snapshot.rows
      : null
    const snapshotAt = snapshot !== null && typeof snapshot === 'object' ? snapshot.at : null

    // The Plugins page draws the title, the icon, and the crumb — the
    // `plugins.bundle.config` contract puts the form alone in the entry — so
    // this renders no card chrome, no second heading, and no collapse.
    return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } },
      react.createElement('style', null, '.dts-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.dts-icon-btn:disabled{opacity:.4;cursor:default}.dts-icon-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}@keyframes dts-ring-spin{to{transform:rotate(360deg)}}@keyframes dts-ring-pulse{0%,100%{opacity:1}50%{opacity:.45}}.dts-ring-loading{animation:dts-ring-pulse 1.6s ease-in-out infinite}.dts-ring-sweep{animation:dts-ring-spin 1.1s linear infinite}@media (prefers-reduced-motion: reduce){.dts-ring-loading,.dts-ring-sweep{animation:none}.dts-ring-progress{transition:none!important}}'),
      react.createElement(react.Fragment, null,
              react.createElement('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
                'All keys are listed below; the green dot marks the first (primary) key. The tavily_search tool uses all keys according to the strategy. Built-in web_search is unaffected.'
              ),
              server !== null && server.writable !== undefined && server.writable.keys === false &&
                react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                  'Read-only: these keys come from the environment that launched dsh, so this card cannot change them. Unset TAVILY_API_KEYS / TAVILY_API_KEY in that shell and restart dsh to manage keys here.'
                ),
              loadError !== null && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(loadError)),
              react.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
                react.createElement('thead', null,
                  react.createElement('tr', null,
                    react.createElement('th', { style: headStyle }, 'Key'),
                    react.createElement('th', { style: headStyle }, 'Usage'),
                    react.createElement('th', { style: headStyle }, 'Saved'),
                    react.createElement('th', { style: headStyle }, 'Actions')
                  )
                ),
                react.createElement('tbody', null,
                  (server !== null ? server.keys : []).map((key, index) => {
                    const masked = key.masked
                    const isRemoved = removing[masked] === true
                    const isReplacing = replacing[masked] === true
                    const isRevealed = typeof revealed[masked] === 'string'
                    // Fresh counters win; until they arrive the last stored row is
                    // shown so the cell reads as "updating", never as "empty".
                    const freshRow = usage !== null && usage.ok === true
                      ? (usage.perKey.find((row) => row.masked === masked) || usage.perKey[index])
                      : null
                    const storedRow = snapshotRows !== null && Object.prototype.hasOwnProperty.call(snapshotRows, masked)
                      ? snapshotRows[masked]
                      : null
                    const usageRow = freshRow !== null && freshRow !== undefined ? freshRow : storedRow
                    const pct = usagePercent(usageRow)
                    const rawNumber = pct === null && usageRow !== null && usageRow !== undefined && usageRow.ok === true && usageRow.planUsage != null
                      ? usageRow.planUsage
                      : null
                    const isStale = (freshRow === null || freshRow === undefined) && storedRow !== null
                    return react.createElement('tr', { key: masked, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)', opacity: isRemoved ? 0.45 : 1 } },
                      react.createElement('td', { style: Object.assign({}, cellStyle, { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, wordBreak: 'break-all' }) },
                        isReplacing
                          ? react.createElement('textarea', {
                              style: Object.assign({}, inputStyle, { minHeight: 32, resize: 'vertical' }),
                              placeholder: 'New key value (leave blank to keep)',
                              value: replaceDrafts[masked] || '',
                              onChange: (event) => setReplaceDrafts((current) => Object.assign({}, current, { [masked]: event.target.value })),
                              disabled: busy
                            })
                          : react.createElement('span', null,
                              isRevealed ? revealed[masked] : masked,
                              key.primary === true && !isRemoved && react.createElement('span', {
                                title: 'Primary — the first key in the rotation',
                                style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-state-success-primary)', marginLeft: 8, verticalAlign: 'middle', flex: 'none' }
                              })
                            )
                      ),
                      react.createElement('td', { style: cellStyle },
                        react.createElement(UsageCircle, {
                          percent: pct,
                          number: rawNumber,
                          loading: usageLoading,
                          stale: isStale,
                          staleAt: snapshotAt,
                          onClick: refresh
                        })
                      ),
                      react.createElement('td', { style: Object.assign({}, cellStyle, { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }) }, formatDate(key.savedAt)),
                      react.createElement('td', { style: cellStyle },
                        isReplacing
                          ? react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                              react.createElement(IconButton, { icon: 'check', title: 'Save key', onClick: () => saveReplace(masked), disabled: busy || (typeof replaceDrafts[masked] === 'string' ? replaceDrafts[masked].trim().length === 0 : true) }),
                              react.createElement(IconButton, { icon: 'close', title: 'Cancel', onClick: () => cancelReplace(masked), disabled: busy })
                            )
                          : react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                              !isRemoved && react.createElement(IconButton, { icon: isRevealed ? 'eyeOff' : 'eye', title: isRevealed ? 'Hide key' : 'Show key', onClick: () => toggleReveal(masked), disabled: busy }),
                              !isRemoved && react.createElement(IconButton, { icon: 'pencil', title: 'Edit', onClick: () => startReplace(masked), disabled: busy }),
                              react.createElement(IconButton, {
                                icon: isRemoved ? 'restore' : (confirm[masked] === true ? 'check' : 'trash'),
                                // A key the launching environment supplies is read-only, so the
                                // server would refuse. Say so on the control instead.
                                title: key.removable === false
                                  ? 'Read-only: this key comes from the environment that launched dsh. Unset it there and restart dsh to change it here.'
                                  : (isRemoved ? 'Restore' : (confirm[masked] === true ? 'Click again to confirm' : 'Delete')),
                                danger: !isRemoved,
                                className: isRemoved ? 'dts-icon-btn' : 'dts-icon-btn dts-icon-btn-danger',
                                onClick: () => isRemoved ? restore(masked) : markRemoved(masked),
                                disabled: busy || (key.removable === false && !isRemoved)
                              })
                            )
                      )
                    )
                  }),
                  adds.map((item) => react.createElement('tr', { key: item.id, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
                    react.createElement('td', { style: cellStyle },
                      react.createElement('input', {
                        style: inputStyle,
                        placeholder: 'New key value',
                        value: item.value,
                        onChange: (event) => setAdds((current) => current.map((entry) => entry.id === item.id ? Object.assign({}, entry, { value: event.target.value }) : entry)),
                        onKeyDown: (event) => { if (event.key === 'Enter') saveAdd(item) },
                        disabled: busy
                      })
                    ),
                    react.createElement('td', { style: cellStyle }, '—'),
                    react.createElement('td', { style: cellStyle }, '—'),
                    react.createElement('td', { style: cellStyle },
                      react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                        react.createElement(IconButton, { icon: 'check', title: 'Save key', onClick: () => saveAdd(item), disabled: busy || item.value.trim().length === 0 }),
                        react.createElement(IconButton, { icon: 'trash', title: 'Remove', danger: true, onClick: () => setAdds((current) => current.filter((entry) => entry.id !== item.id)), disabled: busy })
                      )
                    )
                  ))
                )
              ),
              react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                react.createElement('button', { type: 'button', style: btn, onClick: () => setAdds((current) => [...current, { id: 'add-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), value: '' }]), disabled: busy }, '+ Add key'),
              ),
              react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  react.createElement('label', { style: { fontWeight: 500, fontSize: 13 } }, 'Key usage strategy'),
                  react.createElement('select', {
                    style: { maxWidth: 280, height: 32, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', fontSize: 13 },
                    value: strategy,
                    onChange: (event) => saveStrategy(event.target.value),
                    disabled: busy
                  }, STRATEGIES.map((option) => react.createElement('option', { key: option.id, value: option.id }, option.label))),
                  notice !== null && react.createElement('span', { style: { fontSize: 13, color: notice.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, notice.ok ? notice.ok : String(notice.error))
                ),
                react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                  (STRATEGIES.find((option) => option.id === strategy) || STRATEGIES[0]).hint + ' Saved immediately when selected.'
                )
              ),
              usageError !== null && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(usageError)),
              usage !== null && usage.ok === false && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(usage.error))
            )
    )
  }

  // The entry the Plugins page renders. The contract asks for two views:
  // `summary` for the one-liner under the title, and `page` for the form with
  // its own save control. The page supplies the title, icon, and crumb, so the
  // summary is a plain string and the page view is the form alone — matching
  // how the shipped cards (WebSearchCard and friends) are written.
  function TavilyCard(props) {
    if (props && props.view === 'summary') {
      return 'Manage Tavily API keys and the key-usage strategy. The built-in web_search is never replaced.'
    }
    return react.createElement(TavilySettingsCard, null)
  }

  function apply(ctx) {
    // ONE slot. 0.1.6-alpha.2 moved plugin configuration to the sidebar
    // Plugins page and retired `settings.plugin.item`. This package no longer
    // registers a settings namespace, so the retired keyed slot has no key it
    // could claim. On rc.7 through 0.1.6-alpha.1 the tools and routes work but
    // this card has no host — see `docs/agents/plugin-design.md`.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      // Keyed by the bundle's package name. The Plugins page renders this on
      // the @moguiyu/dsh-tavily bundle page, between its description and rows.
      key: '@moguiyu/dsh-tavily',
      id: '@moguiyu/dsh-tavily'
    }, TavilyCard))
  }

  return { apply, inject }
}
