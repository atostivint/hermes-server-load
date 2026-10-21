// The TUI widget's options and its `/vitals <option> [on|off]` syntax.
// Pure, like load.js: the tests import it directly.

import { CHIP_FIGURES, DEFAULT_INTERVAL, INTERVALS, refreshInterval } from './load.js'

// The chip figures the TUI card can show.
const TUI_FIGURES = CHIP_FIGURES.filter(({ tui }) => tui !== false).map(({ id }) => id)

// Those plus `detail` (the Desktop tooltip lines under the chip line, off by default).
export const OPTIONS = [...TUI_FIGURES, 'detail']

// `interval`: the refresh period in seconds (`/vitals every 10`), not a switch.
export const TUI_DEFAULTS = {
  ...Object.fromEntries(TUI_FIGURES.map(id => [id, true])),
  detail: false,
  interval: DEFAULT_INTERVAL
}

// Saved options over the defaults, so an option added later starts at its default.
export function tuiOptions(saved) {
  const options = { ...TUI_DEFAULTS, interval: refreshInterval(saved?.interval) }

  for (const id of OPTIONS) {
    if (typeof saved?.[id] === 'boolean') {
      options[id] = saved[id]
    }
  }

  return options
}

const SWITCH = { off: false, on: true }

/**
 * Applies `cpu off`, `ram`, `all on`, `reset`, `cpu off ram off`… to `current`.
 * `all` covers the chip figures, not `detail`.
 * Returns the new options, or null when a word is not an option.
 */
export function applyOptions(arg, current) {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const next = { ...current }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]

    if (word === 'reset') {
      Object.assign(next, TUI_DEFAULTS)
      continue
    }

    if (word === 'every') {
      // `every 10` or `every 10s`; only the offered periods.
      const seconds = Number.parseInt(words[i + 1], 10)

      if (!INTERVALS.includes(seconds)) {
        return null
      }

      next.interval = seconds
      i++
      continue
    }

    const ids = word === 'all' ? TUI_FIGURES : OPTIONS.includes(word) ? [word] : null

    if (!ids) {
      return null
    }

    const value = SWITCH[words[i + 1]]

    if (value !== undefined) {
      i++
    }

    // Without on/off: flip, and `all` turns everything on unless it already is.
    const on = value ?? !ids.every(id => next[id])

    for (const id of ids) {
      next[id] = on
    }
  }

  return next
}

export function describeOptions(options) {
  return [...OPTIONS.map(id => `${id} ${options[id] ? 'on' : 'off'}`), `every ${options.interval}s`].join(' · ')
}
