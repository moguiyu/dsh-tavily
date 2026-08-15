/**
 * Generate lib/client.js (the window.__ModuleLoader__ bundle) from
 * src/client.js. The factory must be self-contained (no module-scope
 * references) so Function.prototype.toString round-trips it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { id, factory } from '../src/client.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'lib', 'client.js')
const body = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(id)},\n  factory: ${factory.toString()}\n});\n`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, body)
console.log(`built ${out} (${body.length} bytes)`)
