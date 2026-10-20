"""hermes-vitals-light backend, mounted at ``/api/plugins/hermes-vitals-light/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's), plus how many sessions each client holds right now.

The session count is Hermes's own ``active_sessions`` figure from its public ``GET /api/status``
(sessions not ended and active in the last 5 minutes, among the 50 most recent, current profile).
The route asks the server it runs in over loopback, on the socket address the request arrived
on (not its ``Host`` header: behind an SSH tunnel that is the tunnel's port). ``/api/status`` does
much more than count, so the answer is cached for 15 s, failures included. It needs the route to
run inside the server (``plugins.isolation: in_process``, the default); in the plugin host there
is no address to ask, and the count is left out. It is a total: no per-client breakdown.

The process count is every Hermes executable running on the box, any profile: ``hermes``
(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a
python running one of them. A Hermes started by another Hermes (the Windows launcher's python
child, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under
its top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted.

``?skip=clients,processes`` leaves those counts out and does not measure them: the chip asks
for it when they are switched off in its settings (the TUI passes ``VITALS_SKIP``).

Only load figures, the hostname and the session / per-command counts leave this process: no
session ids, process list, paths or env. Fail-open by contract: without psutil the route answers
``{"ok": false}``, and an unreachable ``/api/status`` or unreadable process table just omits
that field.

The dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI
widget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the
same body as a JSON line every 3 s.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import platform
import re
import time
import urllib.request
from collections import Counter
from typing import Any, Iterable

logger = logging.getLogger(__name__)

try:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.
    from fastapi import APIRouter, Request

    router = APIRouter()
except ImportError:  # pragma: no cover - unit env without FastAPI
    router = None

try:
    import psutil

    # cpu_percent(interval=None) measures since the previous call; prime it so the first poll
    # reports a real figure instead of 0.0, and the route never blocks a worker thread.
    psutil.cpu_percent(interval=None)
except ImportError:  # pragma: no cover - psutil is a Hermes core dependency
    psutil = None


def collect_stats(ps: Any = psutil) -> dict[str, Any]:
    if ps is None:
        return {"ok": False}
    vm = ps.virtual_memory()
    stats: dict[str, Any] = {
        "ok": True,
        "hostname": platform.node(),
        "cpu_percent": ps.cpu_percent(interval=None),
        "cpu_count": os.cpu_count(),
        "memory": {"total": vm.total, "used": vm.total - vm.available, "percent": vm.percent},
    }
    getloadavg = getattr(ps, "getloadavg", None)
    if getloadavg is not None:
        stats["load_avg"] = [round(v, 2) for v in getloadavg()]
    return stats


# ``/api/status`` also checks the config version, probes the gateway and lists the profiles and
# components, so it is asked about every STATUS_TTL seconds, not at the chip's 3 s cadence.
STATUS_TTL = 15.0
_STATUS_TIMEOUT = 2.0
_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy
_status_cache: tuple[float, str, int | None] = (0.0, "", None)  # (asked at, url, answer)


def status_url(scope: dict[str, Any]) -> str | None:
    """``/api/status`` of the server a request reached, from the socket it arrived on.

    Not the ``Host`` header: a client behind an SSH tunnel names the tunnel's local port.
    """
    server = scope.get("server")
    if not server or not server[1]:  # a unix socket has no port
        return None
    host = server[0]
    host = "127.0.0.1" if host in ("0.0.0.0", "") else "[::1]" if ":" in host else host
    scheme = "https" if scope.get("scheme") in ("https", "wss") else "http"
    return f"{scheme}://{host}:{server[1]}/api/status"


def active_sessions(url: str, clock: Any = time.monotonic) -> int | None:
    """Hermes's ``active_sessions`` from ``url``, or None when it cannot be read (cached, failures too)."""
    global _status_cache
    asked, cached_url, cached = _status_cache
    if cached_url == url and clock() - asked < STATUS_TTL:
        return cached
    total = None
    try:
        with _no_proxy.open(url, timeout=_STATUS_TIMEOUT) as response:
            total = json.load(response).get("active_sessions")
    except (OSError, ValueError, http.client.HTTPException, AttributeError) as exc:  # AttributeError: not a JSON object
        logger.debug("hermes-vitals-light: /api/status unreadable: %s", exc)
    if isinstance(total, bool) or not isinstance(total, int):
        total = None
    _status_cache = (clock(), url, total)
    return total


# Console scripts from Hermes' pyproject; None means "read the subcommand from argv".
_CONSOLE_SCRIPTS = {"hermes": None, "hermes-agent": "agent", "hermes-acp": "acp"}
_MODULES = {"hermes_cli.main": None, "agent.legacy_cli": "agent", "acp_adapter.entry": "acp", "tui_gateway.entry": "tui"}
_PYTHON = re.compile(r"^pythonw?(\d+(\.\d+)?)?$")


def _stem(path: str) -> str:
    name = re.split(r"[\\/]", path)[-1]
    return name[:-4] if name.lower().endswith(".exe") else name


def _subcommand(args: list[str]) -> str:
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in ("-p", "--profile"):
            skip = True
        elif not arg.startswith("-"):
            return arg
    return "chat"  # bare `hermes` opens a chat


def hermes_command(argv: list[str] | None) -> str | None:
    """The Hermes command a process runs (``serve``, ``chat``, ``acp``…), or None if it is not Hermes.

    Case-sensitive on purpose: the console scripts are lowercase, the Electron Desktop is ``Hermes``.
    """
    if not argv:
        return None
    rest = list(argv[1:])
    stem = _stem(argv[0])
    if _PYTHON.match(stem.lower()):
        while rest and rest[0].startswith("-") and rest[0] != "-m":
            del rest[: 2 if rest[0] in ("-X", "-W") else 1]  # interpreter flags (-u, -X utf8…)
        if len(rest) >= 2 and rest[0] == "-m" and rest[1] in _MODULES:
            fixed, rest = _MODULES[rest[1]], rest[2:]
        elif rest and _stem(rest[0]) in _CONSOLE_SCRIPTS:
            fixed, rest = _CONSOLE_SCRIPTS[_stem(rest[0])], rest[1:]
        else:
            return None
    elif stem in _CONSOLE_SCRIPTS:
        fixed = _CONSOLE_SCRIPTS[stem]
    else:
        return None
    return fixed or _subcommand(rest)


def count_hermes_processes(procs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Count top-level Hermes processes per command from ``{"pid", "ppid", "cmdline"}`` rows."""
    parents: dict[int, int] = {}
    commands: dict[int, str] = {}
    for info in procs:
        pid = info.get("pid")
        if pid is None:
            continue
        parents[pid] = info.get("ppid") or 0
        command = hermes_command(info.get("cmdline"))
        if command is not None:
            commands[pid] = command

    def under_another_hermes(pid: int) -> bool:
        seen = {pid}
        parent = parents.get(pid, 0)
        while parent and parent not in seen:
            if parent in commands:
                return True
            seen.add(parent)
            parent = parents.get(parent, 0)
        return False

    by_command = Counter(cmd for pid, cmd in commands.items() if not under_another_hermes(pid))
    return {"total": sum(by_command.values()), "by_command": dict(sorted(by_command.items()))}


# The figures a client can switch off server-side: the load figures cost one psutil call, the
# counts a ``/api/status`` call (every STATUS_TTL) and a full process scan (~50 ms of CPU per poll
# on 500 processes).
SKIPPABLE = ("clients", "processes")


def parse_skip(value: str | None) -> frozenset[str]:
    """``"clients,processes"`` -> the skippable names in it; unknown names are ignored."""
    return frozenset(name.strip() for name in (value or "").split(",")) & frozenset(SKIPPABLE)


def snapshot(clients: bool = True, processes: bool = True, url: str | None = None) -> dict[str, Any]:
    """The ``/stats`` body: load figures, then the session and process counts asked for, when readable.

    ``url`` is the server's ``/api/status``; without one (the TUI feed has no server) there is no session count.
    """
    body = collect_stats()
    if not body["ok"]:
        return body
    if clients and url:
        total = active_sessions(url)
        if total is not None:
            body["clients"] = {"total": total}
    if processes:
        try:
            rows = (p.info for p in psutil.process_iter(["pid", "ppid", "cmdline"]))
            body["processes"] = count_hermes_processes(rows)
        except Exception as exc:  # psutil.Error, OSError: the chip just loses the count
            logger.debug("hermes-vitals-light: process table unreadable: %s", exc)
    return body


def stream(interval: float = 3.0, out: Any = None, skip: frozenset[str] = frozenset()) -> None:
    """One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).

    The first line leaves out the process count: psutil's first full scan takes seconds on
    Windows (~13 s for 750 processes), later ones a tenth of a second. ``skip`` drops counts for
    good (the figures the card hides). Ends when the reader goes away: a closed pipe, or a parent
    that died without closing it.
    """
    import json
    import sys
    import time

    out = out or sys.stdout
    parent = os.getppid()
    time.sleep(min(interval, 0.5))  # give the first cpu_percent (primed at import) a real window
    first = True
    while True:
        try:
            body = snapshot(clients="clients" not in skip, processes=not first and "processes" not in skip)
            out.write(json.dumps(body) + "\n")
            out.flush()
        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file
            return
        first = False
        time.sleep(interval)
        if os.getppid() != parent:
            return


if router is not None:

    # ``?skip=clients,processes``: the counts the chip hides are not measured at all.
    @router.get("/stats")
    def stats(request: Request, skip: str = "") -> dict[str, Any]:
        skipped = parse_skip(skip)
        return snapshot(
            clients="clients" not in skipped,
            processes="processes" not in skipped,
            url=status_url(request.scope),
        )


if __name__ == "__main__":
    stream(float(os.environ.get("VITALS_INTERVAL", "3")), skip=parse_skip(os.environ.get("VITALS_SKIP")))
