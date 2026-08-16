window.__ModuleLoader__.load({
  id: "@moguiyu/dsh-tool-tavily-search",
  factory: function factory(require) {
  const react = require('react')
  const _primitives = require('@deepseek-ai/dsh-client-ui-primitives')

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

  function Switch({ checked, disabled, label, onChange }) {
    return react.createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked === true,
      'aria-label': label,
      disabled: disabled || checked === null,
      onClick: onChange,
      style: { width: 36, height: 20, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: checked === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', padding: 0, position: 'relative', flex: 'none', opacity: disabled ? 0.5 : 1 }
    }, react.createElement('span', { style: { position: 'absolute', top: 2, left: checked === true ? 18 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left .12s ease' } }))
  }

  function UsageCircle({ percent, size, label, onClick }) {
    const radius = 15
    const circumference = 2 * Math.PI * radius
    const pct = percent != null ? Math.min(100, Math.max(0, percent)) : 0
    const dim = size || 44
    return react.createElement('button', { type: 'button', title: 'Reload usage', 'aria-label': 'Reload usage', onClick: onClick, style: { position: 'relative', width: dim, height: dim, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
      react.createElement('svg', { width: dim, height: dim, viewBox: '0 0 40 40' },
        react.createElement('circle', { cx: 20, cy: 20, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 4 }),
        react.createElement('circle', { cx: 20, cy: 20, r: radius, fill: 'none', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 4, strokeLinecap: 'round', strokeDasharray: circumference, strokeDashoffset: circumference - (pct / 100) * circumference, transform: 'rotate(-90 20 20)' })
      ),
      react.createElement('span', { style: { position: 'absolute', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label != null ? label : (percent != null ? percent + '%' : '—'))
    )
  }

  function TavilyCard() {
    const [enabled, setEnabled] = react.useState(null)
    const [expanded, setExpanded] = react.useState(false)
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

    const refresh = react.useCallback(async () => {
      try {
        const response = await fetch('/api/tavily-toggle', { cache: 'no-store' })
        const data = await response.json()
        if (data.ok) { setEnabled(data.enabled); setLoadError(null) } else { setLoadError(data.error || 'Failed to load settings') }
      } catch (error) {
        setLoadError(String(error && error.message ? error.message : error))
      }
      try {
        const response = await fetch('/api/tavily-manager', { cache: 'no-store' })
        const data = await response.json()
        if (data.ok) { setServer(data); setStrategy(data.strategy) } else { setLoadError(data.error || 'Failed to load keys') }
      } catch (error) {
        setLoadError(String(error && error.message ? error.message : error))
      }
      try {
        const response = await fetch('/api/tavily-usage', { cache: 'no-store' })
        const data = await response.json()
        setUsage(data)
        setUsageError(null)
      } catch (error) {
        setUsageError(String(error && error.message ? error.message : error))
      }
    }, [])

    react.useEffect(() => { refresh() }, [refresh])

    const toggleEnabled = async () => {
      const next = enabled !== true
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Switch failed' }); return }
        setEnabled(data.enabled)
        setNotice({ ok: data.enabled ? 'Tavily search enabled — web_search uses Tavily.' : 'Tavily search off — web_search uses the native provider (DeepSeek). No Tavily key is needed.' })
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

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

    const isOff = enabled === false

    return react.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, minWidth: 0, overflow: 'hidden' } },
      react.createElement('style', null, '.dts-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.dts-icon-btn:disabled{opacity:.4;cursor:default}.dts-icon-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}'),
      react.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 14px', minHeight: 52, boxSizing: 'border-box' } },
        react.createElement('button', {
          type: 'button',
          'aria-expanded': expanded,
          onClick: () => setExpanded((current) => !current),
          style: { flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2, font: 'inherit', color: 'inherit' }
        },
          react.createElement('strong', { style: { fontSize: 14, fontWeight: 600, lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'Tavily Search'),
          react.createElement('span', { style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'Tavily-backed web_search · key rotation · usage')
        ),
        react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' } },
          react.createElement(Switch, { checked: enabled, disabled: busy, label: 'Tavily search enabled', onChange: toggleEnabled }),
          react.createElement('button', {
            type: 'button',
            className: 'dts-icon-btn',
            title: expanded ? 'Collapse' : 'Expand',
            'aria-label': expanded ? 'Collapse' : 'Expand',
            onClick: () => setExpanded((current) => !current),
            style: { width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }
          },
            react.createElement('span', { style: { display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .14s var(--ds-ease-in-out)' } },
              react.createElement(_primitives.IconChevronDownOutline14, { size: 12, 'aria-hidden': 'true' })
            )
          )
        )
      ),
      expanded && react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 16 } },
        isOff
          ? react.createElement('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
              'Tavily search is off — web_search uses the native provider (DeepSeek). No Tavily key is needed.'
            )
          : react.createElement(react.Fragment, null,
              react.createElement('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
                'All keys are listed below; the key marked with the green dot is the primary key used by web_search. The tavily_search tool uses all keys according to the strategy. Changes take effect on the next search.'
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
                    const usageRow = usage !== null && usage.ok === true ? usage.perKey[index] : null
                    const pct = usageRow && usageRow.ok && usageRow.planLimit != null && usageRow.planLimit > 0 && usageRow.planUsage != null
                      ? Math.min(100, Math.round((usageRow.planUsage / usageRow.planLimit) * 100))
                      : null
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
                                title: 'Primary — used by web_search',
                                style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-state-success-primary)', marginLeft: 8, verticalAlign: 'middle', flex: 'none' }
                              })
                            )
                      ),
                      react.createElement('td', { style: cellStyle },
                        react.createElement(UsageCircle, { percent: pct, label: pct != null ? pct + '%' : (usageRow && usageRow.ok && usageRow.planUsage != null ? String(usageRow.planUsage) : '—'), onClick: refresh })
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
                                title: isRemoved ? 'Restore' : (confirm[masked] === true ? 'Click again to confirm' : 'Delete'),
                                danger: !isRemoved,
                                className: isRemoved ? 'dts-icon-btn' : 'dts-icon-btn dts-icon-btn-danger',
                                onClick: () => isRemoved ? restore(masked) : markRemoved(masked),
                                disabled: busy
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
    )
  }

  function apply(ctx) {
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'tavily-search',
      order: 30,
      label: 'Tavily Search'
    }, TavilyCard))
  }

  return { apply, inject }
}
});
