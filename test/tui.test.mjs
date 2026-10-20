// TUI half: the option syntax (src/options.js), then the BUILT tui/hermes-vitals-light.mjs registered
// against a stub widget SDK, with a temp HERMES_HOME and a fake python child.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { applyOptions, describeOptions, TUI_DEFAULTS, tuiOptions } from '../src/options.js'

const ALL_OFF = { cpu: false, detail: false, load: false, processes: false, ram: false }

test('on/off set an option, a bare option flips it, several go in one command', () => {
  assert.equal(applyOptions('ram off', TUI_DEFAULTS).ram, false)
  assert.equal(applyOptions('RAM', TUI_DEFAULTS).ram, false)
  assert.equal(applyOptions('detail', TUI_DEFAULTS).detail, true)
  assert.deepEqual(applyOptions('cpu off load off detail on', TUI_DEFAULTS), {
    ...TUI_DEFAULTS,
    cpu: false,
    detail: true,
    load: false
  })
})

test('all covers the chip figures but not detail; reset restores the defaults', () => {
  assert.deepEqual(applyOptions('all off', { ...TUI_DEFAULTS, detail: true }), { ...ALL_OFF, detail: true })
  // Bare `all`: on unless everything already is.
  assert.equal(applyOptions('all', { ...TUI_DEFAULTS, ram: false }).ram, true)
  assert.equal(applyOptions('all', TUI_DEFAULTS).cpu, false)
  assert.deepEqual(applyOptions('reset', ALL_OFF), TUI_DEFAULTS)
})

test('an unknown word refuses the whole command', () => {
  assert.equal(applyOptions('help', TUI_DEFAULTS), null)
  assert.equal(applyOptions('cpu off disk off', TUI_DEFAULTS), null)
})

test('saved options sit over the defaults; junk is ignored', () => {
  assert.deepEqual(tuiOptions(undefined), TUI_DEFAULTS)
  assert.deepEqual(tuiOptions({ cpu: false, detail: 'yes', extra: true }), { ...TUI_DEFAULTS, cpu: false })
  assert.equal(describeOptions(TUI_DEFAULTS), 'cpu on · load on · ram on · processes on · detail off')
})

test('the card has no session count: it has no server to ask, and a saved one is ignored', () => {
  assert.equal('clients' in TUI_DEFAULTS, false)
  assert.equal(applyOptions('clients off', TUI_DEFAULTS), null)
  assert.equal('clients' in tuiOptions({ clients: true }), false)
})

// ── the built widget ──

process.env.HERMES_HOME = mkdtempSync(join(tmpdir(), 'hermes-vitals-light-'))

const widget = await import(pathToFileURL(join(import.meta.dirname, '../tui/hermes-vitals-light.mjs')).href)
const apps = new Map()
const h = (type, props, ...children) => ({ children, props, type })

widget.default({ Box: 'Box', defineWidgetApp: app => apps.set(app.id, app), h, React: {}, Text: 'Text' })

const app = apps.get('hermes-vitals-light')

test('the widget docks as an ambient app; options persist in HERMES_HOME', () => {
  assert.equal(app.mode, 'ambient')
  assert.deepEqual(app.init(''), { options: TUI_DEFAULTS })

  assert.deepEqual(app.init('ram off detail on'), { options: { ...TUI_DEFAULTS, detail: true, ram: false } })
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.HERMES_HOME, 'vitals.json'), 'utf8')), {
    ...TUI_DEFAULTS,
    detail: true,
    ram: false
  })
  // A bare relaunch keeps them.
  assert.equal(app.init('').options.ram, false)

  app.init('reset')
})

test('a refused command prints the usage with the current options', () => {
  app.init('cpu off')

  assert.equal(app.init('help'), null)
  assert.match(app.usage, /^usage: \/vitals \[cpu\|load\|ram\|processes\|detail\|all \[on\|off\]\] \[reset\]/)
  assert.match(app.usage, /now: cpu off · load on/)

  app.init('reset')
})

test('the card is as wide as its widest figures, so it never resizes', () => {
  assert.equal(widget.cardWidth(TUI_DEFAULTS), 8 + 10 + 8 + 5 + 3 * 3 + 4)
  assert.equal(widget.cardWidth({ ...ALL_OFF, ram: true }), 24)
  assert.equal(widget.cardWidth({ ...ALL_OFF, detail: true }), 46)
})

function fakeSpawn() {
  const child = new EventEmitter()

  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.kill = () => {
    child.killed = true
  }

  const calls = []

  return {
    calls,
    child,
    spawn: (...args) => {
      calls.push(args)

      return child
    }
  }
}

test('the feed runs plugin_api.py under the TUI python and parses split JSON lines', () => {
  process.env.HERMES_PYTHON = '/venv/bin/python'

  const { calls, child, spawn } = fakeSpawn()
  const seen = []
  const stop = widget.startFeed(body => seen.push(body), spawn)

  const [python, args, options] = calls[0]

  assert.equal(python, '/venv/bin/python')
  assert.equal(options.env.VITALS_SKIP, '')
  assert.equal(args[0], '-c')
  assert.match(args[1], /def stream\(/)
  assert.match(args[1], /if __name__ == "__main__":/)

  child.stdout.emit('data', '{"ok": true, "cpu_')
  child.stdout.emit('data', 'percent": 5}\r\nnoise\n{"ok": false}\n')
  assert.deepEqual(seen, [{ cpu_percent: 5, ok: true }, { ok: false }])

  stop()
  assert.equal(child.killed, true)
  child.emit('exit') // our own kill is not "gone"
  assert.equal(seen.length, 2)
})

test('the counts the card hides are passed to the child, which skips them', () => {
  const { calls, spawn } = fakeSpawn()

  widget.startFeed(() => {}, spawn, 'clients,processes')()

  assert.equal(calls[0][2].env.VITALS_SKIP, 'clients,processes')
  assert.match(calls[0][1][1], /VITALS_SKIP/)
})

test('a missing python or a dead child reports the feed gone, once', () => {
  const { child, spawn } = fakeSpawn()
  const seen = []

  widget.startFeed(body => seen.push(body), spawn)
  child.emit('error', new Error('spawn python ENOENT'))
  child.emit('exit', 1)

  assert.deepEqual(seen, [null])
})
