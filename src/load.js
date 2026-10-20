// Pure helpers for the status-bar chip: formatting, severity, poll cadence.
// Kept DOM- and SDK-free so the tests import it directly.

export const POLL_MS = 3000
export const MAX_BACKOFF_MS = 60_000

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '?'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

export function formatPercent(percent) {
  return Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
}

// 1-minute load per core, as a percent: a load of 4 on 4 cores is a saturated box.
export function loadPercent(stats) {
  const load1 = stats.load_avg?.[0]

  return Number.isFinite(load1) && stats.cpu_count > 0 ? (load1 / stats.cpu_count) * 100 : undefined
}

// What the chip can show, in chip order; each one is a switch in the settings page.
// `tui: false`: the TUI card has no server to ask, so it does not offer the figure.
export const CHIP_FIGURES = [
  { description: 'CPU use since the previous poll.', id: 'cpu', label: 'CPU' },
  { description: '1-minute load average (servers that report one).', id: 'load', label: 'Load average' },
  { description: 'Memory in use.', id: 'ram', label: 'RAM' },
  {
    description: '👥 sessions active in the last 5 minutes on the connected server (Hermes status).',
    id: 'clients',
    label: 'Active sessions',
    tui: false
  },
  { description: '⚙ Hermes executables running on the server.', id: 'processes', label: 'Hermes processes' }
]

export const ALL_SHOWN = Object.fromEntries(CHIP_FIGURES.map(({ id }) => [id, true]))

// Saved prefs over the defaults, so a figure added later starts shown.
export function shownFigures(saved) {
  const shown = { ...ALL_SHOWN }

  for (const id of Object.keys(ALL_SHOWN)) {
    if (typeof saved?.[id] === 'boolean') {
      shown[id] = saved[id]
    }
  }

  return shown
}

// The counts the backend skips measuring when they are hidden (the load figures cost nothing).
export const SERVER_SIDE = ['clients', 'processes']

export function skippedFigures(shown) {
  return SERVER_SIDE.filter(id => !shown[id])
}

// A backend older than `?skip` ignores it and measures everything, as before.
export function statsPath(shown) {
  const skip = skippedFigures(shown)

  return skip.length ? `/stats?skip=${skip.join(',')}` : '/stats'
}

export function chipLabel(stats, shown = ALL_SHOWN) {
  const parts = []

  if (shown.cpu) {
    parts.push(`CPU ${formatPercent(stats.cpu_percent)}`)
  }

  if (shown.load && Number.isFinite(stats.load_avg?.[0])) {
    parts.push(`Load ${stats.load_avg[0].toFixed(2)}`)
  }

  if (shown.ram) {
    parts.push(`RAM ${formatPercent(stats.memory?.percent)}`)
  }

  // An older backend half sends no `clients`: keep the chip as it was.
  if (shown.clients && Number.isInteger(stats.clients?.total)) {
    parts.push(`👥 ${stats.clients.total}`)
  }

  // Same for `processes`: Hermes executables running on the server.
  if (shown.processes && Number.isInteger(stats.processes?.total)) {
    parts.push(`⚙ ${stats.processes.total}`)
  }

  return parts.join(' · ')
}

// The percents that colour the chip: only the figures it shows.
export function shownPercents(stats, shown = ALL_SHOWN) {
  return [
    shown.cpu ? stats.cpu_percent : undefined,
    shown.load ? loadPercent(stats) : undefined,
    shown.ram ? stats.memory?.percent : undefined
  ]
}

// The chip takes the colour of its worst figure.
export function levelOf(...percents) {
  const worst = Math.max(...percents.filter(Number.isFinite), 0)

  return worst >= 90 ? 'critical' : worst >= 75 ? 'warning' : 'normal'
}

// A server without the backend half answers 404 on every poll; back off instead of
// hammering it, and recover at the normal cadence on the first success.
export function nextPollDelay(failures) {
  return failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
}

export function tooltipLines(stats) {
  const lines = []

  if (stats.hostname) {
    lines.push(stats.hostname)
  }

  lines.push(`CPU ${formatPercent(stats.cpu_percent)}${stats.cpu_count ? ` · ${stats.cpu_count} cores` : ''}`)

  if (Array.isArray(stats.load_avg)) {
    lines.push(`Load ${stats.load_avg.join(' / ')}`)
  }

  const memory = stats.memory

  if (memory) {
    lines.push(`RAM ${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${formatPercent(memory.percent)})`)
  }

  const bySurface = Object.entries(stats.clients?.by_surface ?? {})

  if (Number.isInteger(stats.clients?.total)) {
    // `by_surface` only comes from a backend half older than the /api/status count.
    lines.push(
      bySurface.length
        ? `Clients: ${bySurface.map(([surface, count]) => `${surface} ${count}`).join(' · ')}`
        : `Active sessions: ${stats.clients.total}`
    )
  }

  const byCommand = Object.entries(stats.processes?.by_command ?? {})

  if (Number.isInteger(stats.processes?.total)) {
    lines.push(
      byCommand.length
        ? `Hermes running: ${byCommand.map(([command, count]) => `${command} ${count}`).join(' · ')}`
        : 'Hermes running: none'
    )
  }

  return lines
}
