"""Backend half: shape of /stats, and (when a Hermes checkout is given) the route on a real FastAPI app.

Plain unittest, no Hermes needed for the unit tests:
    python -m unittest discover -s test -p "test_*.py"
End-to-end with the real psutil and FastAPI from the Hermes environment:
    HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
SRC = os.environ.get("HERMES_AGENT_SRC")


def load_plugin_api():
    # Same way the dashboard loads it: a standalone module from its file path.
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_server_load", ROOT / "dashboard/plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakePsutil:
    def __init__(self, loadavg=True):
        if loadavg:
            self.getloadavg = lambda: (1.234, 0.5, 0.25)

    def virtual_memory(self):
        return SimpleNamespace(total=1000, available=250, percent=75.0)

    def cpu_percent(self, interval=None):
        assert interval is None, "the route must not block a worker thread"
        return 42.0


class CollectStats(unittest.TestCase):
    def test_only_load_figures_and_hostname_leave_the_process(self):
        stats = load_plugin_api().collect_stats(FakePsutil())

        self.assertEqual(set(stats), {"ok", "hostname", "cpu_percent", "cpu_count", "memory", "load_avg"})
        self.assertEqual(stats["cpu_percent"], 42.0)
        self.assertEqual(stats["memory"], {"total": 1000, "used": 750, "percent": 75.0})
        self.assertEqual(stats["load_avg"], [1.23, 0.5, 0.25])

    def test_a_host_without_load_average_omits_it(self):
        self.assertNotIn("load_avg", load_plugin_api().collect_stats(FakePsutil(loadavg=False)))

    def test_without_psutil_the_route_fails_open(self):
        self.assertEqual(load_plugin_api().collect_stats(None), {"ok": False})


class CountClients(unittest.TestCase):
    def test_only_per_surface_counts_leave_the_process(self):
        counts = load_plugin_api().count_clients([
            {"session_id": "s1", "surface": "desktop", "pid": 1, "lease_id": "a"},
            {"session_id": "s2", "surface": "bighelp", "metadata": {"user_id": "u"}},
            {"session_id": "s3", "surface": "desktop"},
            {"session_id": "s4"},
        ])

        self.assertEqual(counts, {"total": 4, "by_surface": {"bighelp": 1, "desktop": 2, "unknown": 1}})


@unittest.skipUnless(SRC, "set HERMES_AGENT_SRC to run with the Hermes environment")
class RealRoute(unittest.TestCase):
    # Temp HERMES_HOME: the route reads (and prunes) the session registry of the current home.
    def setUp(self):
        if SRC not in sys.path:
            sys.path.insert(0, SRC)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = home.name
        self.addCleanup(lambda: os.environ.__setitem__("HERMES_HOME", previous) if previous is not None
                        else os.environ.pop("HERMES_HOME", None))

    def get_stats(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(load_plugin_api().router, prefix="/api/plugins/server-load")
        return TestClient(app).get("/api/plugins/server-load/stats").json()

    def test_the_mounted_route_reports_this_machine(self):
        body = self.get_stats()

        self.assertTrue(body["ok"])
        self.assertGreater(body["memory"]["total"], 0)
        self.assertTrue(0 <= body["cpu_percent"] <= 100)
        self.assertEqual(body["clients"], {"total": 0, "by_surface": {}})

    def test_a_session_held_by_a_client_is_counted_under_its_source(self):
        from hermes_cli.active_sessions import release_active_session, try_acquire_active_session

        lease, refusal = try_acquire_active_session(session_id="sess-1", surface="mobile", config={})
        self.assertIsNone(refusal)
        self.addCleanup(release_active_session, lease)

        self.assertEqual(self.get_stats()["clients"], {"total": 1, "by_surface": {"mobile": 1}})


if __name__ == "__main__":
    unittest.main()
