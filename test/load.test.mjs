import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chipLabel,
  formatBytes,
  formatPercent,
  levelOf,
  loadPercent,
  MAX_BACKOFF_MS,
  nextPollDelay,
  POLL_MS,
  tooltipLines
} from '../src/load.js'

test('the chip shows CPU, 1-minute load and RAM', () => {
  assert.equal(chipLabel({ cpu_percent: 23.4, load_avg: [1.2, 0.8, 0.5], memory: { percent: 61 } }), 'CPU 23% · Load 1.20 · RAM 61%')
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
