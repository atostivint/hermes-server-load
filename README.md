# hermes-server-load

Hermes **Desktop** plugin that shows the CPU and RAM load of the server the Desktop is
connected to as a status-bar chip: `CPU 23% · RAM 61%`. On a remote gateway (SSH, URL +
token) it measures the remote box, not your PC. The tooltip gives the hostname, core count,
load average (Linux/macOS) and RAM used / total. The chip turns amber at 75 % and red at
90 % (the worse of the two figures).

Two halves, one package (same layout as other unified Hermes plugins):

| Half | Where it runs | What it does |
|---|---|---|
| `desktop/plugin.js` | Hermes Desktop (renderer) | Chip in `statusBar.right`; polls `/stats` every 3 s, skips while the window is hidden, re-polls at once on a connection/profile switch. |
| `dashboard/plugin_api.py` | The Hermes backend you connect to | Read-only `GET /api/plugins/server-load/stats` via `psutil` (a Hermes core dependency). Returns only load figures and the hostname. |

Without the backend half on the server, the chip shows `CPU —` (tooltip explains) and the
poll backs off up to 60 s.

## Install

Desktop half (this machine; ships off, enable it in **Capabilities → Plugins**):

```
node scripts/build.mjs       # src/ -> desktop/plugin.js (inlines load.js)
node scripts/install.mjs     # -> <hermes home>/desktop-plugins/server-load/
                             # (Windows: %LOCALAPPDATA%\hermes, else ~/.hermes)
```

Backend half (on the machine running the backend your Desktop connects to, e.g. over SSH):

```
hermes plugins install https://github.com/atostivint/hermes-server-load --enable
hermes plugins enable server-load                 # user plugins must be in plugins.enabled
# then restart that backend (hermes serve / dashboard)
```

## Tests

```
node --test test/load.test.mjs test/plugin.test.mjs                          # Desktop half
python -m unittest discover -s test -p "test_*.py"                           # backend unit
HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
                                                                             # real psutil + FastAPI route
```

## Known limits

- CPU % is measured between two polls (`psutil.cpu_percent(interval=None)`); several windows
  polling the same server share that window, so each sees a shorter sample.
- Not verified in the running app yet: the chip's look in the real status bar, and the mount
  through `hermes serve` (tested against a plain FastAPI router).
- English-only tooltip; fixed thresholds and 3 s cadence (no settings page yet).
