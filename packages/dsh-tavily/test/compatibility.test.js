import assert from 'node:assert/strict'
import { test } from 'node:test'
import semver from 'semver'

import {
  check,
  cordisRange,
  hostRange,
  loadData,
  matrix,
  validate,
} from '../scripts/sync-compatibility.mjs'

// `compatibility.json` is the single source of truth for the compatibility
// claims, and `scripts/sync-compatibility.mjs` is the only thing that writes
// them. The strings used to be hand-edited in five places and were got wrong
// twice, silently — npm only warns and the plugin still runs — so the gate is a
// fixed-point test: applying the generator to a correct file must reproduce it
// byte for byte.
//
// The two lists mean different things. `lines`/`cordis` are the span the seam
// mechanism covers (best effort, kept wide); `verifiedReleases` is the store
// matrix (the narrower set actually booted here, a rolling window over the last
// few host lines). Adding to the second is a claim — verify it first and record
// it in `docs/agents/verification.md`.

test('compatibility.json satisfies its own invariants', () => {
  validate(loadData())
})

test('the manifests and READMEs match compatibility.json', () => {
  const drifted = check()
  assert.deepEqual(drifted, [],
    'run: node packages/dsh-tavily/scripts/sync-compatibility.mjs --write\nout of sync: ' + drifted.join(', '))
})

test('each declared line is exactly one caret comparator', () => {
  const data = loadData()
  assert.equal(hostRange(data), data.lines.map((value) => '^' + value).join(' || '))
  assert.equal(cordisRange(data), data.cordis.map((value) => '^' + value).join(' || '))
})

test('every verified release is accepted by the declared range', () => {
  const data = loadData()
  const range = hostRange(data)
  for (const release of data.verifiedReleases) {
    assert.ok(semver.satisfies(release, range), release + ' is not accepted by "' + range + '"')
  }
})

test('the store matrix is exactly the verified release list', () => {
  const data = loadData()
  assert.deepEqual(Object.keys(matrix(data)), data.verifiedReleases)
  for (const value of Object.values(matrix(data))) assert.equal(value, 'compatible')
})

// Dropping a comparator is a BREAKING change for anyone still on that line, and
// it is the kind of edit that used to slip through silently. Retiring a line is
// deliberate: delete it here in the same commit that explains why.
const BASELINE_LINES = [
  '0.1.0-rc.7',
  '0.1.1-rc.1',
  '0.1.2-alpha.2',
  '0.1.3-alpha.1',
  '0.1.5-0',
  '0.1.6-0',
  '0.1.7-0',
  '0.2.0-0',
  '0.2.1-0',
]

test('the declared span never shrinks silently', () => {
  const data = loadData()
  const missing = BASELINE_LINES.filter((line) => data.lines.includes(line) === false)
  assert.deepEqual(missing, [],
    'these lines disappeared from compatibility.json "lines": ' + missing.join(', ')
    + ' — retiring a host line is a breaking change and must be deliberate')
})
