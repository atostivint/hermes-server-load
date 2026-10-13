/**
 * server-load — a status-bar chip with the CPU, load average and RAM of the
 * server the Desktop is connected to ("CPU 23% · Load 1.20 · RAM 61%"),
 * detail in the tooltip.
 *
 * The figures come from the backend half (`dashboard/plugin_api.py`,
 * GET /stats), which runs inside the connected `hermes serve`: on a remote
 * gateway it measures the remote box. Without that half on the server the chip
 * shows "CPU —" and the poll backs off.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js is inlined to give
 * the single plugin.js the runtime loader accepts.
 */

import { Codicon, host, STATUSBAR_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'

const LEVEL_COLOR = { critical: '#ef4444', normal: undefined, warning: '#f59e0b' }

const LOADING = { status: 'loading' }

function createLoadStore(ctx) {
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
      const stats = await ctx.rest('/stats', { timeoutMs: 5000 })

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

function LoadChip({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.get)

  if (state.status === 'loading') {
    return null
  }

  if (state.status === 'unavailable') {
    return jsx(Tip, {
      label: 'Server load unavailable: enable the server-load plugin on this server, then restart its backend.',
      children: jsxs('span', {
        className: CHIP_CLASS,
        children: [jsx(Codicon, { name: 'pulse', size: '0.7rem' }), jsx('span', { children: 'CPU —' })]
      })
    })
  }

  const { stats } = state

  return jsx(Tip, {
    label: jsx('div', {
      className: 'flex flex-col gap-0.5 tabular-nums',
      children: tooltipLines(stats).map(line => jsx('div', { children: line }, line))
    }),
    children: jsxs('span', {
      className: CHIP_CLASS,
      style: { color: LEVEL_COLOR[levelOf(stats.cpu_percent, loadPercent(stats), stats.memory?.percent)] },
      children: [jsx(Codicon, { name: 'pulse', size: '0.7rem' }), jsx('span', { children: chipLabel(stats) })]
    })
  })
}

export default {
  id: 'server-load',
  name: 'Server load',
  description: 'CPU and RAM of the connected Hermes server, as a status-bar chip.',
  defaultEnabled: false,
  register(ctx) {
    const store = createLoadStore(ctx)

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 90,
      render: () => jsx(LoadChip, { store })
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

function chipLabel(stats) {
  const parts = [`CPU ${formatPercent(stats.cpu_percent)}`]

  if (Number.isFinite(stats.load_avg?.[0])) {
    parts.push(`Load ${stats.load_avg[0].toFixed(2)}`)
  }

  parts.push(`RAM ${formatPercent(stats.memory?.percent)}`)

  return parts.join(' · ')
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

  return lines
}
