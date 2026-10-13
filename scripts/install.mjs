// Copies desktop/plugin.js into <hermes home>/desktop-plugins/server-load/.
// Usage: node scripts/install.mjs [hermesHome]
// Home resolution mirrors hermes_constants: $HERMES_HOME, else %LOCALAPPDATA%\hermes
// on Windows, else ~/.hermes.
import { copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function defaultHome() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  }

  return join(homedir(), '.hermes')
}

const home = process.argv[2] || process.env.HERMES_HOME || defaultHome()
const dest = join(home, 'desktop-plugins', 'server-load')

mkdirSync(dest, { recursive: true })
copyFileSync(join(root, 'desktop/plugin.js'), join(dest, 'plugin.js'))
console.log(`installed -> ${join(dest, 'plugin.js')}`)
