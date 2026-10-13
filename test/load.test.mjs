import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatBytes, formatPercent, levelOf, MAX_BACKOFF_MS, nextPollDelay, POLL_MS, tooltipLines } from '../src/load.js'

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
