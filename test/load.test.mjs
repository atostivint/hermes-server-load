import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALL_SHOWN,
  chipLabel,
  formatBytes,
  formatPercent,
  levelOf,
  loadPercent,
  MAX_BACKOFF_MS,
  nextPollDelay,
  POLL_MS,
  shownFigures,
  shownPercents,
  tooltipLines
} from '../src/load.js'

test('the chip shows CPU, 1-minute load and RAM', () => {
  assert.equal(chipLabel({ cpu_percent: 23.4, load_avg: [1.2, 0.8, 0.5], memory: { percent: 61 } }), 'CPU 23% · Load 1.20 · RAM 61%')
})

test('the chip counts clients and the tooltip names each one', () => {
  const stats = {
    clients: { by_surface: { bighelp: 1, desktop: 2, mobile: 1 }, total: 4 },
    cpu_percent: 5,
    memory: { percent: 10 }
  }

  assert.equal(chipLabel(stats), 'CPU 5% · RAM 10% · 👥 4')
  assert.equal(tooltipLines(stats).at(-1), 'Clients: bighelp 1 · desktop 2 · mobile 1')
})

test('no client in a conversation reads as zero, an older backend shows no count at all', () => {
  const idle = { clients: { by_surface: {}, total: 0 }, cpu_percent: 5, memory: { percent: 10 } }

  assert.equal(chipLabel(idle), 'CPU 5% · RAM 10% · 👥 0')
  assert.equal(tooltipLines(idle).at(-1), 'Clients: none in a conversation')
  assert.equal(chipLabel({ cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10%')
})

test('the chip counts running Hermes executables and the tooltip names each command', () => {
  const stats = {
    clients: { by_surface: {}, total: 0 },
    cpu_percent: 5,
    memory: { percent: 10 },
    processes: { by_command: { chat: 3, serve: 1 }, total: 4 }
  }

  assert.equal(chipLabel(stats), 'CPU 5% · RAM 10% · 👥 0 · ⚙ 4')
  assert.equal(tooltipLines(stats).at(-1), 'Hermes running: chat 3 · serve 1')
  assert.equal(chipLabel({ clients: stats.clients, cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10% · 👥 0')
})

test('the chip shows only the switched-on figures, and only those colour it', () => {
  const stats = {
    clients: { by_surface: {}, total: 2 },
    cpu_count: 4,
    cpu_percent: 95,
    load_avg: [1, 1, 1],
    memory: { percent: 10 },
    processes: { by_command: {}, total: 3 }
  }
  const shown = shownFigures({ cpu: false, processes: false })

  assert.equal(chipLabel(stats, shown), 'Load 1.00 · RAM 10% · 👥 2')
  assert.equal(levelOf(...shownPercents(stats, shown)), 'normal')
  assert.equal(levelOf(...shownPercents(stats)), 'critical')
})

test('saved settings fill in defaults and ignore junk', () => {
  assert.deepEqual(shownFigures(undefined), ALL_SHOWN)
  assert.deepEqual(shownFigures({ bogus: false, ram: 'no', load: false }), { ...ALL_SHOWN, load: false })
})

test('a server that reports no load average keeps a CPU + RAM chip', () => {
  assert.equal(chipLabel({ cpu_percent: 5, memory: { percent: 10 } }), 'CPU 5% · RAM 10%')
})

test('load is weighed per core, so a saturated box colours the chip', () => {
  const stats = { cpu_count: 4, load_avg: [3.8, 2, 1] }

  assert.equal(loadPercent(stats), 95)
  assert.equal(levelOf(10, loadPercent(stats), 20), 'critical')
  assert.equal(loadPercent({ load_avg: [1, 1, 1] }), undefined)
})

test('bytes read in binary units, one decimal below 10', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(3.5 * 1024 ** 3), '3.5 GB')
  assert.equal(formatBytes(16 * 1024 ** 3), '16 GB')
  assert.equal(formatBytes(undefined), '?')
})

test('a missing percent shows a dash, never NaN%', () => {
  assert.equal(formatPercent(23.4), '23%')
  assert.equal(formatPercent(undefined), '—')
})

test('the chip takes the colour of its worst figure', () => {
  assert.equal(levelOf(10, 50), 'normal')
  assert.equal(levelOf(80, 20), 'warning')
  assert.equal(levelOf(20, 95), 'critical')
  assert.equal(levelOf(undefined, undefined), 'normal')
})

test('polling backs off on failure, capped, and resets on success', () => {
  assert.equal(nextPollDelay(0), POLL_MS)
  assert.ok(nextPollDelay(1) > POLL_MS)
  assert.equal(nextPollDelay(50), MAX_BACKOFF_MS)
})

test('the tooltip names the host and every figure the server sent', () => {
  const lines = tooltipLines({
    cpu_count: 8,
    cpu_percent: 12,
    hostname: 'gw-1',
    load_avg: [0.5, 0.4, 0.3],
    memory: { percent: 50, total: 8 * 1024 ** 3, used: 4 * 1024 ** 3 }
  })

  assert.deepEqual(lines, ['gw-1', 'CPU 12% · 8 cores', 'Load 0.5 / 0.4 / 0.3', 'RAM 4.0 GB / 8.0 GB (50%)'])
})

test('a Windows server without load average still gets a tooltip', () => {
  assert.deepEqual(tooltipLines({ cpu_percent: 5, memory: { percent: 10, total: 1024, used: 102 } }), [
    'CPU 5%',
    'RAM 102 B / 1.0 KB (10%)'
  ])
})
