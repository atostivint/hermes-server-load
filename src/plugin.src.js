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
 * Settings ▸ Plugins ▸ Server load switches each figure on or off in the chip
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
import {
  CHIP_FIGURES,
  chipLabel,
  levelOf,
  nextPollDelay,
  POLL_MS,
  shownFigures,
  shownPercents,
  statsPath,
  tooltipLines
} from './load.js'

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
      label: 'Server load unavailable: enable the server-load plugin on this server, then restart its backend.',
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
  id: 'server-load',
  name: 'Server load',
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
      title: 'Server load',
      icon: 'pulse',
      render: () => jsx(ChipSettings, { prefs, update })
    })
  }
}
