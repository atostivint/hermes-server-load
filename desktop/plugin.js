/**
 * hermes-vitals-light — a status-bar chip with the CPU, load average and RAM of the
 * server the Desktop is connected to ("CPU 23% · Load 1.20 · RAM 61%"),
 * detail in the tooltip.
 *
 * The figures come from the backend half (`dashboard/plugin_api.py`,
 * GET /stats), which runs inside the connected `hermes serve`: on a remote
 * gateway it measures the remote box. Without that half on the server the chip
 * shows "CPU —" and the poll backs off.
 *
 * Settings ▸ Plugins ▸ Hermes Vitals Light switches each figure on or off in the chip
 * (persisted with ctx.storage); the tooltip has the full detail of what is
 * measured. Clients and Hermes processes switched off are not measured at all:
 * the poll asks the backend to skip them.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js is inlined to give
 * the single plugin.js the runtime loader accepts.
 */

import { atom, Codicon, host, STATUSBAR_AREAS, Tip, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'

const LEVEL_COLOR = { critical: '#ef4444', normal: undefined, warning: '#f59e0b' }

const LOADING = { status: 'loading' }

// `prefs`: the counts switched off are not measured on the server either (`?skip=`).
function createLoadStore(ctx, prefs) {
  const listeners = new Set()
  let state = LOADING
  let failures = 0
  // Bumped on every connection/profile switch so a reply from the previous
  // server can never paint over the new one.
  let generation = 0
  let cancelTimer = () => {}

  const set = next => {
    state = next
    listeners.forEach(fn => fn())
  }

  const schedule = ms => {
    cancelTimer()
    cancelTimer = ctx.setTimeout(poll, ms)
  }

  async function poll() {
    if (document.hidden) {
      schedule(POLL_MS)

      return
    }

    const mine = generation

    try {
      const stats = await ctx.rest(statsPath(prefs.get()), { timeoutMs: 5000 })

      if (mine !== generation) {
        return
      }

      if (stats?.ok) {
        failures = 0
        set({ stats, status: 'ok' })
      } else {
        failures++
        set({ status: 'unavailable' })
      }
    } catch {
      if (mine !== generation) {
        return
      }

      failures++
      set({ status: 'unavailable' })
    }

    schedule(nextPollDelay(failures))
  }

  const restart = () => {
    generation++
    failures = 0
    set(LOADING)
    schedule(0)
  }

  // Both atoms call back immediately on subscribe; that first call starts the loop.
  let started = false

  const onRouteChange = () => {
    if (started) {
      restart()
    }
  }

  ctx.onDispose(host.state.connectionId.subscribe(onRouteChange))
  ctx.onDispose(host.state.profile.subscribe(onRouteChange))
  ctx.onDispose(() => cancelTimer())
  started = true
  restart()

  return {
    get: () => state,
    subscribe: fn => {
      listeners.add(fn)

      return () => listeners.delete(fn)
    }
  }
}

const CHIP_CLASS =
  'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)'

function LoadChip({ prefs, store }) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const shown = useValue(prefs)

  if (state.status === 'loading') {
    return null
  }

  if (state.status === 'unavailable') {
    return jsx(Tip, {
      label: 'Hermes Vitals Light unavailable: enable the hermes-vitals-light plugin on this server, then restart its backend.',
      children: jsxs('span', {
        className: CHIP_CLASS,
        children: [jsx(Codicon, { name: 'pulse', size: '0.7rem' }), jsx('span', { children: 'CPU —' })]
      })
    })
  }

  const { stats } = state
  // Every figure switched off still leaves the icon, so the tooltip stays reachable.
  const label = chipLabel(stats, shown)

  return jsx(Tip, {
    label: jsx('div', {
      className: 'flex flex-col gap-0.5 tabular-nums',
      children: tooltipLines(stats).map(line => jsx('div', { children: line }, line))
    }),
    children: jsxs('span', {
      className: CHIP_CLASS,
      style: { color: LEVEL_COLOR[levelOf(...shownPercents(stats, shown))] },
      children: [jsx(Codicon, { name: 'pulse', size: '0.7rem' }), label ? jsx('span', { children: label }) : null]
    })
  })
}

function ChipSettings({ prefs, update }) {
  const shown = useValue(prefs)

  return jsx('div', {
    children: CHIP_FIGURES.map(({ description, id, label }) =>
      jsx(ToggleRow, { checked: shown[id], description, label, onChange: on => update({ [id]: on }) }, id)
    )
  })
}

export default {
  id: 'hermes-vitals-light',
  name: 'Hermes Vitals Light',
  description: 'CPU and RAM of the connected Hermes server, as a status-bar chip.',
  defaultEnabled: false,
  register(ctx) {
    const prefs = atom(shownFigures(ctx.storage?.get('chip', {})))
    const store = createLoadStore(ctx, prefs)

    const update = patch => {
      prefs.set({ ...prefs.get(), ...patch })
      ctx.storage?.set('chip', prefs.get())
    }

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 90,
      render: () => jsx(LoadChip, { prefs, store })
    })

    // Feature-detected: older hosts have no Settings ▸ Plugins page, the chip shows everything.
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Hermes Vitals Light',
      icon: 'pulse',
      render: () => jsx(ChipSettings, { prefs, update })
    })
  }
}

// ── inlined from src/load.js ──
// Pure helpers for the status-bar chip: formatting, severity, poll cadence.
// Kept DOM- and SDK-free so the tests import it directly.

const POLL_MS = 3000
const MAX_BACKOFF_MS = 60_000

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function formatBytes(bytes) {
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

function formatPercent(percent) {
  return Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
}

// 1-minute load per core, as a percent: a load of 4 on 4 cores is a saturated box.
function loadPercent(stats) {
  const load1 = stats.load_avg?.[0]

  return Number.isFinite(load1) && stats.cpu_count > 0 ? (load1 / stats.cpu_count) * 100 : undefined
}

// What the chip can show, in chip order; each one is a switch in the settings page.
// `tui: false`: the TUI card has no server to ask, so it does not offer the figure.
const CHIP_FIGURES = [
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

const ALL_SHOWN = Object.fromEntries(CHIP_FIGURES.map(({ id }) => [id, true]))

// Saved prefs over the defaults, so a figure added later starts shown.
function shownFigures(saved) {
  const shown = { ...ALL_SHOWN }

  for (const id of Object.keys(ALL_SHOWN)) {
    if (typeof saved?.[id] === 'boolean') {
      shown[id] = saved[id]
    }
  }

  return shown
}

// The counts the backend skips measuring when they are hidden (the load figures cost nothing).
const SERVER_SIDE = ['clients', 'processes']

function skippedFigures(shown) {
  return SERVER_SIDE.filter(id => !shown[id])
}

// A backend older than `?skip` ignores it and measures everything, as before.
function statsPath(shown) {
  const skip = skippedFigures(shown)

  return skip.length ? `/stats?skip=${skip.join(',')}` : '/stats'
}

function chipLabel(stats, shown = ALL_SHOWN) {
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
function shownPercents(stats, shown = ALL_SHOWN) {
  return [
    shown.cpu ? stats.cpu_percent : undefined,
    shown.load ? loadPercent(stats) : undefined,
    shown.ram ? stats.memory?.percent : undefined
  ]
}

// The chip takes the colour of its worst figure.
function levelOf(...percents) {
  const worst = Math.max(...percents.filter(Number.isFinite), 0)

  return worst >= 90 ? 'critical' : worst >= 75 ? 'warning' : 'normal'
}

// A server without the backend half answers 404 on every poll; back off instead of
// hammering it, and recover at the normal cadence on the first success.
function nextPollDelay(failures) {
  return failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
}

function tooltipLines(stats) {
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
