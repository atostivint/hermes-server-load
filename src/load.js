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

export function chipLabel(stats) {
  const parts = [`CPU ${formatPercent(stats.cpu_percent)}`]

  if (Number.isFinite(stats.load_avg?.[0])) {
    parts.push(`Load ${stats.load_avg[0].toFixed(2)}`)
  }

  parts.push(`RAM ${formatPercent(stats.memory?.percent)}`)

  // An older backend half sends no `clients`: keep the chip as it was.
  if (Number.isInteger(stats.clients?.total)) {
    parts.push(`👥 ${stats.clients.total}`)
  }

  return parts.join(' · ')
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
    lines.push(
      bySurface.length
        ? `Clients: ${bySurface.map(([surface, count]) => `${surface} ${count}`).join(' · ')}`
        : 'Clients: none in a conversation'
    )
  }

  return lines
}
