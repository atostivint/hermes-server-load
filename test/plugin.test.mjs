// Wiring test: runs the BUILT desktop/plugin.js against a stub SDK/React and a fake
// ctx (rest, timers, dispose), the way the runtime loader would (specifiers rewritten).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function atom(value) {
  const listeners = new Set()

  return {
    get: () => value,
    set(next) {
      value = next
      listeners.forEach(fn => fn(value))
    },
    subscribe(fn) {
      listeners.add(fn)
      fn(value)

      return () => listeners.delete(fn)
    }
  }
}

const connectionId = atom('local')
const profile = atom('default')

globalThis.document = { hidden: false }

globalThis.__stubs = {
  atom,
  Codicon: 'Codicon',
  host: { state: { connectionId, profile } },
  jsx: (type, props) => ({ props, type }),
  jsxs: (type, props) => ({ props, type }),
  STATUSBAR_AREAS: { right: 'statusBar.right' },
  Tip: 'Tip',
  ToggleRow: 'ToggleRow',
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  useValue: store => store.get()
}

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.__plugin =')

new Function(
  'const { atom, Codicon, host, jsx, jsxs, STATUSBAR_AREAS, Tip, ToggleRow, useSyncExternalStore, useValue } = globalThis.__stubs;' +
    source
)()

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function load(rest, saved = {}) {
  const registered = []
  const disposers = []
  const timers = []
  const pages = []

  globalThis.__plugin.register({
    onDispose: fn => disposers.push(fn),
    register: contribution => registered.push(contribution),
    registerSettingsPage: page => pages.push(page),
    rest,
    storage: {
      get: (key, fallback) => (key in saved ? saved[key] : fallback),
      set: (key, value) => (saved[key] = value)
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, live: true, ms }
      timers.push(timer)

      return () => {
        timer.live = false
      }
    }
  })

  const fire = async () => {
    const timer = timers.filter(t => t.live).at(-1)
    timer.live = false
    await timer.fn()
    await settle()
  }

  // Chip render: the contribution yields <LoadChip store>; call it like React would.
  const chip = () => {
    const element = registered[0].render()

    return element.type(element.props)
  }

  // Settings page: <ChipSettings> -> one <ToggleRow> per figure.
  const toggles = () => {
    const element = pages[0].render()

    return element.type(element.props).props.children
  }

  return { chip, dispose: () => disposers.forEach(fn => fn()), fire, pages, registered, saved, timers, toggles }
}

function text(node) {
  if (node == null || typeof node !== 'object') {
    return node == null ? '' : String(node)
  }

  const children = node.props?.children

  return Array.isArray(children) ? children.map(text).join('') : text(children)
}

const STATS = {
  cpu_count: 4,
  cpu_percent: 23.4,
  hostname: 'gw-1',
  load_avg: [1.5, 1, 0.5],
  memory: { percent: 92, total: 8 * 1024 ** 3, used: 7 * 1024 ** 3 },
  ok: true
}

test('one chip lands in the right status bar and shows nothing before the first reply', () => {
  const plugin = load(() => new Promise(() => {}))

  assert.equal(plugin.registered.length, 1)
  assert.equal(plugin.registered[0].area, 'statusBar.right')
  assert.equal(plugin.chip(), null)
  plugin.dispose()
})

test('a reply from /stats paints CPU and RAM, coloured by the worst figure', async () => {
  const paths = []
  const plugin = load(async path => {
    paths.push(path)

    return STATS
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.deepEqual(paths, ['/stats'])
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50 · RAM 92%')
  assert.equal(chip.props.children.props.style.color, '#ef4444')
  assert.match(text(chip.props.label), /gw-1/)
  plugin.dispose()
})

test('each figure has a switch in Settings, saved, and a hidden one stops colouring the chip', async () => {
  const plugin = load(async () => STATS)

  await plugin.fire()

  const rows = plugin.toggles()
  assert.equal(plugin.pages[0].title, 'Server load')
  assert.deepEqual(
    rows.map(row => row.props.label),
    ['CPU', 'Load average', 'RAM', 'Clients', 'Hermes processes']
  )
  assert.ok(rows.every(row => row.props.checked))

  rows.find(row => row.props.label === 'RAM').props.onChange(false)

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), 'CPU 23% · Load 1.50')
  assert.equal(chip.props.children.props.style.color, undefined, 'RAM at 92% no longer turns it red')
  assert.equal(plugin.toggles().find(row => row.props.label === 'RAM').props.checked, false)
  assert.deepEqual(plugin.saved.chip, { clients: true, cpu: true, load: true, processes: true, ram: false })
  plugin.dispose()
})

test('counts switched off are skipped on the server from the next poll', async () => {
  const paths = []
  const plugin = load(async path => {
    paths.push(path)

    return STATS
  })

  await plugin.fire()
  plugin.toggles().find(row => row.props.label === 'Hermes processes').props.onChange(false)
  await plugin.fire()
  plugin.toggles().find(row => row.props.label === 'Clients').props.onChange(false)
  // RAM is one psutil call: hiding it changes nothing server-side.
  plugin.toggles().find(row => row.props.label === 'RAM').props.onChange(false)
  await plugin.fire()

  assert.deepEqual(paths, ['/stats', '/stats?skip=processes', '/stats?skip=clients,processes'])
  plugin.dispose()
})

test('saved settings come back on load, and every figure off leaves the icon', async () => {
  const plugin = load(async () => STATS, {
    chip: { clients: false, cpu: false, load: false, processes: false, ram: false }
  })

  await plugin.fire()

  const chip = plugin.chip()
  assert.equal(text(chip.props.children), '')
  assert.equal(chip.props.children.props.children[0].type, 'Codicon')
  assert.match(text(chip.props.label), /gw-1/, 'the tooltip keeps the detail')
  plugin.dispose()
})

test('a server without the backend half shows a dash and backs off', async () => {
  const plugin = load(async () => {
    throw new Error('404')
  })

  await plugin.fire()

  assert.equal(text(plugin.chip().props.children), 'CPU —')
  assert.ok(plugin.timers.at(-1).ms > 3000)
  plugin.dispose()
})

test('switching server drops the old reply and polls the new one', async () => {
  let release
  const plugin = load(() => new Promise(resolve => (release = resolve)))

  const pending = plugin.fire()
  connectionId.set('remote-ssh')
  release(STATS)
  await pending

  assert.equal(plugin.chip(), null, 'reply from the previous server must not paint')
  assert.equal(plugin.timers.filter(t => t.live).at(-1).ms, 0, 'new server is polled at once')
  plugin.dispose()
})
