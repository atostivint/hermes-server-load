"""server-load backend, mounted at ``/api/plugins/server-load/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's), plus how many sessions each client holds right now.

The client count reads the active-session registry (``active_session_registry_snapshot``), keyed
by the ``source`` a client sends on ``session.create`` (``desktop``, ``bighelp``, ``mobile`` for
Conduit) or ``gateway:<platform>`` for messaging. The registry is per profile and shared across
processes; a client shows up from its first message, not from connecting.

The process count is every Hermes executable running on the box, any profile: ``hermes``
(per subcommand: ``serve``, ``chat``, ``gateway``…), ``hermes-agent``, ``hermes-acp``, or a
python running one of them. A Hermes started by another Hermes (the Windows launcher's python
child, the TUI's ``tui_gateway``, an agent running ``hermes`` from its terminal) counts under
its top-level ancestor. The Electron Desktop (``Hermes``, capitalised) is not counted.

Only load figures, the hostname and per-surface / per-command counts leave this process: no
session ids, process list, paths or env. Fail-open by contract: without psutil the route answers
``{"ok": false}``, and an unreadable registry or process table just omits that field.

The dashboard loader imports this file as a top-level module, so it stays self-contained. The TUI
widget (``src/tui.src.mjs``) inlines it too and runs it as ``python -c``: ``stream()`` prints the
same body as a JSON line every 3 s.
"""

from __future__ import annotations

import logging
import os
import platform
import re
from collections import Counter
from typing import Any, Iterable

logger = logging.getLogger(__name__)

try:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.
    from fastapi import APIRouter

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


def count_clients(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    by_surface = Counter(str(entry.get("surface") or "unknown") for entry in entries)
    return {"total": sum(by_surface.values()), "by_surface": dict(sorted(by_surface.items()))}


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


def snapshot(processes: bool = True) -> dict[str, Any]:
    """The ``/stats`` body: load figures, then the client and process counts when readable."""
    body = collect_stats()
    if body["ok"]:
        try:
            from hermes_cli.active_sessions import active_session_registry_snapshot

            body["clients"] = count_clients(active_session_registry_snapshot())
        except (ImportError, RuntimeError, OSError) as exc:  # ActiveSessionRegistryError is a RuntimeError
            logger.debug("server-load: session registry unreadable: %s", exc)
        if not processes:
            return body
        try:
            rows = (p.info for p in psutil.process_iter(["pid", "ppid", "cmdline"]))
            body["processes"] = count_hermes_processes(rows)
        except Exception as exc:  # psutil.Error, OSError: the chip just loses the count
            logger.debug("server-load: process table unreadable: %s", exc)
    return body


def stream(interval: float = 3.0, out: Any = None) -> None:
    """One ``snapshot()`` JSON line per ``interval``: the TUI widget's feed (``python -c`` on this file).

    The first line leaves out the process count: psutil's first full scan takes seconds on
    Windows (~13 s for 750 processes), later ones a tenth of a second. Ends when the reader goes
    away: a closed pipe, or a parent that died without closing it.
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
            out.write(json.dumps(snapshot(processes=not first)) + "\n")
            out.flush()
        except (BrokenPipeError, OSError, ValueError):  # ValueError: write to a closed file
            return
        first = False
        time.sleep(interval)
        if os.getppid() != parent:
            return


if router is not None:

    @router.get("/stats")
    def stats() -> dict[str, Any]:
        return snapshot()


if __name__ == "__main__":
    stream(float(os.environ.get("SERVER_LOAD_INTERVAL", "3")))
