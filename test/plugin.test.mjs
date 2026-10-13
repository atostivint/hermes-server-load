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
  Codicon: 'Codicon',
  host: { state: { connectionId, profile } },
  jsx: (type, props) => ({ props, type }),
  jsxs: (type, props) => ({ props, type }),
  STATUSBAR_AREAS: { right: 'statusBar.right' },
  Tip: 'Tip',
  useSyncExternalStore: (subscribe, snapshot) => snapshot()
}

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.__plugin =')

new Function(
  'const { Codicon, host, jsx, jsxs, STATUSBAR_AREAS, Tip, useSyncExternalStore } = globalThis.__stubs;' + source
)()

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function load(rest) {
  const registered = []
  const disposers = []
  const timers = []

  globalThis.__plugin.register({
    onDispose: fn => disposers.push(fn),
    register: contribution => registered.push(contribution),
    rest,
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

  return { chip, dispose: () => disposers.forEach(fn => fn()), fire, registered, timers }
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
