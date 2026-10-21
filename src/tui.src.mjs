/**
 * hermes-vitals-light for the Hermes TUI (`hermes --tui`) — the Desktop chip as an
 * ambient card docked above the status bar: "CPU 23% · Load 1.20 · RAM 61%
 * · ⚙ 3", coloured by its worst figure. No session count here: it comes from
 * the server's /api/status, and the TUI measures its own machine.
 *
 * The TUI runs on the machine it measures, so there is no route to poll: the
 * card runs dashboard/plugin_api.py (inlined below) with the TUI's own Hermes
 * python, which prints the /stats body every 3 s. The child lives as long as
 * the card is docked.
 *
 *   /vitals                 dock / undock the card
 *   /vitals ram off         hide a figure (cpu, load, ram, processes)
 *   /vitals detail on       add the tooltip lines under the chip line
 *   /vitals every 10        refresh every 10 s (1, 3, 5, 10, 30 or 60; default 3)
 *   /vitals all on | reset  every figure / back to the defaults
 *   /vitals help            usage and the current options
 *
 * Options persist in <HERMES_HOME>/vitals.json, shared by every TUI of
 * that home.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js, options.js and
 * plugin_api.py are inlined to give the single tui/hermes-vitals-light.mjs the TUI
 * loads from <HERMES_HOME>/tui-widgets/.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHIP_FIGURES, chipLabel, DEFAULT_INTERVAL, INTERVALS, levelOf, shownPercents, skippedFigures, tooltipLines } from './load.js'
import { applyOptions, describeOptions, OPTIONS, tuiOptions } from './options.js'

// dashboard/plugin_api.py, inlined by scripts/build.mjs.
const STATS_PY = ''

const optionsFile = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'), 'vitals.json')

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

/**
 * Starts the stats child; `onStats(body)` per line, `onStats(null)` once it is gone. Returns the stop.
 * `skip`: the counts the child does not measure (`"clients,processes"`).
 */
export function startFeed(onStats, spawnFn = spawn, skip = '', interval = DEFAULT_INTERVAL) {
  // The interpreter the TUI's own gateway runs on (set by the hermes launcher).
  const python = process.env.HERMES_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env = { ...process.env, PYTHONUNBUFFERED: '1', VITALS_INTERVAL: String(interval), VITALS_SKIP: skip }

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

  // + border and padding; the detail lines need room for "Hermes running: chat 3 · serve 1".
  return Math.max(line + 4, options.detail ? 46 : 24)
}

// A function: the inlined modules (OPTIONS) are declared after this file's body.
export const usage = () => `usage: /vitals [${OPTIONS.join('|')}|all [on|off]] [every ${INTERVALS.join('|')}] [reset]`

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Card({ options, t }) {
    const [feed, setFeed] = React.useState({ status: 'loading' })
    const skip = skippedFigures(options).join(',')

    // A new child when a count is switched on or off (a hidden one is never measured) or the period changes.
    React.useEffect(
      () =>
        startFeed(
          body => setFeed(body?.ok ? { stats: body, status: 'ok' } : { status: 'unavailable' }),
          spawn,
          skip,
          options.interval
        ),
      [skip, options.interval]
    )

    const lines = []

    if (feed.status === 'loading') {
      lines.push(h(Text, { color: t.color.muted, key: 'chip' }, 'vitals…'))
    } else if (feed.status === 'unavailable') {
      lines.push(
        h(Text, { color: t.color.error, key: 'chip', wrap: 'truncate-end' }, 'vitals unavailable (python/psutil)')
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
    id: 'hermes-vitals-light',
    help: 'CPU, load, RAM and Hermes processes of this machine (args: options)',
    mode: 'ambient',
    // A getter: the TUI prints `usage` when init refuses, which makes `/vitals help`
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
