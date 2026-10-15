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
from unittest import mock

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


class HermesCommand(unittest.TestCase):
    def test_console_scripts_modules_and_shims_are_recognised(self):
        command = load_plugin_api().hermes_command
        cases = {
            ("/home/u/.local/bin/hermes", "serve", "--port", "9119"): "serve",
            ("hermes", "-p", "work", "gateway", "run"): "gateway",
            ("hermes",): "chat",
            (r"C:\Users\u\AppData\Local\hermes\venv\Scripts\hermes.exe", "--profile", "x"): "chat",
            ("/usr/bin/python3.12", "-u", "-m", "hermes_cli.main", "dashboard"): "dashboard",
            ("python3", "-X", "utf8", "/opt/hermes/bin/hermes", "chat"): "chat",
            (r"C:\venv\Scripts\python.exe", r"C:\venv\Scripts\hermes.exe", "serve"): "serve",
            ("hermes-acp",): "acp",
            ("python", "-m", "tui_gateway.entry"): "tui",
        }
        for argv, expected in cases.items():
            self.assertEqual(command(list(argv)), expected, argv)

    def test_the_desktop_and_unrelated_processes_are_not_hermes(self):
        command = load_plugin_api().hermes_command
        for argv in (
            [r"C:\Users\u\AppData\Local\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe"],
            ["/Applications/Hermes.app/Contents/MacOS/Hermes", "--type=renderer"],
            ["python3", "onenote_mcp_server.py"],
            ["python3", "-m", "http.server"],
            ["vim", "hermes.py"],
            [],
            None,
        ):
            self.assertIsNone(command(argv), argv)


class CountHermesProcesses(unittest.TestCase):
    def test_a_hermes_started_by_another_counts_under_its_top_level_ancestor(self):
        counts = load_plugin_api().count_hermes_processes([
            {"pid": 1, "ppid": 0, "cmdline": ["/sbin/init"]},
            {"pid": 10, "ppid": 1, "cmdline": ["hermes", "serve"]},
            # Windows launcher and its python child: one executable.
            {"pid": 20, "ppid": 1, "cmdline": ["hermes.exe", "chat"]},
            {"pid": 21, "ppid": 20, "cmdline": ["python.exe", "hermes.exe", "chat"]},
            # The TUI: hermes chat -> node -> tui_gateway.
            {"pid": 30, "ppid": 1, "cmdline": ["hermes", "--tui"]},
            {"pid": 31, "ppid": 30, "cmdline": ["node", "ui-tui/dist/entry.js"]},
            {"pid": 32, "ppid": 31, "cmdline": ["python", "-m", "tui_gateway.entry"]},
            {"pid": 40, "ppid": 99, "cmdline": ["hermes", "chat"]},  # parent already gone
            {"pid": 50, "ppid": 1, "cmdline": None},  # AccessDenied
            {"pid": 60, "ppid": 1, "cmdline": ["Hermes.exe"]},
        ])

        self.assertEqual(counts, {"total": 4, "by_command": {"chat": 3, "serve": 1}})

    def test_a_ppid_cycle_does_not_hang(self):
        counts = load_plugin_api().count_hermes_processes([
            {"pid": 1, "ppid": 2, "cmdline": ["bash"]},
            {"pid": 2, "ppid": 1, "cmdline": ["hermes", "serve"]},
        ])

        self.assertEqual(counts, {"total": 1, "by_command": {"serve": 1}})


class Stream(unittest.TestCase):
    """The TUI feed: one snapshot JSON line per tick, the first one without the slow process scan."""

    def run_stream(self, ticks):
        import io
        import json

        api = load_plugin_api()
        calls = []

        def snapshot(processes=True):
            calls.append(processes)
            return {"ok": True, "n": len(calls)}

        class Out(io.StringIO):
            def flush(self):
                if len(calls) >= ticks:
                    self.lines = [json.loads(line) for line in self.getvalue().splitlines()]
                    self.close()  # the reader goes away: the next write ends the stream

        out = Out()
        api.snapshot = snapshot
        with mock.patch("time.sleep"):
            api.stream(interval=3, out=out)
        return calls, out.lines

    def test_lines_until_the_reader_goes_away_and_the_first_skips_processes(self):
        calls, lines = self.run_stream(ticks=3)

        self.assertEqual(lines, [{"ok": True, "n": 1}, {"ok": True, "n": 2}, {"ok": True, "n": 3}])
        self.assertEqual(calls[:3], [False, True, True])

    def test_snapshot_without_processes_skips_the_scan(self):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        api.psutil = mock.Mock()
        api.psutil.process_iter.return_value = []

        self.assertNotIn("processes", api.snapshot(processes=False))
        api.psutil.process_iter.assert_not_called()
        self.assertEqual(api.snapshot()["processes"], {"total": 0, "by_command": {}})


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
        self.assertEqual(body["processes"]["total"], sum(body["processes"]["by_command"].values()))

    def test_a_session_held_by_a_client_is_counted_under_its_source(self):
        from hermes_cli.active_sessions import release_active_session, try_acquire_active_session

        lease, refusal = try_acquire_active_session(session_id="sess-1", surface="mobile", config={})
        self.assertIsNone(refusal)
        self.addCleanup(release_active_session, lease)

        self.assertEqual(self.get_stats()["clients"], {"total": 1, "by_surface": {"mobile": 1}})


if __name__ == "__main__":
    unittest.main()
