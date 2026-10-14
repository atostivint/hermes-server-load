// Inlines src/load.js into src/plugin.src.js -> desktop/plugin.js. The runtime
// loader reads ONE plugin.js and rewrites only SDK/react specifiers, so a
// relative import would not resolve.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = readFileSync(join(root, 'src/load.js'), 'utf8')
const entry = readFileSync(join(root, 'src/plugin.src.js'), 'utf8')

const importLine = /^import \{[^}]*\} from '\.\/load\.js'\r?\n/m

if (!importLine.test(entry)) {
  throw new Error("plugin.src.js must import from './load.js' on one line")
}

const inlined = load.replace(/^export /gm, '')
const out = entry.replace(importLine, '') + `\n// ── inlined from src/load.js ──\n${inlined}`

mkdirSync(join(root, 'desktop'), { recursive: true })
writeFileSync(join(root, 'desktop/plugin.js'), out)
console.log('wrote desktop/plugin.js')
