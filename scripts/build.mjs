// Builds the two single-file halves that load at runtime:
// - src/plugin.src.js + load.js -> desktop/plugin.js. The Desktop loader reads ONE
//   plugin.js and rewrites only SDK/react specifiers, so a relative import would not resolve.
// - src/tui.src.mjs + load.js + options.js + dashboard/plugin_api.py -> tui/hermes-vitals-light.mjs.
//   The TUI imports one .mjs from <HERMES_HOME>/tui-widgets/ (node: builtins only).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')

// `import { … } from './x.js'` on one line; the module's exports become plain declarations.
function inline(source, modules) {
  let out = source

  for (const name of modules) {
    const importLine = new RegExp(`^import \\{[^}]*\\} from '\\./${name.replace('.', '\\.')}'\\r?\\n`, 'm')

    if (!importLine.test(out)) {
      throw new Error(`expected a one-line import from './${name}'`)
    }

    out = out.replace(importLine, '')
  }

  for (const name of modules) {
    // A module's own imports of its siblings are covered by the inlining above.
    const body = read(`src/${name}`)
      .replace(/^import \{[^}]*\} from '\.\/[\w.]+'\r?\n/gm, '')
      .replace(/^export /gm, '')

    out += `\n// ── inlined from src/${name} ──\n${body}`
  }

  return out
}

function write(path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
  console.log(`wrote ${path}`)
}

write('desktop/plugin.js', inline(read('src/plugin.src.js'), ['load.js']))

const placeholder = "const STATS_PY = ''"
const tui = read('src/tui.src.mjs')

if (!tui.includes(placeholder)) {
  throw new Error(`tui.src.mjs must declare ${placeholder}`)
}

write(
  'tui/hermes-vitals-light.mjs',
  inline(tui.replace(placeholder, `const STATS_PY = ${JSON.stringify(read('dashboard/plugin_api.py'))}`), [
    'load.js',
    'options.js'
  ])
)
