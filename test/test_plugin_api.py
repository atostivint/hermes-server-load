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
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SRC = os.environ.get("HERMES_AGENT_SRC")


def load_plugin_api():
    # Same way the dashboard loads it: a standalone module from its file path.
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes_vitals_light", ROOT / "dashboard/plugin_api.py")
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


class FakeStatus:
    """A local HTTP server answering ``/api/status`` like Hermes does, and counting the asks."""

    def __init__(self, body=b'{"active_sessions": 3, "version": "x"}'):
        self.hits = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.hits += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/api/status"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class StatusUrl(unittest.TestCase):
    def test_it_is_the_socket_the_request_arrived_on_not_the_host_header(self):
        status_url = load_plugin_api().status_url

        self.assertEqual(status_url({"server": ("127.0.0.1", 9119), "scheme": "http"}), "http://127.0.0.1:9119/api/status")
        self.assertEqual(status_url({"server": ("0.0.0.0", 9119), "scheme": "http"}), "http://127.0.0.1:9119/api/status")
        self.assertEqual(status_url({"server": ("::", 9119), "scheme": "http"}), "http://[::1]:9119/api/status")
        self.assertEqual(status_url({"server": ("10.0.0.5", 443), "scheme": "https"}), "https://10.0.0.5:443/api/status")

    def test_no_tcp_address_means_nothing_to_ask(self):
        status_url = load_plugin_api().status_url

        self.assertIsNone(status_url({"server": ("/run/hermes.sock", None)}))
        self.assertIsNone(status_url({}))


class ActiveSessions(unittest.TestCase):
    def test_it_reads_the_count_from_status_even_with_a_proxy_configured(self):
        with FakeStatus() as status, mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1"}):
            self.assertEqual(load_plugin_api().active_sessions(status.url), 3)

    def test_the_answer_is_cached_for_the_ttl(self):
        api = load_plugin_api()
        now = [100.0]

        with FakeStatus() as status:
            self.assertEqual(api.active_sessions(status.url, clock=lambda: now[0]), 3)
            now[0] += api.STATUS_TTL - 1
            self.assertEqual(api.active_sessions(status.url, clock=lambda: now[0]), 3)
            self.assertEqual(status.hits, 1)
            now[0] += 2
            api.active_sessions(status.url, clock=lambda: now[0])
            self.assertEqual(status.hits, 2)

    def test_an_unreachable_server_is_none_and_is_not_asked_again_within_the_ttl(self):
        api = load_plugin_api()

        with mock.patch.object(api._no_proxy, "open", side_effect=OSError("refused")) as opened:
            self.assertIsNone(api.active_sessions("http://127.0.0.1:1/api/status", clock=lambda: 100.0))
            self.assertIsNone(api.active_sessions("http://127.0.0.1:1/api/status", clock=lambda: 101.0))
            self.assertEqual(opened.call_count, 1)

    def test_an_answer_that_is_not_a_count_is_none(self):
        for body in (b"[]", b"not json", b'{"active_sessions": "3"}', b'{"active_sessions": true}', b"{}"):
            with FakeStatus(body) as status:
                self.assertIsNone(load_plugin_api().active_sessions(status.url), body)


class SnapshotClients(unittest.TestCase):
    def snapshot(self, **kwargs):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        return api.snapshot(processes=False, **kwargs)

    def test_the_count_is_a_bare_total(self):
        with FakeStatus() as status:
            self.assertEqual(self.snapshot(url=status.url)["clients"], {"total": 3})

    def test_a_count_switched_off_is_never_asked(self):
        with FakeStatus() as status:
            self.assertNotIn("clients", self.snapshot(clients=False, url=status.url))
            self.assertEqual(status.hits, 0)

    def test_without_a_server_or_an_answer_the_count_is_left_out(self):
        self.assertNotIn("clients", self.snapshot())
        with FakeStatus(b"{}") as status:
            self.assertNotIn("clients", self.snapshot(url=status.url))


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

    def run_stream(self, ticks, skip=frozenset()):
        import io
        import json

        api = load_plugin_api()
        calls = []

        def snapshot(clients=True, processes=True):
            calls.append((clients, processes) if skip else processes)
            return {"ok": True, "n": len(calls)}

        class Out(io.StringIO):
            def flush(self):
                if len(calls) >= ticks:
                    self.lines = [json.loads(line) for line in self.getvalue().splitlines()]
                    self.close()  # the reader goes away: the next write ends the stream

        out = Out()
        api.snapshot = snapshot
        with mock.patch("time.sleep"):
            api.stream(interval=3, out=out, skip=skip)
        return calls, out.lines

    def test_lines_until_the_reader_goes_away_and_the_first_skips_processes(self):
        calls, lines = self.run_stream(ticks=3)

        self.assertEqual(lines, [{"ok": True, "n": 1}, {"ok": True, "n": 2}, {"ok": True, "n": 3}])
        self.assertEqual(calls[:3], [False, True, True])

    def test_a_skipped_count_is_never_measured(self):
        calls, _ = self.run_stream(ticks=3, skip=frozenset({"processes"}))

        self.assertEqual(calls[:3], [(True, False)] * 3)

    def test_snapshot_without_processes_skips_the_scan(self):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}
        api.psutil = mock.Mock()
        api.psutil.process_iter.return_value = []

        self.assertNotIn("processes", api.snapshot(processes=False))
        api.psutil.process_iter.assert_not_called()
        self.assertEqual(api.snapshot()["processes"], {"total": 0, "by_command": {}})

    def test_the_feed_has_no_server_so_no_session_count(self):
        api = load_plugin_api()
        api.collect_stats = lambda: {"ok": True}

        self.assertEqual(api.snapshot(clients=True, processes=False), {"ok": True})

    def test_skip_keeps_only_known_counts(self):
        parse = load_plugin_api().parse_skip

        self.assertEqual(parse("clients, processes"), {"clients", "processes"})
        self.assertEqual(parse("cpu,ram,bogus"), frozenset(), "the load figures are always measured")
        self.assertEqual(parse(None), frozenset())


@unittest.skipUnless(SRC, "set HERMES_AGENT_SRC to run with the Hermes environment")
class RealRoute(unittest.TestCase):
    # Temp HERMES_HOME, so nothing here touches the real one.
    def setUp(self):
        if SRC not in sys.path:
            sys.path.insert(0, SRC)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = home.name
        self.addCleanup(lambda: os.environ.__setitem__("HERMES_HOME", previous) if previous is not None
                        else os.environ.pop("HERMES_HOME", None))

    def get_stats(self, query="", base_url="http://testserver"):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(load_plugin_api().router, prefix="/api/plugins/hermes-vitals-light")
        return TestClient(app, base_url=base_url).get("/api/plugins/hermes-vitals-light/stats" + query).json()

    def test_skip_leaves_the_counts_out(self):
        body = self.get_stats("?skip=clients,processes")

        self.assertTrue(body["ok"])
        self.assertNotIn("clients", body)
        self.assertNotIn("processes", body)
        self.assertIn("processes", self.get_stats("?skip=clients"))

    def test_the_mounted_route_reports_this_machine(self):
        body = self.get_stats()

        self.assertTrue(body["ok"])
        self.assertGreater(body["memory"]["total"], 0)
        self.assertTrue(0 <= body["cpu_percent"] <= 100)
        self.assertEqual(body["processes"]["total"], sum(body["processes"]["by_command"].values()))

    def test_the_route_asks_the_server_it_runs_in_for_the_session_count(self):
        # The test client's server address is the fake status server's: what a real request would carry.
        with FakeStatus() as status:
            body = self.get_stats(base_url=f"http://127.0.0.1:{status.port}")

            self.assertEqual(body["clients"], {"total": 3})
            self.assertEqual(status.hits, 1)
            self.assertNotIn("clients", self.get_stats("?skip=clients", base_url=f"http://127.0.0.1:{status.port}"))


if __name__ == "__main__":
    unittest.main()
