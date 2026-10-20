/**
 * hermes-vitals-light for the Hermes TUI (`hermes --tui`) — the Desktop chip as an
 * ambient card docked above the status bar: "CPU 23% · Load 1.20 · RAM 61%
 * · 👥 2 · ⚙ 3", coloured by its worst figure.
 *
 * The TUI runs on the machine it measures, so there is no route to poll: the
 * card runs dashboard/plugin_api.py (inlined below) with the TUI's own Hermes
 * python, which prints the /stats body every 3 s. The child lives as long as
 * the card is docked.
 *
 *   /vitals                 dock / undock the card
 *   /vitals ram off         hide a figure (cpu, load, ram, clients, processes)
 *   /vitals detail on       add the tooltip lines under the chip line
 *   /vitals all on | reset  every figure / back to the defaults
 *   /vitals help            usage and the current options
 *
 * Options persist in <HERMES_HOME>/vitals.json, shared by every TUI of
 * that home.
 *
 * Edit this file, then `node scripts/build.mjs`: load.js, options.js and
 * plugin_api.py are inlined to give the single tui/hermes-vitals-light.mjs the TUI
 * loads from <HERMES_HOME>/tui-widgets/.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

// dashboard/plugin_api.py, inlined by scripts/build.mjs.
const STATS_PY = "\"\"\"hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.\n\nOne read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the\nDesktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports\nthe remote box, not the Desktop's), plus how many sessions each client holds right now.\n\nThe client count reads the active-session registry (``active_session_registry_snapshot``), keyed\nby the ``source`` a client sends on ``session.create`` (``desktop``, ``bighelp``, ``mobile`` for\nConduit) or ``gateway:<platform>`` for messaging. The registry is per profile and shared across\nprocesses; a client shows up from its first message, not from connecting.\n\nThe process count is every Hermes executable running on the box, any profile: ``hermes``\n(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a\npython running one of them. A Hermes started by another Hermes (the Windows launcher's python\nchild, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under\nits top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted.\n\n``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks\nfor it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).\n\nOnly load figures, the hostname and per-surface / per-command counts leave this process: no\nsession ids, process list, paths or env. Fail-open by contract: without psutil the route answers\n``{\"ok\": false}``, and an unreadable registry or process table just omits that field.\n\nThe dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI\nwidget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the\nsame body as a JSON line every 3 s.\n\"\"\"\n\nfrom __future__ import annotations\n\nimport logging\nimport os\nimport platform\nimport re\nfrom collections import Counter\nfrom typing import Any, Iterable\n\nlogger = logging.getLogger(__name__)\n\ntry:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.\n    from fastapi import APIRouter\n\n    router = APIRouter()\nexcept ImportError:  # pragma: no cover - unit env without FastAPI\n    router = None\n\ntry:\n    import psutil\n\n    # cpu_percent(interval=None) measures since the previous call; prime it so the first poll\n    # reports a real figure instead of 0.0, and the route never blocks a worker thread.\n    psutil.cpu_percent(interval=None)\nexcept ImportError:  # pragma: no cover - psutil is a Hermes core dependency\n    psutil = None\n\n\ndef collect_stats(ps: Any = psutil) -> dict[str, Any]:\n    if ps is None:\n        return {\"ok\": False}\n    vm = ps.virtual_memory()\n    stats: dict[str, Any] = {\n        \"ok\": True,\n        \"hostname\": platform.node(),\n        \"cpu_percent\": ps.cpu_percent(interval=None),\n        \"cpu_count\": os.cpu_count(),\n        \"memory\": {\"total\": vm.total, \"used\": vm.total - vm.available, \"percent\": vm.percent},\n    }\n    getloadavg = getattr(ps, \"getloadavg\", None)\n    if getloadavg is not None:\n        stats[\"load_avg\"] = [round(v, 2) for v in getloadavg()]\n    return stats\n\n\ndef count_clients(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:\n    by_surface = Counter(str(entry.get(\"surface\") or \"unknown\") for entry in entries)\n    return {\"total\": sum(by_surface.values()), \"by_surface\": dict(sorted(by_surface.items()))}\n\n\n# Console scripts from Hermes' pyproject; None means \"read the subcommand from argv\".\n_CONSOLE_SCRIPTS = {\"hermes\": None, \"hermes-agent\": \"agent\", \"hermes-acp\": \"acp\"}\n_MODULES = {\"hermes_cli.main\": None, \"agent.legacy_cli\": \"agent\", \"acp_adapter.entry\": \"acp\", \"tui_gateway.entry\": \"tui\"}\n_PYTHON = re.compile(r\"^pythonw?(\\d+(\\.\\d+)?)?$\")\n\n\ndef _stem(path: str) -> str:\n    name = re.split(r\"[\\\\/]\", path)[-1]\n    return name[:-4] if name.lower().endswith(\".exe\") else name\n\n\ndef _subcommand(args: list[str]) -> str:\n    skip = False\n    for arg in args:\n        if skip:\n            skip = False\n        elif arg in (\"-p\", \"--profile\"):\n            skip = True\n        elif not arg.startswith(\"-\"):\n            return arg\n    return \"chat\"  # bare `hermes` opens a chat\n\n\ndef hermes_command(argv: list[str] | None) -> str | None:\n    \"\"\"The Hermes command a process runs (``serve``, ``chat``, ``acp``…), or None if it is not Hermes.\n\n    Case-sensitive on purpose: the console scripts are lowercase, the Electron Desktop is ``Hermes``.\n    \"\"\"\n    if not argv:\n        return None\n    rest = list(argv[1:])\n    stem = _stem(argv[0])\n    if _PYTHON.match(stem.lower()):\n        while rest and rest[0].startswith(\"-\") and rest[0] != \"-m\":\n            del rest[: 2 if rest[0] in (\"-X\", \"-W\") else 1]  # interpreter flags (-u, -X utf8…)\n        if len(rest) >= 2 and rest[0] == \"-m\" and rest[1] in _MODULES:\n            fixed, rest = _MODULES[rest[1]], rest[2:]\n        elif rest and _stem(rest[0]) in _CONSOLE_SCRIPTS:\n            fixed, rest = _CONSOLE_SCRIPTS[_stem(rest[0])], rest[1:]\n        else:\n            return None\n    elif stem in _CONSOLE_SCRIPTS:\n        fixed = _CONSOLE_SCRIPTS[stem]\n    else:\n        return None\n    return fixed or _subcommand(rest)\n\n\ndef count_hermes_processes(procs: Iterable[dict[str, Any]]) -> dict[str, Any]:\n    \"\"\"Count top-level Hermes processes per command from ``{\"pid\", \"ppid\", \"cmdline\"}`` rows.\"\"\"\n    parents: dict[int, int] = {}\n    commands: dict[int, str] = {}\n    for info in procs:\n        pid = info.get(\"pid\")\n        if pid is None:\n            continue\n        parents[pid] = info.get(\"ppid\") or 0\n        command = hermes_command(info.get(\"cmdline\"))\n        if command is not None:\n            commands[pid] = command\n\n    def under_another_hermes(pid: int) -> bool:\n        seen = {pid}\n        parent = parents.get(pid, 0)\n        while parent and parent not in seen:\n            if parent in commands:\n                return True\n            seen.add(parent)\n            parent = parents.get(parent, 0)\n        return False\n\n    by_command = Counter(cmd for pid, cmd in commands.items() if not under_another_hermes(pid))\n    return {\"total\": sum(by_command.values()), \"by_command\": dict(sorted(by_command.items()))}\n\n\n# The figures a client can switch off server-side: the load figures cost one psutil call, the\n# counts a registry read and a full process scan (~50 ms of CPU per poll on 500 processes).\nSKIPPABLE = (\"clients\", \"processes\")\n\n\ndef parse_skip(value: str | None) -> frozenset[str]:\n    \"\"\"``\"clients,processes\"`` -> the skippable names in it; unknown names are ignored.\"\"\"\n    return frozenset(name.strip() for name in (value or \"\").split(\",\")) & frozenset(SKIPPABLE)\n\n\ndef snapshot(clients: bool = True, processes: bool = True) -> dict[str, Any]:\n    \"\"\"The ``/stats`` body: load figures, then the client and process counts asked for, when readable.\"\"\"\n    body = collect_stats()\n    if not body[\"ok\"]:\n        return body\n    if clients:\n        try:\n            from hermes_cli.active_sessions import active_session_registry_snapshot\n\n            body[\"clients\"] = count_clients(active_session_registry_snapshot())\n        except (ImportError, RuntimeError, OSError) as exc:  # ActiveSessionRegistryError is a RuntimeError\n            logger.debug(\"hermes-vitals-light: session registry unreadable: %s\", exc)\n    if processes:\n        try:\n            rows = (p.info for p in psutil.process_iter([\"pid\", \"ppid\", \"cmdline\"]))\n            body[\"processes\"] = count_hermes_processes(rows)\n        except Exception as exc:  # psutil.Error, OSError: the chip just loses the count\n            logger.debug(\"hermes-vitals-light: process table unreadable: %s\", exc)\n    return body\n\n\ndef stream(interval: float = 3.0, out: Any = None, skip: frozenset[str] = frozenset()) -> None:\n    \"\"\"One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).\n\n    The first line leaves out the process count: psutil's first full scan takes seconds on\n    Windows (~13 s for 750 processes), later ones a tenth of a second. ``skip`` drops counts for\n    good (the figures the card hides). Ends when the reader goes away: a closed pipe, or a parent\n    that died without closing it.\n    \"\"\"\n    import json\n    import sys\n    import time\n\n    out = out or sys.stdout\n    parent = os.getppid()\n    time.sleep(min(interval, 0.5))  # give the first cpu_percent (primed at import) a real window\n    first = True\n    while True:\n        try:\n            body = snapshot(clients=\"clients\" not in skip, processes=not first and \"processes\" not in skip)\n            out.write(json.dumps(body) + \"\\n\")\n            out.flush()\n        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file\n            return\n        first = False\n        time.sleep(interval)\n        if os.getppid() != parent:\n            return\n\n\nif router is not None:\n\n    # ``?skip=clients,processes``: the counts the chip hides are not measured at all.\n    @router.get(\"/stats\")\n    def stats(skip: str = \"\") -> dict[str, Any]:\n        skipped = parse_skip(skip)\n        return snapshot(clients=\"clients\" not in skipped, processes=\"processes\" not in skipped)\n\n\nif __name__ == \"__main__\":\n    stream(float(os.environ.get(\"VITALS_INTERVAL\", \"3\")), skip=parse_skip(os.environ.get(\"VITALS_SKIP\")))\n"

const optionsFile = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'), 'vitals.json')

function loadOptions() {
  try {
    return tuiOptions(JSON.parse(readFileSync(optionsFile(), 'utf8')))
  } catch {
    return tuiOptions()
  }
}

function saveOptions(options) {
  try {
    writeFileSync(optionsFile(), `${JSON.stringify(options, null, 2)}\n`)
  } catch {
    // Unwritable home: the change holds for this card only.
  }
}

// The Hermes checkout the TUI runs from: the launcher's variable, else two levels above
// ui-tui/dist/entry.js (the same fallback as the TUI's gateway client).
function srcRoot() {
  const candidates = [process.env.HERMES_PYTHON_SRC_ROOT, process.argv[1] && resolve(dirname(process.argv[1]), '../..')]

  return candidates.find(dir => dir && existsSync(join(dir, 'hermes_cli')))
}

/**
 * Starts the stats child; `onStats(body)` per line, `onStats(null)` once it is gone. Returns the stop.
 * `skip`: the counts the child does not measure (`"clients,processes"`).
 */
export function startFeed(onStats, spawnFn = spawn, skip = '') {
  // The interpreter the TUI's own gateway runs on (set by the hermes launcher).
  const python = process.env.HERMES_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env = { ...process.env, PYTHONUNBUFFERED: '1', VITALS_SKIP: skip }
  const src = srcRoot()

  // The client count imports hermes_cli, which needs the source root on the path (as the gateway gets it).
  if (src) {
    env.PYTHONPATH = env.PYTHONPATH ? `${src}${delimiter}${env.PYTHONPATH}` : src
  }

  const child = spawnFn(python, ['-c', STATS_PY], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let buffer = ''
  let gone = false

  const end = () => {
    if (!gone) {
      gone = true
      onStats(null)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    const lines = (buffer + chunk).split('\n')

    buffer = lines.pop()

    for (const line of lines) {
      try {
        onStats(JSON.parse(line))
      } catch {
        // Not a stats line (a stray print): skip it.
      }
    }
  })
  child.on('error', end) // python not found
  child.on('exit', end)

  return () => {
    gone = true
    child.kill()
  }
}

// Widest each figure gets ("CPU 100%", "Load 12.34"…), so the card never resizes while ticking.
const FIGURE_WIDTH = { clients: 5, cpu: 8, load: 10, processes: 5, ram: 8 }

export function cardWidth(options) {
  const figures = CHIP_FIGURES.filter(({ id }) => options[id]).map(({ id }) => FIGURE_WIDTH[id])
  const line = figures.reduce((sum, width) => sum + width, 0) + 3 * Math.max(figures.length - 1, 0)

  // + border and padding; the detail lines need room for "Clients: desktop 1 · mobile 1".
  return Math.max(line + 4, options.detail ? 46 : 24)
}

// A function: the inlined modules (OPTIONS) are declared after this file's body.
export const usage = () => `usage: /vitals [${OPTIONS.join('|')}|all [on|off]] [reset]`

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Card({ options, t }) {
    const [feed, setFeed] = React.useState({ status: 'loading' })
    const skip = skippedFigures(options).join(',')

    // A new child when a count is switched on or off, so a hidden one is never measured.
    React.useEffect(
      () =>
        startFeed(body => setFeed(body?.ok ? { stats: body, status: 'ok' } : { status: 'unavailable' }), spawn, skip),
      [skip]
    )

    const lines = []

    if (feed.status === 'loading') {
      lines.push(h(Text, { color: t.color.muted, key: 'chip' }, 'vitals…'))
    } else if (feed.status === 'unavailable') {
      lines.push(
        h(Text, { color: t.color.error, key: 'chip', wrap: 'truncate-end' }, 'vitals unavailable (python/psutil)')
      )
    } else {
      const { stats } = feed
      const level = levelOf(...shownPercents(stats, options))
      const color = { critical: t.color.error, normal: t.color.text, warning: t.color.warn }[level]

      // Every figure off still names the box, so the card is never empty.
      lines.push(h(Text, { color, key: 'chip', wrap: 'truncate-end' }, chipLabel(stats, options) || stats.hostname))

      if (options.detail) {
        for (const line of tooltipLines(stats)) {
          lines.push(h(Text, { color: t.color.muted, key: line, wrap: 'truncate-end' }, line))
        }
      }
    }

    return h(
      Box,
      { borderColor: t.color.border, borderStyle: 'round', flexDirection: 'column', paddingX: 1, width: cardWidth(options) },
      ...lines
    )
  }

  defineWidgetApp({
    id: 'hermes-vitals-light',
    help: 'CPU, load, RAM, clients and Hermes processes of this machine (args: options)',
    mode: 'ambient',
    // A getter: the TUI prints `usage` when init refuses, which makes `/vitals help`
    // (or a typo) show the options as they are now.
    get usage() {
      return `${usage()}\nnow: ${describeOptions(loadOptions())}`
    },

    init(arg) {
      const current = loadOptions()

      if (!arg.trim()) {
        return { options: current }
      }

      const options = applyOptions(arg, current)

      if (options) {
        saveOptions(options)
      }

      return options && { options }
    },

    // Ambient: never receives keys; contract-complete for modal reuse.
    reduce: (state, { ch, key }) => (key.escape || ch === 'q' ? null : state),

    render: ({ state, t }) => h(Card, { options: state.options, t })
  })
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
const CHIP_FIGURES = [
  { description: 'CPU use since the previous poll.', id: 'cpu', label: 'CPU' },
  { description: '1-minute load average (servers that report one).', id: 'load', label: 'Load average' },
  { description: 'Memory in use.', id: 'ram', label: 'RAM' },
  { description: '👥 sessions clients hold on the connected profile.', id: 'clients', label: 'Clients' },
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
    lines.push(
      bySurface.length
        ? `Clients: ${bySurface.map(([surface, count]) => `${surface} ${count}`).join(' · ')}`
        : 'Clients: none in a conversation'
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

// ── inlined from src/options.js ──
// The TUI widget's options and its `/vitals <option> [on|off]` syntax.
// Pure, like load.js: the tests import it directly.


// Chip figures plus `detail` (the Desktop tooltip lines under the chip line, off by default).
const OPTIONS = [...CHIP_FIGURES.map(({ id }) => id), 'detail']

const TUI_DEFAULTS = { ...Object.fromEntries(CHIP_FIGURES.map(({ id }) => [id, true])), detail: false }

// Saved options over the defaults, so an option added later starts at its default.
function tuiOptions(saved) {
  const options = { ...TUI_DEFAULTS }

  for (const id of OPTIONS) {
    if (typeof saved?.[id] === 'boolean') {
      options[id] = saved[id]
    }
  }

  return options
}

const SWITCH = { off: false, on: true }

/**
 * Applies `cpu off`, `ram`, `all on`, `reset`, `cpu off ram off`… to `current`.
 * `all` covers the chip figures, not `detail`.
 * Returns the new options, or null when a word is not an option.
 */
function applyOptions(arg, current) {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const next = { ...current }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]

    if (word === 'reset') {
      Object.assign(next, TUI_DEFAULTS)
      continue
    }

    const ids = word === 'all' ? CHIP_FIGURES.map(({ id }) => id) : OPTIONS.includes(word) ? [word] : null

    if (!ids) {
      return null
    }

    const value = SWITCH[words[i + 1]]

    if (value !== undefined) {
      i++
    }

    // Without on/off: flip, and `all` turns everything on unless it already is.
    const on = value ?? !ids.every(id => next[id])

    for (const id of ids) {
      next[id] = on
    }
  }

  return next
}

function describeOptions(options) {
  return OPTIONS.map(id => `${id} ${options[id] ? 'on' : 'off'}`).join(' · ')
}
