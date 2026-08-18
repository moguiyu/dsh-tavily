import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readToolEnabled, readToolState } from '../src/index.js'

test('advanced-tool state defaults off, prefers the new file, and falls back to legacy', () => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-backend-'))
  process.env.DSH_HOME = home
  try {
    assert.equal(readToolState(), null)
    assert.equal(readToolEnabled(), false)

    writeFileSync(join(home, 'tavily-toggle.json'), JSON.stringify({ enabled: true }))
    assert.equal(readToolEnabled(), true)

    writeFileSync(join(home, 'tavily-tool.json'), JSON.stringify({ enabled: false }))
    assert.equal(readToolEnabled(), false)

    writeFileSync(join(home, 'tavily-tool.json'), JSON.stringify({ enabled: true }))
    assert.equal(readToolEnabled(), true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
