"""server-load backend, mounted at ``/api/plugins/server-load/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's), plus how many sessions each client holds right now.

The client count reads the active-session registry (``active_session_registry_snapshot``), keyed
by the ``source`` a client sends on ``session.create`` (``desktop``, ``bighelp``, ``mobile`` for
Conduit) or ``gateway:<platform>`` for messaging. The registry is per profile and shared across
processes; a client shows up from its first message, not from connecting.

Only load figures, the hostname and per-surface counts leave this process: no session ids,
process list, paths or env. Fail-open by contract: without psutil the route answers
``{"ok": false}``, and an unreadable registry just omits ``clients``.

The dashboard loader imports this file as a top-level module, so it stays self-contained.
"""

from __future__ import annotations

import logging
import os
import platform
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


if router is not None:

    @router.get("/stats")
    def stats() -> dict[str, Any]:
        body = collect_stats()
        if body["ok"]:
            from hermes_cli.active_sessions import active_session_registry_snapshot

            try:
                body["clients"] = count_clients(active_session_registry_snapshot())
            except (RuntimeError, OSError) as exc:  # ActiveSessionRegistryError is a RuntimeError
                logger.debug("server-load: session registry unreadable: %s", exc)
        return body
