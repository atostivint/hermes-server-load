/**
 * hermes-vitals-light for the Hermes TUI (`hermes --tui`) — the Desktop chip as an
 * ambient card docked above the status bar: "CPU 23% · Load 1.20 · RAM 61%
 * · ⚙ 3", coloured by its worst figure. No session count here: it comes from
 * the server's /api/status, and the TUI measures its own machine.
 *
 * The TUI runs on the machine it measures, so there is no route to poll: the
 * card runs dashboard/plugin_api.py (inlined below) with the TUI's own Hermes
 * python, which prints the /stats body every 3 s. The child lives as long as
 * the card is docked.
 *
 *   /vitals                 dock / undock the card
 *   /vitals ram off         hide a figure (cpu, load, ram, processes)
 *   /vitals detail on       add the tooltip lines under the chip line
 *   /vitals every 10        refresh every 10 s (1, 3, 5, 10, 30 or 60; default 3)
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
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// dashboard/plugin_api.py, inlined by scripts/build.mjs.
const STATS_PY = "\"\"\"hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.\r\n\r\nOne read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the\r\nDesktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports\r\nthe remote box, not the Desktop's), plus how many sessions each client holds right now.\r\n\r\nThe session count is Hermes's own ``active_sessions`` figure from its public ``GET /api/status``\r\n(sessions not ended and active in the last 5 minutes, among the 50 most recent, current profile).\r\nThe route asks the server it runs in over loopback, on the socket address the request arrived\r\non (not its ``Host`` header: behind an SSH tunnel that is the tunnel's port). ``/api/status`` does\r\nmuch more than count, so the answer is cached for 15 s, failures included. It needs the route to\r\nrun inside the server (``plugins.isolation: in_process``, the default); in the plugin host there\r\nis no address to ask, and the count is left out. It is a total: no per-client breakdown.\r\n\r\nThe process count is every Hermes executable running on the box, any profile: ``hermes``\r\n(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a\r\npython running one of them. A Hermes started by another Hermes (the Windows launcher's python\r\nchild, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under\r\nits top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted.\r\n\r\n``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks\r\nfor it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).\r\n\r\nOnly load figures, the hostname and the session / per-command counts leave this process: no\r\nsession ids, process list, paths or env. Fail-open by contract: without psutil the route answers\r\n``{\"ok\": false}``, and an unreachable ``/api/status`` or unreadable process table just omits\r\nthat field.\r\n\r\nThe dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI\r\nwidget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the\r\nsame body as a JSON line every 3 s.\r\n\"\"\"\r\n\r\nfrom __future__ import annotations\r\n\r\nimport http.client\r\nimport json\r\nimport logging\r\nimport os\r\nimport platform\r\nimport re\r\nimport time\r\nimport urllib.request\r\nfrom collections import Counter\r\nfrom typing import Any, Iterable\r\n\r\nlogger = logging.getLogger(__name__)\r\n\r\ntry:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.\r\n    from fastapi import APIRouter, Request\r\n\r\n    router = APIRouter()\r\nexcept ImportError:  # pragma: no cover - unit env without FastAPI\r\n    router = None\r\n\r\ntry:\r\n    import psutil\r\n\r\n    # cpu_percent(interval=None) measures since the previous call; prime it so the first poll\r\n    # reports a real figure instead of 0.0, and the route never blocks a worker thread.\r\n    psutil.cpu_percent(interval=None)\r\nexcept ImportError:  # pragma: no cover - psutil is a Hermes core dependency\r\n    psutil = None\r\n\r\n\r\ndef collect_stats(ps: Any = psutil) -> dict[str, Any]:\r\n    if ps is None:\r\n        return {\"ok\": False}\r\n    vm = ps.virtual_memory()\r\n    stats: dict[str, Any] = {\r\n        \"ok\": True,\r\n        \"hostname\": platform.node(),\r\n        \"cpu_percent\": ps.cpu_percent(interval=None),\r\n        \"cpu_count\": os.cpu_count(),\r\n        \"memory\": {\"total\": vm.total, \"used\": vm.total - vm.available, \"percent\": vm.percent},\r\n    }\r\n    getloadavg = getattr(ps, \"getloadavg\", None)\r\n    if getloadavg is not None:\r\n        stats[\"load_avg\"] = [round(v, 2) for v in getloadavg()]\r\n    return stats\r\n\r\n\r\n# ``/api/status`` also checks the config version, probes the gateway and lists the profiles and\r\n# components, so it is asked about every STATUS_TTL seconds, not at the chip's 3 s cadence.\r\nSTATUS_TTL = 15.0\r\n_STATUS_TIMEOUT = 2.0\r\n_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy\r\n_status_cache: tuple[float, str, int | None] = (0.0, \"\", None)  # (asked at, url, answer)\r\n\r\n\r\ndef status_url(scope: dict[str, Any]) -> str | None:\r\n    \"\"\"``/api/status`` of the server a request reached, from the socket it arrived on.\r\n\r\n    Not the ``Host`` header: a client behind an SSH tunnel names the tunnel's local port.\r\n    \"\"\"\r\n    server = scope.get(\"server\")\r\n    if not server or not server[1]:  # a unix socket has no port\r\n        return None\r\n    host = server[0]\r\n    host = \"127.0.0.1\" if host in (\"0.0.0.0\", \"\") else \"[::1]\" if \":\" in host else host\r\n    scheme = \"https\" if scope.get(\"scheme\") in (\"https\", \"wss\") else \"http\"\r\n    return f\"{scheme}://{host}:{server[1]}/api/status\"\r\n\r\n\r\ndef active_sessions(url: str, clock: Any = time.monotonic) -> int | None:\r\n    \"\"\"Hermes's ``active_sessions`` from ``url``, or None when it cannot be read (cached, failures too).\"\"\"\r\n    global _status_cache\r\n    asked, cached_url, cached = _status_cache\r\n    if cached_url == url and clock() - asked < STATUS_TTL:\r\n        return cached\r\n    total = None\r\n    try:\r\n        with _no_proxy.open(url, timeout=_STATUS_TIMEOUT) as response:\r\n            total = json.load(response).get(\"active_sessions\")\r\n    except (OSError, ValueError, http.client.HTTPException, AttributeError) as exc:  # AttributeError: not a JSON object\r\n        logger.debug(\"hermes-vitals-light: /api/status unreadable: %s\", exc)\r\n    if isinstance(total, bool) or not isinstance(total, int):\r\n        total = None\r\n    _status_cache = (clock(), url, total)\r\n    return total\r\n\r\n\r\n# Console scripts from Hermes' pyproject; None means \"read the subcommand from argv\".\r\n_CONSOLE_SCRIPTS = {\"hermes\": None, \"hermes-agent\": \"agent\", \"hermes-acp\": \"acp\"}\r\n_MODULES = {\"hermes_cli.main\": None, \"agent.legacy_cli\": \"agent\", \"acp_adapter.entry\": \"acp\", \"tui_gateway.entry\": \"tui\"}\r\n_PYTHON = re.compile(r\"^pythonw?(\\d+(\\.\\d+)?)?$\")\r\n\r\n\r\ndef _stem(path: str) -> str:\r\n    name = re.split(r\"[\\\\/]\", path)[-1]\r\n    return name[:-4] if name.lower().endswith(\".exe\") else name\r\n\r\n\r\ndef _subcommand(args: list[str]) -> str:\r\n    skip = False\r\n    for arg in args:\r\n        if skip:\r\n            skip = False\r\n        elif arg in (\"-p\", \"--profile\"):\r\n            skip = True\r\n        elif not arg.startswith(\"-\"):\r\n            return arg\r\n    return \"chat\"  # bare `hermes` opens a chat\r\n\r\n\r\ndef hermes_command(argv: list[str] | None) -> str | None:\r\n    \"\"\"The Hermes command a process runs (``serve``, ``chat``, ``acp``…), or None if it is not Hermes.\r\n\r\n    Case-sensitive on purpose: the console scripts are lowercase, the Electron Desktop is ``Hermes``.\r\n    \"\"\"\r\n    if not argv:\r\n        return None\r\n    rest = list(argv[1:])\r\n    stem = _stem(argv[0])\r\n    if _PYTHON.match(stem.lower()):\r\n        while rest and rest[0].startswith(\"-\") and rest[0] != \"-m\":\r\n            del rest[: 2 if rest[0] in (\"-X\", \"-W\") else 1]  # interpreter flags (-u, -X utf8…)\r\n        if len(rest) >= 2 and rest[0] == \"-m\" and rest[1] in _MODULES:\r\n            fixed, rest = _MODULES[rest[1]], rest[2:]\r\n        elif rest and _stem(rest[0]) in _CONSOLE_SCRIPTS:\r\n            fixed, rest = _CONSOLE_SCRIPTS[_stem(rest[0])], rest[1:]\r\n        else:\r\n            return None\r\n    elif stem in _CONSOLE_SCRIPTS:\r\n        fixed = _CONSOLE_SCRIPTS[stem]\r\n    else:\r\n        return None\r\n    return fixed or _subcommand(rest)\r\n\r\n\r\ndef count_hermes_processes(procs: Iterable[dict[str, Any]]) -> dict[str, Any]:\r\n    \"\"\"Count top-level Hermes processes per command from ``{\"pid\", \"ppid\", \"cmdline\"}`` rows.\"\"\"\r\n    parents: dict[int, int] = {}\r\n    commands: dict[int, str] = {}\r\n    for info in procs:\r\n        pid = info.get(\"pid\")\r\n        if pid is None:\r\n            continue\r\n        parents[pid] = info.get(\"ppid\") or 0\r\n        command = hermes_command(info.get(\"cmdline\"))\r\n        if command is not None:\r\n            commands[pid] = command\r\n\r\n    def under_another_hermes(pid: int) -> bool:\r\n        seen = {pid}\r\n        parent = parents.get(pid, 0)\r\n        while parent and parent not in seen:\r\n            if parent in commands:\r\n                return True\r\n            seen.add(parent)\r\n            parent = parents.get(parent, 0)\r\n        return False\r\n\r\n    by_command = Counter(cmd for pid, cmd in commands.items() if not under_another_hermes(pid))\r\n    return {\"total\": sum(by_command.values()), \"by_command\": dict(sorted(by_command.items()))}\r\n\r\n\r\n# The figures a client can switch off server-side: the load figures cost one psutil call, the\r\n# counts a ``/api/status`` call (every STATUS_TTL) and a full process scan (~50 ms of CPU per poll\r\n# on 500 processes).\r\nSKIPPABLE = (\"clients\", \"processes\")\r\n\r\n\r\ndef parse_skip(value: str | None) -> frozenset[str]:\r\n    \"\"\"``\"clients,processes\"`` -> the skippable names in it; unknown names are ignored.\"\"\"\r\n    return frozenset(name.strip() for name in (value or \"\").split(\",\")) & frozenset(SKIPPABLE)\r\n\r\n\r\ndef snapshot(clients: bool = True, processes: bool = True, url: str | None = None) -> dict[str, Any]:\r\n    \"\"\"The ``/stats`` body: load figures, then the session and process counts asked for, when readable.\r\n\r\n    ``url`` is the server's ``/api/status``; without one (the TUI feed has no server) there is no session count.\r\n    \"\"\"\r\n    body = collect_stats()\r\n    if not body[\"ok\"]:\r\n        return body\r\n    if clients and url:\r\n        total = active_sessions(url)\r\n        if total is not None:\r\n            body[\"clients\"] = {\"total\": total}\r\n    if processes:\r\n        try:\r\n            rows = (p.info for p in psutil.process_iter([\"pid\", \"ppid\", \"cmdline\"]))\r\n            body[\"processes\"] = count_hermes_processes(rows)\r\n        except Exception as exc:  # psutil.Error, OSError: the chip just loses the count\r\n            logger.debug(\"hermes-vitals-light: process table unreadable: %s\", exc)\r\n    return body\r\n\r\n\r\ndef stream(interval: float = 3.0, out: Any = None, skip: frozenset[str] = frozenset()) -> None:\r\n    \"\"\"One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).\r\n\r\n    The first line leaves out the process count: psutil's first full scan takes seconds on\r\n    Windows (~13 s for 750 processes), later ones a tenth of a second. ``skip`` drops counts for\r\n    good (the figures the card hides). Ends when the reader goes away: a closed pipe, or a parent\r\n    that died without closing it.\r\n    \"\"\"\r\n    import json\r\n    import sys\r\n    import time\r\n\r\n    out = out or sys.stdout\r\n    parent = os.getppid()\r\n    time.sleep(min(interval, 0.5))  # give the first cpu_percent (primed at import) a real window\r\n    first = True\r\n    while True:\r\n        try:\r\n            body = snapshot(clients=\"clients\" not in skip, processes=not first and \"processes\" not in skip)\r\n            out.write(json.dumps(body) + \"\\n\")\r\n            out.flush()\r\n        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file\r\n            return\r\n        first = False\r\n        time.sleep(interval)\r\n        if os.getppid() != parent:\r\n            return\r\n\r\n\r\nif router is not None:\r\n\r\n    # ``?skip=clients,processes``: the counts the chip hides are not measured at all.\r\n    @router.get(\"/stats\")\r\n    def stats(request: Request, skip: str = \"\") -> dict[str, Any]:\r\n        skipped = parse_skip(skip)\r\n        return snapshot(\r\n            clients=\"clients\" not in skipped,\r\n            processes=\"processes\" not in skipped,\r\n            url=status_url(request.scope),\r\n        )\r\n\r\n\r\nif __name__ == \"__main__\":\r\n    stream(float(os.environ.get(\"VITALS_INTERVAL\", \"3\")), skip=parse_skip(os.environ.get(\"VITALS_SKIP\")))\r\n"

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

/**
 * Starts the stats child; `onStats(body)` per line, `onStats(null)` once it is gone. Returns the stop.
 * `skip`: the counts the child does not measure (`"clients,processes"`).
 */
export function startFeed(onStats, spawnFn = spawn, skip = '', interval = DEFAULT_INTERVAL) {
  // The interpreter the TUI's own gateway runs on (set by the hermes launcher).
  const python = process.env.HERMES_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env = { ...process.env, PYTHONUNBUFFERED: '1', VITALS_INTERVAL: String(interval), VITALS_SKIP: skip }

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

  // + border and padding; the detail lines need room for "Hermes running: chat 3 · serve 1".
  return Math.max(line + 4, options.detail ? 46 : 24)
}

// A function: the inlined modules (OPTIONS) are declared after this file's body.
export const usage = () => `usage: /vitals [${OPTIONS.join('|')}|all [on|off]] [every ${INTERVALS.join('|')}] [reset]`

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Card({ options, t }) {
    const [feed, setFeed] = React.useState({ status: 'loading' })
    const skip = skippedFigures(options).join(',')

    // A new child when a count is switched on or off (a hidden one is never measured) or the period changes.
    React.useEffect(
      () =>
        startFeed(
          body => setFeed(body?.ok ? { stats: body, status: 'ok' } : { status: 'unavailable' }),
          spawn,
          skip,
          options.interval
        ),
      [skip, options.interval]
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
    help: 'CPU, load, RAM and Hermes processes of this machine (args: options)',
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

// The refresh periods the settings offer, in seconds; the default is the 3 s cadence.
const INTERVALS = [1, 3, 5, 10, 30, 60]
const DEFAULT_INTERVAL = POLL_MS / 1000

// A saved period if it is one we offer, else the default.
function refreshInterval(saved) {
  return INTERVALS.includes(saved) ? saved : DEFAULT_INTERVAL
}

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
function nextPollDelay(failures, baseMs = POLL_MS) {
  return failures === 0 ? baseMs : Math.min(baseMs * 2 ** failures, Math.max(MAX_BACKOFF_MS, baseMs))
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

// ── inlined from src/options.js ──
// The TUI widget's options and its `/vitals <option> [on|off]` syntax.
// Pure, like load.js: the tests import it directly.


// The chip figures the TUI card can show.
const TUI_FIGURES = CHIP_FIGURES.filter(({ tui }) => tui !== false).map(({ id }) => id)

// Those plus `detail` (the Desktop tooltip lines under the chip line, off by default).
const OPTIONS = [...TUI_FIGURES, 'detail']

// `interval`: the refresh period in seconds (`/vitals every 10`), not a switch.
const TUI_DEFAULTS = {
  ...Object.fromEntries(TUI_FIGURES.map(id => [id, true])),
  detail: false,
  interval: DEFAULT_INTERVAL
}

// Saved options over the defaults, so an option added later starts at its default.
function tuiOptions(saved) {
  const options = { ...TUI_DEFAULTS, interval: refreshInterval(saved?.interval) }

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

    if (word === 'every') {
      // `every 10` or `every 10s`; only the offered periods.
      const seconds = Number.parseInt(words[i + 1], 10)

      if (!INTERVALS.includes(seconds)) {
        return null
      }

      next.interval = seconds
      i++
      continue
    }

    const ids = word === 'all' ? TUI_FIGURES : OPTIONS.includes(word) ? [word] : null

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
  return [...OPTIONS.map(id => `${id} ${options[id] ? 'on' : 'off'}`), `every ${options.interval}s`].join(' · ')
}
