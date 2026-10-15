/**
 * server-load for the Hermes TUI (`hermes --tui`) — the Desktop chip as an
 * ambient card docked above the status bar: "CPU 23% · Load 1.20 · RAM 61%
 * · 👥 2 · ⚙ 3", coloured by its worst figure.
 *
 * The TUI runs on the machine it measures, so there is no route to poll: the
 * card runs dashboard/plugin_api.py (inlined below) with the TUI's own Hermes
 * python, which prints the /stats body every 3 s. The child lives as long as
 * the card is docked.
 *
 *   /server-load                 dock / undock the card
 *   /server-load ram off         hide a figure (cpu, load, ram, clients, processes)
 *   /server-load detail on       add the tooltip lines under the chip line
 *   /server-load all on | reset  every figure / back to the defaults
 *   /server-load help            usage and the current options
 *
 * Options persist in <HERMES_HOME>/server-load.json, shared by every TUI of
 * that home.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js, options.js and
 * plugin_api.py are inlined to give the single tui/server-load.mjs the TUI
 * loads from <HERMES_HOME>/tui-widgets/.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { CHIP_FIGURES, chipLabel, levelOf, shownPercents, tooltipLines } from './load.js'
import { applyOptions, describeOptions, OPTIONS, tuiOptions } from './options.js'

// dashboard/plugin_api.py, inlined by scripts/build.mjs.
const STATS_PY = ''

const optionsFile = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'), 'server-load.json')

function loadOptions() {
  try {
    return tuiOptions(JSON.parse(readFileSync(optionsFile(), 'utf8')))
  } catch {
    return tuiOptions()
  }
}

function saveOptions(options) {
  try {
    writeFileSync(optionsFile(), `${JSON.stringify(options, null, 2)}\n`)
  } catch {
    // Unwritable home: the change holds for this card only.
  }
}

// The Hermes checkout the TUI runs from: the launcher's variable, else two levels above
// ui-tui/dist/entry.js (the same fallback as the TUI's gateway client).
function srcRoot() {
  const candidates = [process.env.HERMES_PYTHON_SRC_ROOT, process.argv[1] && resolve(dirname(process.argv[1]), '../..')]

  return candidates.find(dir => dir && existsSync(join(dir, 'hermes_cli')))
}

/** Starts the stats child; `onStats(body)` per line, `onStats(null)` once it is gone. Returns the stop. */
export function startFeed(onStats, spawnFn = spawn) {
  // The interpreter the TUI's own gateway runs on (set by the hermes launcher).
  const python = process.env.HERMES_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env = { ...process.env, PYTHONUNBUFFERED: '1' }
  const src = srcRoot()

  // The client count imports hermes_cli, which needs the source root on the path (as the gateway gets it).
  if (src) {
    env.PYTHONPATH = env.PYTHONPATH ? `${src}${delimiter}${env.PYTHONPATH}` : src
  }

  const child = spawnFn(python, ['-c', STATS_PY], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let buffer = ''
  let gone = false

  const end = () => {
    if (!gone) {
      gone = true
      onStats(null)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    const lines = (buffer + chunk).split('\n')

    buffer = lines.pop()

    for (const line of lines) {
      try {
        onStats(JSON.parse(line))
      } catch {
        // Not a stats line (a stray print): skip it.
      }
    }
  })
  child.on('error', end) // python not found
  child.on('exit', end)

  return () => {
    gone = true
    child.kill()
  }
}

// Widest each figure gets ("CPU 100%", "Load 12.34"…), so the card never resizes while ticking.
const FIGURE_WIDTH = { clients: 5, cpu: 8, load: 10, processes: 5, ram: 8 }

export function cardWidth(options) {
  const figures = CHIP_FIGURES.filter(({ id }) => options[id]).map(({ id }) => FIGURE_WIDTH[id])
  const line = figures.reduce((sum, width) => sum + width, 0) + 3 * Math.max(figures.length - 1, 0)

  // + border and padding; the detail lines need room for "Clients: desktop 1 · mobile 1".
  return Math.max(line + 4, options.detail ? 46 : 24)
}

// A function: the inlined modules (OPTIONS) are declared after this file's body.
export const usage = () => `usage: /server-load [${OPTIONS.join('|')}|all [on|off]] [reset]`

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Card({ options, t }) {
    const [feed, setFeed] = React.useState({ status: 'loading' })

    React.useEffect(
      () => startFeed(body => setFeed(body?.ok ? { stats: body, status: 'ok' } : { status: 'unavailable' })),
      []
    )

    const lines = []

    if (feed.status === 'loading') {
      lines.push(h(Text, { color: t.color.muted, key: 'chip' }, 'server load…'))
    } else if (feed.status === 'unavailable') {
      lines.push(
        h(Text, { color: t.color.error, key: 'chip', wrap: 'truncate-end' }, 'server load unavailable (python/psutil)')
      )
    } else {
      const { stats } = feed
      const level = levelOf(...shownPercents(stats, options))
      const color = { critical: t.color.error, normal: t.color.text, warning: t.color.warn }[level]

      // Every figure off still names the box, so the card is never empty.
      lines.push(h(Text, { color, key: 'chip', wrap: 'truncate-end' }, chipLabel(stats, options) || stats.hostname))

      if (options.detail) {
        for (const line of tooltipLines(stats)) {
          lines.push(h(Text, { color: t.color.muted, key: line, wrap: 'truncate-end' }, line))
        }
      }
    }

    return h(
      Box,
      { borderColor: t.color.border, borderStyle: 'round', flexDirection: 'column', paddingX: 1, width: cardWidth(options) },
      ...lines
    )
  }

  defineWidgetApp({
    id: 'server-load',
    help: 'CPU, load, RAM, clients and Hermes processes of this machine (args: options)',
    mode: 'ambient',
    // A getter: the TUI prints `usage` when init refuses, which makes `/server-load help`
    // (or a typo) show the options as they are now.
    get usage() {
      return `${usage()}\nnow: ${describeOptions(loadOptions())}`
    },

    init(arg) {
      const current = loadOptions()

      if (!arg.trim()) {
        return { options: current }
      }

      const options = applyOptions(arg, current)

      if (options) {
        saveOptions(options)
      }

      return options && { options }
    },

    // Ambient: never receives keys; contract-complete for modal reuse.
    reduce: (state, { ch, key }) => (key.escape || ch === 'q' ? null : state),

    render: ({ state, t }) => h(Card, { options: state.options, t })
  })
}
