# Hermes Vitals Light

Hermes **Desktop** and **TUI** plugin that shows the CPU, load average and RAM of the server the Desktop is
connected to as a status-bar chip: `CPU 23% · Load 1.20 · RAM 61%`. On a remote gateway (SSH, URL +
token) it measures the remote box, not your PC. Load is the 1-minute average (omitted when the
server reports none); the tooltip adds hostname, cores, 5/15-min load and RAM used / total. The chip turns amber at 75 % and red at
90 % of its worst figure (load counts per core: 4.0 on 4 cores = 100 %).

`👥 N` counts the sessions clients hold right now on the connected profile; the tooltip
breaks it down by client (`desktop 1 · bighelp 1 · mobile 1`). The names are the `source`
each client sends when it opens a session:

| Client | Shows as |
|---|---|
| Hermes Desktop | `desktop` |
| bighelp (iPhone) | `bighelp` |
| Conduit, "Desktop" connection (WebSocket) | `mobile` |
| Telegram, Discord, … | `gateway:<platform>` |
| Conduit in API mode (`/v1/runs`), any OpenAI-compatible client | not shown (the API server takes no session lease) |

`⚙ N` counts the Hermes executables running on the server right now, all profiles and
users it can see: each `hermes` command (`serve`, `chat`, `gateway`, `dashboard`…),
`hermes-agent`, `hermes-acp`. The tooltip breaks it down by command
(`Hermes running: chat 3 · serve 1`), so several agents launched in parallel show up as
`chat 3`. A Hermes started by another one counts once, under its top-level ancestor: the
Windows launcher and its python children, the TUI's `tui_gateway`, a `hermes` an agent runs
from its terminal. The Desktop app itself (`Hermes`, capitalised) is not counted.

**Settings ▸ Plugins ▸ Hermes Vitals Light** has one switch per figure (CPU, Load average, RAM,
Clients, Hermes processes), all on by default and saved per Desktop. A hidden figure no
longer colours the chip; with everything off the chip is just its icon. The tooltip shows
the full detail of what is measured. Clients and Hermes processes switched off are not
measured at all: the chip polls `/stats?skip=clients,processes` and the server skips the
registry read and the process scan (the TUI does the same for its own options).

## TUI

In `hermes --tui` the same figures sit in a card docked above the prompt, coloured like the
chip (the TUI's skin colours). The TUI measures the machine it runs on: the card runs
`plugin_api.py` with the TUI's own Hermes python, which prints the `/stats` body every 3 s
for as long as the card is docked.

| Command | Effect |
|---|---|
| `/vitals` | dock / undock the card |
| `/vitals ram off` | hide a figure: `cpu`, `load`, `ram`, `clients`, `processes` (`on` shows it, no `on`/`off` flips it) |
| `/vitals detail on` | add the Desktop tooltip lines (hostname, cores, 5/15-min load, RAM used / total, per-client and per-command counts) |
| `/vitals all on` · `all off` | every figure (not `detail`) |
| `/vitals reset` | back to the defaults: every figure on, `detail` off |
| `/vitals help` | usage and the current options |

Several go in one command (`/vitals cpu off load off detail on`); changing an option
docks the card. Options are saved in `<HERMES_HOME>/vitals.json`, shared by every TUI
of that home (the Desktop keeps its own, in Settings ▸ Plugins).

Three halves, one package (same layout as other unified Hermes plugins):

| Half | Where it runs | What it does |
|---|---|---|
| `desktop/plugin.js` | Hermes Desktop (renderer) | Chip in `statusBar.right`; polls `/stats` every 3 s, skips while the window is hidden, re-polls at once on a connection/profile switch. |
| `dashboard/plugin_api.py` | The Hermes backend you connect to | Read-only `GET /api/plugins/hermes-vitals-light/stats` via `psutil` (a Hermes core dependency) and `active_session_registry_snapshot()`. Returns only load figures, the hostname, per-client session counts and per-command process counts. |
| `tui/hermes-vitals-light.mjs` | Hermes TUI (`<HERMES_HOME>/tui-widgets/`) | Ambient widget app `/vitals`; inlines `plugin_api.py` and runs it as a child (`python -c`) for the figures. |

Without the backend half on the server, the chip shows `CPU —` (tooltip explains) and the
poll backs off up to 60 s.

## Install

Desktop and TUI halves (this machine; the Desktop one ships off, enable it in
**Capabilities → Plugins**; the TUI picks the widget up live, no restart):

```
node scripts/build.mjs       # src/ -> desktop/plugin.js, tui/hermes-vitals-light.mjs
node scripts/install.mjs     # -> <hermes home>/desktop-plugins/hermes-vitals-light/plugin.js
                             #    <hermes home>/tui-widgets/hermes-vitals-light.mjs
                             # (Windows: %LOCALAPPDATA%\hermes, else ~/.hermes;
                             #  --desktop or --tui for one half only)
```

The TUI half needs nothing on a server: it measures the machine the TUI runs on.

Backend half (on the machine running the backend your Desktop connects to, e.g. over SSH):

```
hermes plugins install https://github.com/atostivint/hermes-vitals-light --enable
hermes plugins enable hermes-vitals-light                 # user plugins must be in plugins.enabled
# then restart that backend (hermes serve / dashboard)
```

## Footprint

Measured on Windows 11, 528 processes, Hermes venv python (2026-10-19):

| What | Cost |
|---|---|
| `/stats` in `hermes serve`, everything on | ~55 ms of CPU per poll (~1.8 % of a core at 3 s), almost all of it the process scan |
| `/stats?skip=processes` | ~0.6 ms per poll |
| `/stats?skip=clients,processes` | ~0.1 ms per poll |
| First process scan after start | ~5 s of one core |
| TUI card child (`python -c`) | ~60 MB RSS (launcher + python); ~2 % of a core with processes on, ~0.4 % off |
| Desktop half | one ~260-byte request every 3 s, none while the window is hidden |

## Tests

```
node --test test/load.test.mjs test/plugin.test.mjs test/tui.test.mjs        # Desktop + TUI halves (build first)
python -m unittest discover -s test -p "test_*.py"                           # backend unit
HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
                                                                             # real psutil, registry + FastAPI route, temp HERMES_HOME
```

## Known limits

- The client count is sessions, not devices (two chats open in bighelp count 2), and a
  client appears from its first message in a conversation, not from connecting.
- Counts cover the profile the Desktop is connected to (the registry is per profile).
- The process count is by command line: a Hermes run some other way (`python -c`, renamed
  script) is not seen, and processes of other users whose command line is unreadable are
  skipped. It includes the `hermes serve` answering the chip.

- CPU % is measured between two polls (`psutil.cpu_percent(interval=None)`); several windows
  polling the same server share that window, so each sees a shorter sample.
- Not verified in the running app yet: the chip's look in the real status bar, and the mount
  through `hermes serve` (tested against a plain FastAPI router).
- English-only tooltip and settings; fixed thresholds and 3 s cadence (the settings page
  only picks the chip's figures). Hosts older than Settings ▸ Plugins show every figure.
- CPU, load and RAM are always measured (one psutil call each, under 2 ms); switching them
  off only hides them.
- TUI: a TUI attached to a remote gateway still shows its own machine. On Windows psutil's
  first process scan takes ~13 s of one core (750 processes; later scans ~0.1 s), so `⚙ N`
  shows up that long after the card's first figures.
- TUI: the Desktop and TUI options are separate (the Desktop's live in its local storage).
