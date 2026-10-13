"""server-load backend, mounted at ``/api/plugins/server-load/``.

One read-only route, ``GET /stats``: CPU and memory of the machine running the Hermes backend the
Desktop is connected to (``hermes serve`` runs this file in-process, so a remote gateway reports
the remote box, not the Desktop's).

Only load figures and the hostname leave this process: no process list, paths or env.
Fail-open by contract: without psutil the route answers ``{"ok": false}``, never an error.

The dashboard loader imports this file as a top-level module, so it stays self-contained.
"""

from __future__ import annotations

import os
import platform
from typing import Any

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


if router is not None:

    @router.get("/stats")
    def stats() -> dict[str, Any]:
        return collect_stats()
