import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolPlugin from '../src/index.js'

function fakeCredentials(ctx) {
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'tvly-test', source: 'test' }),
    describe: async () => ({ configured: true }),
    set: async () => {},
    unset: async () => {},
  })
}

async function boot(home, config = { enabled: true }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin({ name: 'credentials-test', apply: fakeCredentials })
  const fiber = ctx.plugin(toolPlugin, config)
  await fiber
  return {
    ctx,
    fiber,
    async dispose() {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

test('tavily_search unregisters when disabled and restores when enabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  const bench = await boot(home)
  try {
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search'])

    await bench.fiber.update({ enabled: false }, true)
    assert.deepEqual(bench.ctx.tools.schemas(), [])

    await bench.fiber.update({ enabled: true }, true)
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('advanced tool defaults to off with no persisted state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  const bench = await boot(home, {})
  try {
    assert.deepEqual(bench.ctx.tools.schemas(), [])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('persisted tool state wins over plugin config on activation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  writeFileSync(join(home, 'tavily-tool.json'), JSON.stringify({ enabled: false }))
  const bench = await boot(home)
  try {
    assert.deepEqual(bench.ctx.tools.schemas(), [])

    rmSync(join(home, 'tavily-tool.json'))
    await bench.fiber.update({ enabled: true }, true)
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy tavily-toggle.json still migrates the persisted choice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tavily-toggle-'))
  writeFileSync(join(home, 'tavily-toggle.json'), JSON.stringify({ enabled: true }))
  const bench = await boot(home, { enabled: false })
  try {
    assert.deepEqual(bench.ctx.tools.schemas().map((schema) => schema.name), ['tavily_search'])
  } finally {
    await bench.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
