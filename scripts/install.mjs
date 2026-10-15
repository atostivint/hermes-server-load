// Installs the built halves of this machine:
// - Desktop: desktop/plugin.js -> <hermes home>/desktop-plugins/server-load/plugin.js
// - TUI:     tui/server-load.mjs -> <hermes home>/tui-widgets/server-load.mjs
// Usage: node scripts/install.mjs [--desktop | --tui] [hermesHome]   (both by default)
// Home resolution mirrors each reader: the Desktop follows hermes_constants ($HERMES_HOME,
// else %LOCALAPPDATA%\hermes on Windows, else ~/.hermes); the TUI's widget loader reads
// $HERMES_HOME, else ~/.hermes.
import { copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const only = args.find(arg => arg === '--desktop' || arg === '--tui')
const explicitHome = args.find(arg => !arg.startsWith('--')) || process.env.HERMES_HOME

function desktopHome() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  }

  return join(homedir(), '.hermes')
}

function install(from, dir, name) {
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(root, from), join(dir, name))
  console.log(`installed -> ${join(dir, name)}`)
}

if (only !== '--tui') {
  install('desktop/plugin.js', join(explicitHome || desktopHome(), 'desktop-plugins', 'server-load'), 'plugin.js')
}

if (only !== '--desktop') {
  install('tui/server-load.mjs', join(explicitHome || join(homedir(), '.hermes'), 'tui-widgets'), 'server-load.mjs')
}
