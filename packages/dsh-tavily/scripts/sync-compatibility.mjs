#!/usr/bin/env node
/**
 * `compatibility.json` is the single source of truth for this repo's DSH
 * compatibility claims; this script is the only thing that writes them.
 *
 *   node packages/dsh-tavily/scripts/sync-compatibility.mjs --write
 *   node packages/dsh-tavily/scripts/sync-compatibility.mjs --check
 *
 * What it drives:
 *
 * - the `@deepseek-ai/dsh-home-paths` and `@deepseek-ai/dsh-tools` peer ranges
 *   in `packages/dsh-tavily/package.json` — one `^<minimum>` comparator per
 *   supported line;
 * - the `@deepseek-ai/cordis` peer range in the same manifest;
 * - `dsh.compatibility.dshReleases` in BOTH manifests (the repo-root wrapper
 *   mirrors the package's, deliberately: it is what a `dsh plugin add
 *   github:…` reading of the root manifest sees);
 * - the comparator list between the `<!-- compat:lines -->` sentinels in
 *   `README.md` and `README.zh-CN.md`.
 *
 * Why it exists: the comparator list used to be hand-edited in five places
 * (two manifests, two lockfiles, both READMEs) and the matrix in two, and it
 * was got wrong twice, **silently** — npm only warns and the plugin still
 * runs. Prerelease comparators never cascade, so every host tuple needs its own
 * comparator; generating them from one list removes the class of defect rather
 * than the instance.
 *
 * The two lists mean different things and must not be conflated:
 *
 * - `lines` / `cordis` are the SPAN the seam mechanism covers — a best-effort
 *   declaration, additive, and cheap to keep wide. Dropping one is a breaking
 *   change for anyone still on that line, so lines are retired on a trigger
 *   (they no longer boot, or supporting them needs a conditional), never on age.
 * - `verifiedReleases` is the STORE MATRIX — the narrower set actually booted
 *   here, kept as a rolling window of the last few host tuples. Adding a release
 *   is a CLAIM: verify it first and record it in `docs/agents/verification.md`.
 *
 * `--check` is a fixed-point test: applying the transforms to a correct file
 * reproduces it byte for byte, so drift in any of the four files fails.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import semver from 'semver'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/+$/, '')
const DATA_PATH = join(ROOT, 'compatibility.json')
const PACKAGE_PATH = join(ROOT, 'packages', 'dsh-tavily', 'package.json')
const ROOT_PACKAGE_PATH = join(ROOT, 'package.json')
/** Each README keeps its own enumeration separator: `, ` in English, `、` in Chinese. */
const README_PATHS = [
  { path: join(ROOT, 'README.md'), separator: ', ' },
  { path: join(ROOT, 'README.zh-CN.md'), separator: '、' },
]

const HOST_PEERS = ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-tools']
const CORDIS_PEER = '@deepseek-ai/cordis'

/** The region the script owns inside each README. */
const SENTINEL = /(<!-- compat:lines -->)[\s\S]*?(<!-- \/compat:lines -->)/
const MATRIX_BLOCK = /("dshReleases":\s*\{)([\s\S]*?)(\n([ \t]*)\})/

const relative = (path) => path.slice(ROOT.length + 1)
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function loadData() {
  return JSON.parse(readFileSync(DATA_PATH, 'utf8'))
}

/** One `^<minimum>` comparator per minimum version, in the file's order. */
export const rangeOf = (values) => values.map((value) => '^' + value).join(' || ')

export const hostRange = (data) => rangeOf(data.lines)
export const cordisRange = (data) => rangeOf(data.cordis)
export const readmeList = (data, separator = ', ') => data.lines.map((value) => '`^' + value + '`').join(separator)

/** The store matrix, exactly the verified releases and nothing else. */
export function matrix(data) {
  const out = {}
  for (const release of data.verifiedReleases) out[release] = 'compatible'
  return out
}

function assertVersions(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`compatibility.json: "${field}" must be a non-empty array`)
  }
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string' || semver.valid(values[index]) === null) {
      throw new Error(`compatibility.json: ${field}[${index}] is not a version: ${JSON.stringify(values[index])}`)
    }
    if (index > 0 && semver.compare(values[index - 1], values[index]) >= 0) {
      throw new Error(`compatibility.json: ${field} must be strictly ascending — ${values[index - 1]} then ${values[index]}`)
    }
  }
}

/**
 * Reject a data file whose claims disagree with each other: a verified release
 * must be accepted by the generated range, and its tuple must be declared.
 */
export function validate(data) {
  assertVersions(data.lines, 'lines')
  assertVersions(data.cordis, 'cordis')
  assertVersions(data.verifiedReleases, 'verifiedReleases')
  const range = hostRange(data)
  for (const release of data.verifiedReleases) {
    if (!semver.satisfies(release, range)) {
      throw new Error(`compatibility.json: verified release ${release} is not accepted by the generated range "${range}"`)
    }
    const tuple = semver.parse(release)
    const line = `${tuple.major}.${tuple.minor}.${tuple.patch}`
    if (!data.lines.some((value) => value.startsWith(line + '-'))) {
      throw new Error(`compatibility.json: verified release ${release} has no declared line (${line}-*)`)
    }
  }
  return data
}

function withDepRange(text, dep, range) {
  const pattern = new RegExp('("' + escapeForRegExp(dep) + '":\\s*")[^"]*(")')
  if (pattern.test(text) === false) throw new Error(`the manifest has no "${dep}" dependency to write`)
  return text.replace(pattern, '$1' + range + '$2')
}

function withMatrix(text, body) {
  const match = text.match(MATRIX_BLOCK)
  if (match === null) throw new Error('the manifest has no "dshReleases" block to write')
  const closingIndent = match[4]
  const entryIndent = closingIndent + '  '
  const entries = Object.entries(body)
    .map(([key, value]) => `${entryIndent}"${key}": "${value}"`)
    .join(',\n')
  return text.replace(match[0], `${match[1]}\n${entries}\n${closingIndent}}`)
}

export function expectedPackageJson(text, data) {
  let out = text
  for (const dep of HOST_PEERS) out = withDepRange(out, dep, hostRange(data))
  out = withDepRange(out, CORDIS_PEER, cordisRange(data))
  return withMatrix(out, matrix(data))
}

export function expectedRootPackageJson(text, data) {
  return withMatrix(text, matrix(data))
}

export function expectedReadme(text, data, separator) {
  if (SENTINEL.test(text) === false) {
    throw new Error('the README is missing the <!-- compat:lines --> … <!-- /compat:lines --> sentinels')
  }
  return text.replace(SENTINEL, (_match, open, close) => open + readmeList(data, separator) + close)
}

/** Every file the data drives, with the exact text it should hold. */
export function targets(data) {
  const read = (path) => readFileSync(path, 'utf8')
  return [
    { path: PACKAGE_PATH, expected: expectedPackageJson(read(PACKAGE_PATH), data) },
    { path: ROOT_PACKAGE_PATH, expected: expectedRootPackageJson(read(ROOT_PACKAGE_PATH), data) },
    ...README_PATHS.map(({ path, separator }) => ({ path, expected: expectedReadme(read(path), data, separator) })),
  ]
}

/** Paths out of sync with `compatibility.json`; empty means clean. */
export function check() {
  const data = validate(loadData())
  const drifted = []
  for (const target of targets(data)) {
    if (readFileSync(target.path, 'utf8') !== target.expected) drifted.push(relative(target.path))
  }
  return drifted
}

/** Rewrite the drifted files; returns the paths it changed. */
export function write() {
  const data = validate(loadData())
  const changed = []
  for (const target of targets(data)) {
    if (readFileSync(target.path, 'utf8') !== target.expected) {
      writeFileSync(target.path, target.expected)
      changed.push(relative(target.path))
    }
  }
  return changed
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  try {
    if (process.argv.includes('--write')) {
      const changed = write()
      console.log(changed.length === 0
        ? 'compatibility: every file already matches compatibility.json'
        : 'compatibility: rewrote ' + changed.join(', '))
    } else {
      const drifted = check()
      if (drifted.length > 0) {
        console.error('compatibility: out of sync with compatibility.json:\n  ' + drifted.join('\n  ')
          + '\nRun: node packages/dsh-tavily/scripts/sync-compatibility.mjs --write')
        process.exitCode = 1
      } else {
        console.log('compatibility: manifests and READMEs match compatibility.json')
      }
    }
  } catch (error) {
    console.error('compatibility: ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}
