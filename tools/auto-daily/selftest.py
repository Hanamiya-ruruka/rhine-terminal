"""Offline acceptance/regression tests; all HTTP is intercepted in memory."""
from contextlib import redirect_stdout
from datetime import datetime, timedelta
import io
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse

import auto_daily as app
import steam_playtime as steam


class Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.value, ensure_ascii=False).encode("utf-8")


class FakeHTTP:
    def __init__(self, state_path, key):
        self.state_path = state_path
        self.state = {"lastDailyKey": key, "games": [
            {"id": "test-game-" + str(i), "name": name, "daily": False,
             "weekly": bool(i % 2), "cardLeft": 17, "versionEndDate": "2026-12-01"}
            for i, name in enumerate(app.RULES)]}
        self.online = True
        self.auth = None
        self.calls = []
        self.writes = []
        self.drop_after_write = False
        self.fail_before_apply = False
        self.false_readback = False
        self.save()

    def save(self):
        self.state_path.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")

    def set_daily(self, value):
        self.state["games"][0]["daily"] = value
        self.save()

    def open(self, request, timeout):
        payload = json.loads(request.data.decode("utf-8"))
        assert request.get_method() == "POST"
        assert urllib.parse.urlsplit(request.full_url).path.endswith("/api/assistant/command")
        assert request.get_header("X-desktop-token")
        assert payload.get("requestId")
        self.calls.append(payload)
        if self.auth:
            raise urllib.error.HTTPError(request.full_url, self.auth, "denied", {}, None)
        if not self.online:
            raise urllib.error.URLError("offline")
        if payload["action"] == "list":
            return Response({"ok": True, "day": self.state["lastDailyKey"],
                             "games": json.loads(json.dumps(self.state["games"]))})
        assert payload["action"] == "set_completion"
        assert set(payload) == {"requestId", "action", "gameId", "field", "done"}
        assert payload["field"] == "daily" and payload["done"] is True
        self.writes.append(payload)
        if self.fail_before_apply:
            raise urllib.error.URLError("unknown outcome")
        for game in self.state["games"]:
            if game["id"] == payload["gameId"]:
                if not self.false_readback:
                    game["daily"] = True
                self.save()
                if self.drop_after_write:
                    self.online = False
                    raise urllib.error.URLError("reply lost after apply")
                return Response({"ok": True})
        return Response({"ok": False, "code": "game_not_found"})


class FakeWin32:
    """Exercise the real ctypes collector with deterministic per-process failures."""
    def __init__(self, rows):
        self.rows = rows
        self.index = 0
        self.closed = []
        self.opened = {}

    def CreateToolhelp32Snapshot(self, flags, pid):
        assert (flags, pid) == (app.TH32CS_SNAPPROCESS, 0)
        return 90000

    def _entry(self, pointer):
        if self.index >= len(self.rows):
            app.ctypes.set_last_error(app.ERROR_NO_MORE_FILES)
            return False
        entry = pointer._obj
        assert entry.dwSize == app.ctypes.sizeof(app.PROCESSENTRY32W)
        row = self.rows[self.index]
        entry.th32ProcessID, entry.szExeFile = row["pid"], row["name"]
        return True

    def Process32FirstW(self, snapshot, entry):
        self.index = 0
        return self._entry(entry)

    def Process32NextW(self, snapshot, entry):
        self.index += 1
        return self._entry(entry)

    def OpenProcess(self, access, inherit, pid):
        assert (access, inherit) == (app.PROCESS_QUERY_LIMITED_INFORMATION, False)
        row = self.rows[self.index]
        if row.get("open") == "raise":
            raise OSError("OpenProcess access denied")
        if row.get("open") is False:
            return None
        self.opened[pid + 100000] = row
        return pid + 100000

    def QueryFullProcessImageNameW(self, handle, flags, buffer, size):
        row = self.opened[handle]
        if row.get("path_error") == "raise":
            raise OSError("Path access denied")
        if row.get("path_error") == "fail":
            return False
        buffer.value = row.get("path", "")
        size._obj.value = len(buffer.value)
        return True

    def GetProcessTimes(self, handle, creation, *_):
        row = self.opened[handle]
        if row.get("time_error") == "raise":
            raise OSError("Creation time access denied")
        if row.get("time_error") == "fail":
            return False
        ticks = row.get("ticks", 134067744000000001)
        creation._obj.dwHighDateTime = ticks >> 32
        creation._obj.dwLowDateTime = ticks & 0xffffffff
        return True

    def CloseHandle(self, handle):
        self.closed.append(handle)
        return True


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.enterContext(redirect_stdout(io.StringIO()))
        self.temp = tempfile.TemporaryDirectory(prefix=".selftest-", dir=app.ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime(2026, 11, 6, 12, tzinfo=app.JST)
        self.state_path = self.root / "helper-state.json"
        self.fake = FakeHTTP(self.state_path, app.day_key(self.now))
        # An OS-assigned ephemeral port exercises dynamic discovery; no server is used.
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.connection = self.root / "active-window.txt"
        self.connection.write_text(
            f"http://127.0.0.1:{port}/{secrets.token_hex(16)}/", encoding="utf-8-sig")
        self.api = app.HelperHTTP(self.connection, self.fake, endpoint_file=None)
        self.store = app.Store(self.root)
        self.engine = app.Engine(self.store, self.api, self.state_path, lambda: self.now)
        self.game = next(iter(app.RULES))
        self.exe = app.RULES[self.game][0] + "ZenlessZoneZero.exe"

    def session(self, seconds=121, start=None):
        start = start or self.now - timedelta(seconds=seconds)
        return self.engine.session(self.game, self.exe, start,
                                   start + timedelta(seconds=seconds), seconds)

    def test_01_119_seconds_skipped(self):
        row = self.session(119)
        self.assertEqual(row["action"], "skipped")
        self.assertEqual(self.fake.writes, [])

    def test_02_121_seconds_marked_and_readback(self):
        before = json.loads(json.dumps(self.fake.state))
        row = self.session()
        self.assertEqual((row["action"], row["readback"]), ("marked", True))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual([c["action"] for c in self.fake.calls],
                         ["list", "set_completion", "list"])
        before["games"][0]["daily"] = True
        self.assertEqual(self.fake.state, before, "Only daily may change")

    def test_03_already_true_never_writes(self):
        self.fake.set_daily(True)
        row = self.session()
        self.assertEqual((row["action"], row["readback"]), ("skipped", True))
        self.assertEqual(self.fake.writes, [])

    def test_04_cross_reset_uses_start_day(self):
        start = datetime(2026, 11, 6, 4, 58, tzinfo=app.JST)
        self.now = start + timedelta(seconds=121)
        row = self.session(start=start)
        self.assertEqual(row["day_key"], "2026-11-05")
        self.assertEqual(row["reason"], "start_day_expired")
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(app.day_key(self.now), "2026-11-06")

    def test_05_offline_queue_survives_restart_and_replays(self):
        self.fake.online = False
        row = self.session()
        self.assertEqual(row["action"], "queued")
        self.assertEqual(self.fake.writes, [])
        self.store = app.Store(self.root)
        self.engine = app.Engine(self.store, self.api, self.state_path, lambda: self.now)
        self.fake.online = True
        captured = io.StringIO()
        with redirect_stdout(captured):
            self.engine.flush()
        row = self.store.data["sessions"][0]
        self.assertEqual((row["action"], row["readback"], row["replayed"]),
                         ("marked", True, True))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertIn('"count": 1', captured.getvalue())
        lines = (self.root / "logs" / "auto_daily.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1, "Replay updates the same session line")
        self.assertEqual(json.loads(lines[0])["action"], "marked")
        self.engine.flush()
        self.assertEqual(len(self.fake.writes), 1)

    def test_06_manual_true_false_blocks_for_day(self):
        self.fake.set_daily(True)
        self.engine.observe_disk()
        self.fake.set_daily(False)
        self.engine.observe_disk()
        store = app.Store(self.root)
        self.engine = app.Engine(store, self.api, self.state_path, lambda: self.now)
        row = self.session()
        self.assertEqual(row["reason"], "manual_cancel_detected")
        self.assertEqual(self.fake.writes, [])

    def test_07_launchers_never_start_sessions(self):
        launchers = [p for _, blocked in app.RULES.values() for p in blocked]
        raw = json.dumps([{"pid": i, "born": "born", "path": path}
                          for i, path in enumerate(launchers)], ensure_ascii=False).encode("utf-8")
        processes = app.parse_processes(raw)
        self.assertEqual(processes, {})
        tracker = app.Tracker(self.engine, 30)
        tracker.poll(processes, self.now, 0)
        tracker.poll(processes, self.now + timedelta(seconds=121), 121)
        tracker.poll({}, self.now + timedelta(seconds=182), 182)
        self.assertEqual(self.store.data["sessions"], [])

    def test_08_auth_stops_once_and_persists(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.store.data["auth_stopped"] = False
                self.fake.auth = status
                captured = io.StringIO()
                with redirect_stdout(captured):
                    row = self.session()
                    calls = len(self.fake.calls)
                    self.session()
                    self.engine.flush()
                self.assertEqual(row["action"], "failed")
                self.assertEqual(len(self.fake.calls), calls)
                self.assertEqual(captured.getvalue().count('"authorization_stopped"'), 1)
                self.assertTrue(app.Store(self.root).data["auth_stopped"])

    def test_09_unknown_write_only_reads_never_reposts(self):
        for applied in (True, False):
            with self.subTest(applied=applied):
                self.store.data["ledger"] = {}
                self.fake.set_daily(False)
                self.fake.online = True
                self.fake.drop_after_write = applied
                self.fake.fail_before_apply = not applied
                count = len(self.fake.writes)
                row = self.session()
                self.assertEqual(row["action"], "queued")
                self.fake.online = True
                captured = io.StringIO()
                with redirect_stdout(captured):
                    self.engine.flush()
                self.assertEqual(row["action"], "marked" if applied else "failed")
                self.engine.flush()
                self.assertEqual(len(self.fake.writes), count + 1)

    def test_10_dynamic_ids_and_non_daily_fields_unchanged(self):
        self.fake.state["games"][0]["id"] = "replacement-id"
        self.fake.save()
        row = self.session()
        self.assertEqual(row["action"], "marked")
        self.assertEqual(self.fake.writes[0]["gameId"], "replacement-id")

    def test_11_pid_restart_and_scan_gap_do_not_accumulate(self):
        tracker = app.Tracker(self.engine, 30)
        first = (123, "first", self.exe)
        second = (123, "second", self.exe)
        for tick in range(0, 111, 5):
            tracker.poll({first: (self.game, self.exe)}, self.now + timedelta(seconds=tick), tick)
        tracker.poll({second: (self.game, self.exe)}, self.now + timedelta(seconds=115), 115)
        tracker.poll({}, self.now + timedelta(seconds=120), 120)
        self.assertEqual(len(self.store.data["sessions"]), 2)
        self.assertEqual(self.fake.writes, [])
        tracker.poll({first: (self.game, self.exe)}, self.now, 200)
        tracker.poll({first: (self.game, self.exe)}, self.now + timedelta(seconds=121), 321)
        self.assertEqual(self.store.data["sessions"][-1]["reason"], "monitoring_gap")
        self.assertEqual(self.fake.writes, [])

    def test_12_utf8_spaces_prefix_boundary_and_exact_threshold(self):
        path = app.RULES["异象回声"][0] + "中文 子目录\\Echoes of Vision.exe"
        raw = json.dumps([{"pid": 1, "born": "first", "path": path}],
                         ensure_ascii=False).encode("utf-8")
        self.assertEqual(next(iter(app.parse_processes(raw).values())), ("异象回声", path))
        self.assertEqual(app.match_game(self.exe.upper()), self.game)
        self.assertIsNone(app.match_game(app.RULES[self.game][0].rstrip("\\") + "Fake\\a.exe"))
        self.assertIsNone(app.match_game("ZenlessZoneZero.exe"))
        tracker = app.Tracker(self.engine, 30)
        identity = (1, "first", self.exe)
        for tick in range(0, 121, 5):
            tracker.poll({identity: (self.game, self.exe)}, self.now + timedelta(seconds=tick), tick)
        self.assertEqual(self.fake.writes, [], "Must wait for exit")
        tracker.poll({}, self.now + timedelta(seconds=125), 125)
        self.assertEqual(self.store.data["sessions"][-1]["duration_s"], 120)
        self.assertEqual(self.store.data["sessions"][-1]["action"], "marked")

    def test_13_missing_connection_queues_and_recovers(self):
        address = self.connection.read_text(encoding="utf-8-sig")
        self.connection.unlink()
        row = self.session()
        self.assertEqual(row["action"], "queued")
        self.assertEqual(self.fake.calls, [])
        self.connection.write_text(address, encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            self.engine.flush()
        self.assertEqual(row["action"], "marked")

    def test_14_next_day_reset_is_not_manual_cancellation(self):
        self.fake.set_daily(True)
        self.engine.observe_disk()
        self.now += timedelta(days=1)
        self.fake.state["lastDailyKey"] = app.day_key(self.now)
        self.fake.set_daily(False)
        self.engine.observe_disk()
        row = self.session()
        self.assertEqual(row["action"], "marked")

    def test_15_mark_cancel_new_session_never_rewrites(self):
        self.session()
        self.fake.set_daily(False)
        row = self.session()
        self.assertEqual(row["reason"], "manual_cancel_detected")
        self.assertEqual(len(self.fake.writes), 1)

    def test_16_reset_guard_and_stale_queue_never_mark_new_day(self):
        self.now = self.now.replace(hour=4, minute=59, second=30)
        self.fake.state["lastDailyKey"] = app.day_key(self.now)
        self.fake.save()
        row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("queued", "reset_guard"))
        self.now += timedelta(minutes=1)
        self.fake.state["lastDailyKey"] = app.day_key(self.now)
        self.fake.save()
        self.engine.flush()
        self.assertEqual(row["reason"], "start_day_expired")
        self.assertEqual(self.fake.writes, [])

    def test_17_false_readback_is_failed_and_not_retried(self):
        self.fake.false_readback = True
        row = self.session()
        self.assertEqual((row["action"], row["readback"]), ("failed", False))
        self.session()
        self.assertEqual(len(self.fake.writes), 1)

    def test_18_unreadable_path_is_not_process_exit(self):
        tracker = app.Tracker(self.engine, 30)
        def snapshot(path, born="first"):
            return app.parse_processes(json.dumps([
                {"pid": 1, "born": born, "path": path}], ensure_ascii=False).encode("utf-8"))
        for tick in range(0, 121, 5):
            tracker.poll(snapshot(self.exe), self.now + timedelta(seconds=tick), tick)
        tracker.poll(snapshot(""), self.now + timedelta(seconds=125), 125)
        row = self.store.data["sessions"][0]
        self.assertEqual(row["action"], "skipped")
        self.assertEqual(row["reason"], "process_identity_changed_or_path_unavailable")
        self.assertEqual(self.fake.writes, [])

    def processes(self, path, name="ZenlessZoneZero.exe", born="first", pid=9936):
        return app.parse_processes(json.dumps([
            {"pid": pid, "name": name, "born": born, "path": path}
        ], ensure_ascii=False).encode("utf-8"))

    def poll_at(self, tracker, processes, tick):
        tracker.poll(processes, self.now + timedelta(seconds=tick), tick)

    def match_events(self):
        return [json.loads(line) for line in
                (self.root / "logs" / "events.jsonl").read_text(encoding="utf-8").splitlines()
                if json.loads(line)["event"] == "process_match"]

    def test_19_A_empty_path_name_fallback_marks_after_120_and_exit(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(""), tick)
        self.assertEqual(len(tracker.active), 1)
        self.assertEqual(self.store.data["sessions"], [], "Still playing; no session end")
        self.assertEqual(self.fake.writes, [])
        self.poll_at(tracker, self.processes("", name="unrelated.exe", pid=1234), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["readback"]), (120, "marked", True))
        self.assertEqual((row["match"], row["exe_path"]), ("name_fallback", ""))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual([e["match"] for e in self.match_events()], ["name_fallback"])
        logged, = (self.root / "logs" / "auto_daily.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(logged)["match"], "name_fallback")

    def test_20_B_missing_path_launcher_names_never_start(self):
        tracker = app.Tracker(self.engine, 30)
        for name in ("launcher.exe", "HoYoPlay.exe"):
            for path in ("", None):
                with self.subTest(name=name, path=path):
                    snapshot = self.processes(path, name=name.swapcase())
                    self.assertEqual(snapshot, {})
                    self.assertIn(9936, snapshot.present_pids)
                    self.poll_at(tracker, snapshot, 0)
                    self.poll_at(tracker, snapshot, 120)
        self.poll_at(tracker, {}, 125)
        self.assertEqual(tracker.active, {})
        self.assertEqual(self.store.data["sessions"], [])
        self.assertEqual(self.fake.writes, [])

    def test_21_C_path_visibility_changes_never_end_live_session(self):
        tracker = app.Tracker(self.engine, 30)
        initial = self.processes(self.exe)
        identity, = initial
        for tick in range(0, 241, 5):
            path = self.exe if tick < 60 or tick >= 200 else (None if tick % 10 else "")
            snapshot = self.processes(path, name="ZENLESSZONEZERO.EXE")
            self.assertEqual(list(snapshot), [identity], "Identity must not depend on path")
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(self.store.data["sessions"], [], "Unreadable path is not session end")
            self.assertEqual(tracker.active[identity].last_tick, tick)
        self.poll_at(tracker, {}, 245)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (240, "marked"))
        self.assertEqual([e["match"] for e in self.match_events()],
                         ["path", "name_fallback", "path"])
        self.assertEqual(row["match"], "path")

    def test_22_D_readable_blacklisted_launchers_never_start(self):
        tracker = app.Tracker(self.engine, 30)
        paths = [p for _, blocked in app.RULES.values() for p in blocked]
        paths += [app.RULES[self.game][0] + name for name in
                  ("launcher.exe", "HoYoPlay.exe")]
        for path in paths:
            with self.subTest(path=path):
                self.assertIsNone(app.match_game(path))
                # Even a whitelisted reported name cannot override a readable blacklist.
                snapshot = self.processes(path)
                self.assertEqual(snapshot, {})
                self.poll_at(tracker, snapshot, 0)
        self.poll_at(tracker, {}, 5)
        self.assertEqual(self.store.data["sessions"], [])
        self.assertEqual(self.fake.writes, [])

    def test_23_E_readable_paths_select_only_configured_installation(self):
        tracker = app.Tracker(self.engine, 30)
        rows = [
            {"pid": 10, "born": "first", "name": "ZenlessZoneZero.exe", "path": self.exe},
            {"pid": 20, "born": "second", "name": "ZenlessZoneZero.exe",
             "path": r"E:\Other Install\ZenlessZoneZero.exe"},
        ]
        snapshot = app.parse_processes(json.dumps(rows).encode("utf-8"))
        self.assertEqual([identity[0] for identity in snapshot], [10])
        for tick in range(0, 121, 5):
            self.poll_at(tracker, snapshot, tick)
        self.poll_at(tracker, app.parse_processes(json.dumps(rows[1:]).encode("utf-8")), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["exe_path"], row["match"], row["action"]),
                         (self.exe, "path", "marked"))
        self.assertEqual(tracker.active, {})
        self.assertEqual(len(self.fake.writes), 1)

    def test_24_fallback_is_exact_case_insensitive_whitelist_only(self):
        for name in ("zenlesszonezero.exe", "ZENLESSZONEZERO.EXE", "ZenlessZoneZero.exe"):
            for path in ("", None):
                with self.subTest(name=name, path=path):
                    snapshot = self.processes(path, name=name)
                    self.assertEqual(list(snapshot.values()), [(self.game, "")])
                    self.assertEqual(list(snapshot.matches.values()), ["name_fallback"])
        for name in ("ZenlessZoneZero", "ZenlessZoneZero.exe.bak", "FakeZenlessZoneZero.exe",
                     " ZenlessZoneZero.exe", "ZenlessZoneZero.exe ",
                     r"D:\Fake\ZenlessZoneZero.exe", "StarSavior.exe", "", None):
            with self.subTest(name=name):
                self.assertEqual(self.processes(None, name=name), {})

    def test_25_fallback_pid_reuse_does_not_join_sessions(self):
        tracker = app.Tracker(self.engine, 30)
        first, = self.processes(None, born="first")
        second, = self.processes(None, born="second")
        self.assertNotEqual(first, second)
        for tick in range(0, 111, 5):
            self.poll_at(tracker, self.processes(None, born="first"), tick)
        self.poll_at(tracker, self.processes(None, born="second"), 115)
        self.assertEqual(list(tracker.active), [second])
        self.poll_at(tracker, self.processes(None, born="second"), 120)
        self.poll_at(tracker, {}, 125)
        self.assertEqual([r["duration_s"] for r in self.store.data["sessions"]], [110, 5])
        self.assertEqual(self.fake.writes, [])

    def test_26_missing_creation_time_never_writes_or_keeps_old_identity(self):
        tracker = app.Tracker(self.engine, 30)
        for born in ("", None):
            self.assertEqual(self.processes(None, born=born), {})
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(None), tick)
        self.poll_at(tracker, self.processes(None, born=None), 125)
        self.poll_at(tracker, {}, 130)
        row, = self.store.data["sessions"]
        self.assertEqual(row["action"], "skipped")
        self.assertEqual(self.fake.writes, [])

    def test_27_previously_path_verified_nonwhitelisted_process_stays_alive(self):
        tracker = app.Tracker(self.engine, 30)
        game = "星救"
        exe = app.RULES[game][0] + "StarSavior.exe"
        self.poll_at(tracker, self.processes(exe, name="StarSavior.exe"), 0)
        identity, = tracker.active
        for tick in range(5, 121, 5):
            snapshot = self.processes(None, name="StarSavior.exe")
            self.assertEqual(snapshot, {}, "Not allowed to START by name")
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(self.store.data["sessions"], [])
            self.assertEqual(tracker.active[identity].last_tick, tick)
        self.poll_at(tracker, {}, 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["game"], row["duration_s"], row["action"]), (game, 120, "marked"))

    def test_28_readable_unmatched_or_invalid_path_never_falls_back(self):
        for path in (r"E:\Other\ZenlessZoneZero.exe", "ZenlessZoneZero.exe", " ", 42, []):
            with self.subTest(path=path):
                self.assertEqual(self.processes(path), {})
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(None), tick)
        self.poll_at(tracker, self.processes(r"E:\Other\ZenlessZoneZero.exe"), 125)
        row, = self.store.data["sessions"]
        self.assertEqual(row["action"], "skipped", "New path evidence must prevent a write")
        self.assertEqual(self.fake.writes, [])

    def test_29_changed_name_with_same_pid_never_continues_session(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(None), tick)
        self.poll_at(tracker, self.processes(None, name="launcher.exe"), 125)
        self.assertEqual(tracker.active, {})
        row, = self.store.data["sessions"]
        self.assertEqual(row["action"], "skipped")
        self.assertEqual(self.fake.writes, [])

    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes collector regression")
    def test_30_path_property_exception_keeps_process_in_snapshot(self):
        # Preserve the old regression through the replacement collector backend.
        api = FakeWin32([{"pid": 9936, "name": "ZenlessZoneZero.exe", "path_error": "raise"}])
        with patch.object(app, "_win32_api", return_value=api):
            snapshot = app.process_snapshot()
        self.assertTrue(snapshot.complete)
        self.assertEqual(api.closed, [109936, 90000])
        self.assertEqual(list(snapshot.values()), [(self.game, "")])
        self.assertEqual(list(snapshot.matches.values()), ["name_fallback"])
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, snapshot, tick)
        self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, {}, 125)
        self.assertEqual(self.store.data["sessions"][0]["action"], "marked")


    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes collector regression")
    def test_31_empty_or_failed_path_retains_pid_and_identity(self):
        for failure in (None, "fail", "raise"):
            with self.subTest(path_failure=failure):
                api = FakeWin32([
                    {"pid": 9936, "name": "ZENLESSZONEZERO.EXE", "path_error": failure},
                    {"pid": 9937, "name": "中文 游戏.exe", "path_error": failure},
                ])
                with patch.object(app, "_win32_api", return_value=api):
                    snapshot = app.process_snapshot()
                self.assertTrue(snapshot.complete)
                self.assertEqual(snapshot.present_pids, {9936, 9937})
                self.assertEqual(list(snapshot.values()), [(self.game, "")])
                self.assertEqual(list(snapshot.matches.values()), ["name_fallback"])
                self.assertEqual({identity[0] for identity in snapshot.unreadable_identities}, {9936, 9937})
                self.assertEqual(api.closed, [109936, 109937, 90000])
        self.assertEqual(app.match_process(None, "ZenlessZoneZero.exe"), ("绝区零", "name_fallback"))

    @unittest.skipUnless(app.os.name == "nt", "Live Windows handle-count regression")
    def test_32_200_real_snapshots_do_not_leak_handles_or_spawn_children(self):
        kernel = app.ctypes.WinDLL("kernel32", use_last_error=True)
        count_handles = kernel.GetProcessHandleCount
        count_handles.argtypes = [app.wintypes.HANDLE, app.ctypes.POINTER(app.wintypes.DWORD)]
        count_handles.restype = app.wintypes.BOOL

        def count():
            value = app.wintypes.DWORD()
            self.assertTrue(count_handles(app.ctypes.c_void_p(-1), app.ctypes.byref(value)))
            return value.value

        # Warm up lazy DLL binding before taking the baseline.
        self.assertTrue(app.process_snapshot().complete)
        with patch("subprocess.Popen", side_effect=AssertionError("Snapshot spawned a child process")):
            before = count()
            for _ in range(200):
                snapshot = app.process_snapshot()
                self.assertTrue(snapshot.complete)
                self.assertIn(app.os.getpid(), snapshot.present_pids)
            after = count()
        self.snapshot_handles = (before, after)
        self.assertEqual(after, before, f"Handle leak after 200 scans: {before} -> {after}")

    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes collector regression")
    def test_33_missing_creation_time_or_open_denied_skips_conservatively(self):
        for failure in ("fail", "raise"):
            api = FakeWin32([
                {"pid": 1, "name": "ZenlessZoneZero.exe", "path": self.exe, "time_error": failure},
                {"pid": 2, "name": "ZenlessZoneZero.exe", "open": False},
                {"pid": 3, "name": "ZenlessZoneZero.exe", "open": "raise"},
            ])
            with patch.object(app, "_win32_api", return_value=api):
                snapshot = app.process_snapshot()
            self.assertTrue(snapshot.complete)
            self.assertEqual(snapshot.present_pids, {1, 2, 3})
            self.assertEqual(snapshot, {})
            self.assertEqual(snapshot.unreadable_identities, set())
            self.assertEqual(api.closed, [100001, 90000])

    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes collector regression")
    def test_34_failed_or_partial_enumeration_never_marks_exit(self):
        for stage in ("create_invalid", "create_raise", "first", "next_false", "next_raise", "close"):
            with self.subTest(stage=stage):
                api = FakeWin32([{"pid": 9936, "name": "ZenlessZoneZero.exe"}])
                if stage == "create_invalid":
                    api.CreateToolhelp32Snapshot = Mock(return_value=app.INVALID_HANDLE_VALUE)
                elif stage == "create_raise":
                    api.CreateToolhelp32Snapshot = Mock(side_effect=OSError("Failed snapshot"))
                elif stage == "first":
                    api.Process32FirstW = Mock(side_effect=OSError("Failed enumeration"))
                elif stage == "next_false":
                    api.Process32NextW = Mock(return_value=False)
                elif stage == "next_raise":
                    api.Process32NextW = Mock(side_effect=OSError("Failed enumeration"))
                elif stage == "close":
                    close = api.CloseHandle
                    api.CloseHandle = lambda handle: close(handle) and False
                app.ctypes.set_last_error(5)
                with patch.object(app, "_win32_api", return_value=api):
                    snapshot = app.process_snapshot()
                self.assertFalse(snapshot.complete)
                if stage.startswith("create"):
                    self.assertEqual(api.closed, [])
                else:
                    self.assertEqual(api.closed[-1], 90000)
                tracker = app.Tracker(self.engine, 300)
                self.poll_at(tracker, self.processes(None), 0)
                self.poll_at(tracker, self.processes(None), 120)
                self.poll_at(tracker, snapshot, 125)
                self.assertEqual(self.store.data["sessions"][-1]["action"], "skipped")
                self.assertEqual(self.fake.writes, [])

    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes Unicode and creation-time regression")
    def test_35_unicode_long_paths_case_and_full_creation_time_precision(self):
        path = app.RULES[self.game][0].swapcase() + ("中文 空格\\" * 60) + "游戏.exe"
        ticks = 134067744000000001
        api = FakeWin32([{"pid": 1, "name": "中文 游戏.EXE", "path": path, "ticks": ticks}])
        with patch.object(app, "_win32_api", return_value=api):
            first = app.process_snapshot()
            api.rows[0]["ticks"] += 1
            second = app.process_snapshot()
        self.assertTrue(first.complete and second.complete)
        self.assertEqual(list(first), [(1, str(ticks), "中文 游戏.exe")])
        self.assertEqual(list(first.values()), [(self.game, path)])
        self.assertEqual(list(first.matches.values()), ["path"])
        self.assertNotEqual(list(first), list(second))

    def test_36_watch_interval_default_and_configuration(self):
        for arguments, expected in ((["--watch"], 10), (["--watch", "--interval", "2.5"], 2.5)):
            with patch.object(app.sys, "argv", ["auto_daily.py", *arguments]), patch.object(app, "watch") as watch:
                self.assertEqual(app.main(), 0)
                self.assertEqual(watch.call_args.args[0].interval, expected)

    def test_37_shared_global_id_never_marks_other_game(self):
        self.game = "星救"
        self.exe = app.RULES[self.game][0] + "StarSavior.exe"
        self.fake.state["games"][2]["id"] = self.fake.state["games"][0]["id"]
        self.fake.save()
        row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertFalse(any(g["daily"] for g in self.fake.state["games"]))
        self.assertEqual(self.fake.writes, [])

    def test_38_disk_only_duplicate_id_blocks_before_send(self):
        original = self.fake.open
        clean = json.loads(json.dumps(self.fake.state["games"]))
        self.fake.state["games"][1]["id"] = self.fake.state["games"][0]["id"]
        self.fake.save()

        def opened(request, timeout):
            if json.loads(request.data)["action"] == "list":
                return Response({"ok": True, "day": app.day_key(self.now), "games": clean})
            return original(request, timeout)

        with patch.object(self.fake, "open", opened):
            row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertEqual(self.fake.writes, [])

    def test_39_http_only_duplicate_id_blocks_before_send(self):
        games = json.loads(json.dumps(self.fake.state["games"]))
        games[1]["id"] = games[0]["id"]
        with patch.object(self.fake, "open", return_value=Response(
                {"ok": True, "day": app.day_key(self.now), "games": games})):
            row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertEqual(self.fake.writes, [])

    def test_40_readback_requires_one_global_id_and_correct_name(self):
        original = self.fake.open
        for change in ("duplicate", "missing", "renamed"):
            with self.subTest(change=change):
                self.store.data["ledger"] = {}
                self.fake.set_daily(False)
                count = len(self.fake.writes)

                def opened(request, timeout):
                    response = original(request, timeout)
                    if json.loads(request.data)["action"] == "list" and len(self.fake.writes) > count:
                        games = response.value["games"]
                        if change == "duplicate":
                            games.append(dict(games[0], name="other game"))
                        elif change == "missing":
                            del games[0]
                        else:
                            games[0]["name"] = "other game"
                    return response

                with patch.object(self.fake, "open", opened):
                    row = self.session()
                self.assertNotEqual(row["action"], "marked")
                self.assertTrue(row["outcome_unconfirmed"])
                if change != "renamed":
                    self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
                self.engine.flush()
                self.assertEqual(len(self.fake.writes), count + 1)

    def test_41_recovered_verification_also_checks_global_id(self):
        self.fake.drop_after_write = True
        row = self.session()
        self.assertEqual(row["action"], "queued")
        self.fake.online = True
        self.fake.state["games"][1]["id"] = self.fake.state["games"][0]["id"]
        self.fake.save()
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertEqual(len(self.fake.writes), 1)

    def test_42_malformed_http_elements_queue_without_crashing_and_recover(self):
        original = self.fake.open
        bad_rows = [None, 42, "bad", {}, {"id": "x", "name": [], "daily": False},
                    {"id": 42, "name": self.game, "daily": False},
                    {"id": "x", "name": self.game, "daily": 0},
                    {"id": "x", "name": self.game},
                    {"id": "", "name": self.game, "daily": False}]
        for bad in bad_rows:
            with self.subTest(bad=bad):
                self.store.data["sessions"] = []
                with patch.object(self.fake, "open", return_value=Response(
                        {"ok": True, "day": app.day_key(self.now), "games": [bad]})):
                    with self.assertRaises(app.ProtocolError):
                        self.engine.list_current()
                    row = self.session()
                    self.engine.flush()
                self.assertEqual((row["action"], row["reason"]), ("queued", "invalid_game_list"))
                self.assertEqual(self.fake.writes, [])
        self.assertIs(self.fake.open.__func__, original.__func__)
        self.engine.flush()
        self.assertEqual(row["action"], "marked")
        self.assertEqual(len(self.fake.writes), 1)
        events = (self.root / "logs" / "events.jsonl").read_text(encoding="utf-8")
        self.assertIn("invalid_game_elements_discarded", events)

    def test_43_mixed_malformed_elements_discarded_but_never_used_to_write(self):
        games = json.loads(json.dumps(self.fake.state["games"]))
        games.extend([None, 42, "bad", {"id": games[0]["id"], "name": "broken"}])
        snapshot = {"ok": True, "day": app.day_key(self.now), "games": games}
        validated = self.engine.validate_snapshot(snapshot, "test")
        self.assertEqual(len(validated["games"]), len(app.RULES))
        self.assertEqual(validated["_id_counts"][games[0]["id"]], 2)
        with patch.object(self.fake, "open", return_value=Response(snapshot)):
            row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertEqual(self.fake.writes, [])
        games.pop()
        with patch.object(self.fake, "open", return_value=Response(snapshot)):
            row = self.session()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "invalid_game_elements"))
        self.assertEqual(self.fake.writes, [])

    def test_44_malformed_disk_observation_and_prewrite_never_crash(self):
        for bad in (None, 42, "bad", {"id": "x", "name": {}, "daily": True}):
            with self.subTest(bad=bad):
                disk = {"lastDailyKey": app.day_key(self.now), "games": [bad]}
                self.state_path.write_text(json.dumps(disk), encoding="utf-8")
                self.store.data["sessions"] = []
                self.engine.observe_disk()
                row = self.session()
                self.assertEqual((row["action"], row["reason"]), ("queued", "invalid_game_list"))
                self.assertEqual(self.fake.writes, [])
        self.fake.save()
        self.engine.flush()
        self.assertEqual(row["action"], "marked")
        self.assertEqual(len(self.fake.writes), 1)

    def test_45_proven_unsent_failures_release_lock_and_retry_after_restart(self):
        failures = [ConnectionRefusedError(10061, "refused"),
                    socket.gaierror(socket.EAI_NONAME, "dns failed"),
                    ssl.SSLCertVerificationError(1, "certificate rejected")]
        original = self.fake.open
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.store.data["ledger"] = {}
                self.store.data["sessions"] = []
                self.fake.set_daily(False)
                count = len(self.fake.writes)

                def opened(request, timeout):
                    if json.loads(request.data)["action"] == "set_completion":
                        raise urllib.error.URLError(failure)
                    return original(request, timeout)

                with patch.object(self.fake, "open", opened):
                    row = self.session()
                self.assertEqual((row["action"], row["phase"], row["reason"]),
                                 ("queued", "write", "connection_not_sent"))
                self.assertFalse(self.store.ledger(self.game, app.day_key(self.now)).get("attempted"))
                self.assertFalse(row["outcome_unconfirmed"])
                self.assertEqual(len(self.fake.writes), count)
                self.store = app.Store(self.root)
                self.engine = app.Engine(self.store, self.api, self.state_path, lambda: self.now)
                self.engine.flush()
                row = self.store.data["sessions"][0]
                self.assertEqual((row["action"], row["retry_count"]), ("marked", 1))
                self.assertEqual(len(self.fake.writes), count + 1)

    def test_46_ambiguous_transports_never_retry_and_report_manual_confirmation(self):
        failures = [TimeoutError("timed out"), ConnectionResetError("reset"),
                    http.client.RemoteDisconnected("disconnected"),
                    http.client.IncompleteRead(b"partial", 10),
                    ssl.SSLError("ambiguous SSL failure"),
                    urllib.error.URLError("untyped failure")]
        original = self.fake.open
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.store.data["ledger"] = {}
                self.store.data["sessions"] = []
                count = len(self.fake.writes)

                def opened(request, timeout):
                    if json.loads(request.data)["action"] == "set_completion":
                        raise failure
                    return original(request, timeout)

                with patch.object(self.fake, "open", opened):
                    row = self.session()
                self.assertEqual((row["action"], row["phase"]), ("queued", "verify"))
                self.assertIn("write_outcome_unconfirmed", row["reason"])
                self.engine.flush()
                self.assertEqual((row["action"], row["reason"]),
                                 ("failed", "write_outcome_unconfirmed_no_retry"))
                self.session()
                self.engine.flush()
                self.assertEqual(len(self.fake.writes), count)
                captured = io.StringIO()
                with patch.object(app, "ROOT", self.root), patch.object(app, "now_jst", return_value=self.now), redirect_stdout(captured):
                    app.report()
                self.assertIn("需人工确认（结果未确认，禁止自动重发）: " + self.game, captured.getvalue())

    def test_47_failure_after_response_open_is_never_classified_unsent(self):
        response = Response({})
        original = self.fake.open

        def opened(request, timeout):
            if json.loads(request.data)["action"] == "set_completion":
                return response
            return original(request, timeout)

        with patch.object(self.fake, "open", opened), patch.object(
                response, "read", side_effect=ConnectionRefusedError("late failure")):
            row = self.session()
        self.assertEqual(row["phase"], "verify")
        self.assertTrue(row["outcome_unconfirmed"])
        self.engine.flush()
        self.assertEqual(row["reason"], "write_outcome_unconfirmed_no_retry")
        self.assertEqual(self.fake.writes, [])

    def test_48_malformed_readback_retries_read_only(self):
        original = self.fake.open

        def opened(request, timeout):
            if json.loads(request.data)["action"] == "list" and self.fake.writes:
                return Response({"ok": True, "day": app.day_key(self.now), "games": [None]})
            return original(request, timeout)

        with patch.object(self.fake, "open", opened):
            row = self.session()
            self.engine.flush()
        self.assertEqual((row["action"], row["phase"]), ("queued", "verify"))
        self.assertIn("write_outcome_unconfirmed", row["reason"])
        self.engine.flush()
        self.assertEqual(row["action"], "marked")
        self.assertEqual(len(self.fake.writes), 1)

    def test_49_legacy_attempt_lock_is_reported_for_manual_confirmation(self):
        self.store.ledger(self.game, app.day_key(self.now))["attempted"] = True
        row = self.session()
        self.assertEqual(row["reason"], "write_outcome_unconfirmed_no_retry")
        captured = io.StringIO()
        with patch.object(app, "ROOT", self.root), patch.object(app, "now_jst", return_value=self.now), redirect_stdout(captured):
            app.report()
        self.assertIn("需人工确认", captured.getvalue())
        self.assertEqual(self.fake.writes, [])


    def reload_verify_row(self, applied=True, legacy=True, null_target=False):
        self.fake.drop_after_write = applied
        self.fake.fail_before_apply = not applied
        row = self.session()
        self.assertEqual((row["action"], row["phase"]), ("queued", "verify"))
        self.assertEqual(len(self.fake.writes), 1)
        if legacy:
            if null_target:
                row["target_id"] = None
            else:
                del row["target_id"]
        self.store.save()
        self.store = app.Store(self.root)
        self.engine = app.Engine(self.store, self.api, self.state_path, lambda: self.now)
        self.fake.online = True
        self.fake.drop_after_write = self.fake.fail_before_apply = False
        self.fake.calls.clear()
        return self.store.data["sessions"][0]

    def test_50_legacy_verify_true_recovers_after_restart(self):
        row = self.reload_verify_row()
        self.assertNotIn("target_id", row)
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"], row["readback"]),
                         ("marked", "readback_true", True))
        self.assertEqual(row["target_id"], self.fake.state["games"][0]["id"])
        self.assertFalse(row["outcome_unconfirmed"])
        self.assertTrue(self.store.ledger(self.game, row["day_key"])["confirmed"])
        self.assertEqual(app.Store(self.root).data["sessions"][0], row)
        self.assertEqual([c["action"] for c in self.fake.calls], ["list"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_51_legacy_verify_false_never_reposts(self):
        row = self.reload_verify_row(applied=False)
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"], row["readback"]),
                         ("failed", "write_outcome_unconfirmed_no_retry", False))
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertNotIn("confirmed", self.store.ledger(self.game, row["day_key"]))
        self.assertEqual([c["action"] for c in self.fake.calls], ["list"])
        self.engine.flush()
        next_row = self.session()
        self.assertEqual(next_row["reason"], "write_outcome_unconfirmed_no_retry")
        self.assertEqual(len(self.fake.writes), 1, "A later session cannot resend either")

    def test_52_legacy_verify_duplicate_name_is_ambiguous(self):
        row = self.reload_verify_row()
        self.fake.state["games"].append(dict(self.fake.state["games"][0], id="other-id"))
        self.fake.save()
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"], row["readback"]),
                         ("failed", "legacy_row_ambiguous", None))
        self.assertNotIn("target_id", row)
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertEqual([c["action"] for c in self.fake.calls], ["list"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_53_legacy_verify_missing_name_is_missing(self):
        row = self.reload_verify_row()
        del self.fake.state["games"][0]
        self.fake.save()
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"]), ("failed", "legacy_row_missing"))
        self.assertNotIn("target_id", row)
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_54_null_target_is_legacy_unknown(self):
        row = self.reload_verify_row(null_target=True)
        self.assertIsNone(row["target_id"])
        self.engine.flush()
        self.assertEqual((row["action"], row["readback"]), ("marked", True))
        self.assertEqual(row["target_id"], self.fake.state["games"][0]["id"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_55_legacy_verify_global_duplicate_id_still_blocks(self):
        row = self.reload_verify_row()
        self.fake.state["games"][1]["id"] = self.fake.state["games"][0]["id"]
        self.fake.save()
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "id_ambiguous"))
        self.assertNotIn("target_id", row)
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_56_modern_verify_id_change_still_blocks(self):
        row = self.reload_verify_row(legacy=False)
        target_id = row["target_id"]
        self.fake.state["games"][0]["id"] = "changed-id"
        self.fake.state["games"].append(
            {"id": target_id, "name": "different game", "daily": True})
        self.fake.save()
        self.engine.flush()
        self.assertEqual((row["action"], row["reason"]),
                         ("failed", "write_outcome_unconfirmed_id_changed"))
        self.assertEqual(row["target_id"], target_id)
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_57_legacy_verify_malformed_snapshot_cannot_confirm(self):
        row = self.reload_verify_row()
        games = json.loads(json.dumps(self.fake.state["games"])) + [None]
        with patch.object(self.fake, "open", return_value=Response(
                {"ok": True, "day": row["day_key"], "games": games})):
            self.engine.flush()
        self.assertEqual((row["action"], row["reason"]), ("skipped", "invalid_game_elements"))
        self.assertNotIn("target_id", row)
        self.assertTrue(row["outcome_unconfirmed"])
        self.assertEqual(len(self.fake.writes), 1)


    def game_processes(self, pids, game=None, fallback=False):
        game = game or self.game
        name = "ZenlessZoneZero.exe" if game == self.game else "game.exe"
        return app._processes_from_rows([
            {"pid": pid, "born": f"born-{pid}", "name": name,
             "path": "" if fallback else app.RULES[game][0] + name}
            for pid in pids])

    def test_58_simultaneous_processes_one_short_session_not_double_time(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 91, 5):
            self.poll_at(tracker, self.game_processes([1, 2]), tick)
            self.assertEqual(len(tracker.games), 1)
            self.assertEqual(len({id(s) for s in tracker.active.values()}), 1)
        self.poll_at(tracker, {}, 95)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (90, "skipped", "duration_below_120"))
        self.assertEqual(self.fake.writes, [])

    def test_59_sibling_exit_keeps_session_alive_until_last_exit(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in [*range(0, 121, 5), 121]:
            self.poll_at(tracker, self.game_processes([1, 2] if tick < 90 else [2]), tick)
            self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, {}, 126)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (121, "marked"))
        self.assertEqual(len(self.fake.writes), 1)

    def test_60_disjoint_pid_handoffs_continue_same_game(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in [*range(0, 121, 5), 121]:
            base = 10 + (tick // 60) * 2
            self.poll_at(tracker, self.game_processes([base, base + 1]), tick)
            self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, {}, 126)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (121, "marked"))
        self.assertEqual(len(self.fake.writes), 1)

    def test_61_all_exit_then_restart_independent_thresholds(self):
        tracker = app.Tracker(self.engine, 30)
        for start, seconds, pids in ((0, 100, [1, 2]), (110, 100, [3, 4]),
                                      (220, 121, [5, 6])):
            for offset in [*range(0, seconds, 5), seconds]:
                self.poll_at(tracker, self.game_processes(pids), start + offset)
            self.poll_at(tracker, {}, start + seconds + 5)
            self.assertEqual(tracker.games, {})
            self.assertEqual(tracker.active, {})
        self.assertEqual([r["duration_s"] for r in self.store.data["sessions"]], [100, 100, 121])
        self.assertEqual([r["action"] for r in self.store.data["sessions"]],
                         ["skipped", "skipped", "marked"])
        self.assertEqual(len(self.fake.writes), 1)

    def test_62_aggregated_thresholds_119_120_121_are_strict(self):
        tracker = app.Tracker(self.engine, 30)
        for start, seconds, game in ((0, 119, self.game), (200, 120, "异象回声"), (400, 121, "鸣潮")):
            for offset in [*range(0, seconds, 5), seconds]:
                self.poll_at(tracker, self.game_processes([1, 2] if offset < 90 else [3], game=game),
                             start + offset)
            self.poll_at(tracker, {}, start + seconds + 5)
        rows = self.store.data["sessions"]
        self.assertEqual([r["duration_s"] for r in rows], [119, 120, 121])
        self.assertEqual([(r["action"], r["reason"]) for r in rows], [
            ("skipped", "duration_below_120"), ("marked", "readback_true"),
            ("marked", "readback_true")])
        self.assertEqual(len(self.fake.writes), 2)

    def test_63_fallback_multiprocess_handoffs_are_aggregated(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in [*range(0, 121, 5), 121]:
            self.poll_at(tracker, self.game_processes([1, 2] if tick < 90 else [3, 4],
                                                     fallback=True), tick)
        self.poll_at(tracker, {}, 126)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["match"], row["exe_path"]),
                         (121, "marked", "name_fallback", ""))
        self.assertEqual(len(self.fake.writes), 1)

    def test_64_aggregated_cross_reset_keeps_start_day(self):
        self.now = datetime(2026, 11, 6, 4, 58, tzinfo=app.JST)
        tracker = app.Tracker(self.engine, 30)
        for tick in [*range(0, 121, 5), 121]:
            self.poll_at(tracker, self.game_processes([1, 2] if tick < 90 else [3]), tick)
        self.now += timedelta(seconds=126)
        tracker.poll({}, self.now, 126)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["day_key"], row["reason"]),
                         (121, "2026-11-05", "start_day_expired"))
        self.assertEqual(self.fake.writes, [])

    def test_65_interrupted_multi_process_session_recorded_only_once(self):
        for reason in ("process_scan_failed", "monitoring_gap", "monitoring_stopped"):
            with self.subTest(reason=reason):
                tracker = app.Tracker(self.engine, 30)
                before = len(self.store.data["sessions"])
                for tick in range(0, 121, 5):
                    self.poll_at(tracker, self.game_processes([1, 2]), tick)
                if reason == "process_scan_failed":
                    failed = self.game_processes([1])
                    failed.complete = False
                    self.poll_at(tracker, failed, 125)
                elif reason == "monitoring_gap":
                    self.poll_at(tracker, {}, 220)
                else:
                    tracker.discard(reason)
                self.assertEqual(len(self.store.data["sessions"]), before + 1)
                row = self.store.data["sessions"][-1]
                self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                                 (120, "skipped", reason))
                self.assertEqual(tracker.games, {})
        self.assertEqual(self.fake.writes, [])

    def test_66_unresolved_member_cannot_fake_all_processes_exit(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            snapshot = self.game_processes([1, 2])
            if tick >= 90:
                snapshot = self.game_processes([2])
                snapshot.present_pids.add(1)  # Former member's creation time unreadable.
            self.poll_at(tracker, snapshot, tick)
        snapshot = app.ProcessSnapshot()
        snapshot.present_pids.add(1)
        self.poll_at(tracker, snapshot, 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (120, "skipped", "process_identity_changed_or_path_unavailable"))
        self.assertEqual(self.fake.writes, [])

    def test_67_recycled_pid_with_surviving_sibling_does_not_split(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in [*range(0, 121, 5), 121]:
            snapshot = app._processes_from_rows([
                {"pid": pid, "born": "new" if tick >= 90 and pid == 1 else "old",
                 "name": "ZenlessZoneZero.exe", "path": ""} for pid in (1, 2)])
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, {}, 126)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (121, "marked"))

    def test_68_distinct_games_keep_independent_clocks(self):
        tracker = app.Tracker(self.engine, 30)
        other = "异象回声"
        for tick in range(0, 121, 5):
            rows = [{"pid": 1, "born": "one", "name": "ZenlessZoneZero.exe", "path": self.exe}]
            if tick >= 30:
                rows += [{"pid": p, "born": str(p), "name": "echo.exe",
                          "path": app.RULES[other][0] + "echo.exe"} for p in (2, 3)]
            self.poll_at(tracker, app._processes_from_rows(rows), tick)
        self.poll_at(tracker, {}, 125)
        self.assertEqual({r["game"]: (r["duration_s"], r["action"])
                          for r in self.store.data["sessions"]},
                         {self.game: (120, "marked"), other: (90, "skipped")})
        self.assertEqual(len(self.fake.writes), 1)

    def test_69_session_logs_show_start_last_confirmed_end_and_elapsed(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 61, 5):
            self.poll_at(tracker, self.game_processes([1, 2] if tick < 30 else [3, 4]), tick)
        self.poll_at(tracker, {}, 65)
        events = [json.loads(line) for line in
                  (self.root / "logs" / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        starts = [e for e in events if e["event"] == "session_started"]
        ends = [e for e in events if e["event"] == "session_ended"]
        self.assertEqual((len(starts), len(ends)), (1, 1))
        row, = self.store.data["sessions"]
        self.assertEqual(starts[0]["start"], row["start"])
        for key in ("session_id", "start", "end", "duration_s", "day_key", "action", "reason"):
            self.assertEqual(ends[0][key], row[key])
        self.assertEqual((row["start"], row["end"], row["duration_s"]),
                         (self.now.isoformat(), (self.now + timedelta(seconds=60)).isoformat(), 60))
        self.assertEqual(json.loads((self.root / "logs" / "auto_daily.jsonl").read_text(encoding="utf-8")), row)


    # Contract A expected behavior from expected_polling_semantics.py;
    # see README's known limitations before changing these sampling semantics.
    def test_70_A_unobserved_exit_restart_is_one_expected_session(self):
        tracker = app.Tracker(self.engine, 30)
        before = json.loads(json.dumps(self.fake.state))
        # Possible hidden truth: run1 0..91, empty 91..99, run2 99..201.
        # Only the observations below reach the tracker, not that hidden truth.
        for tick in range(0, 201, 10):
            self.poll_at(tracker, self.game_processes([1 if tick < 100 else 2]), tick)
        self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, {}, 210)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (200, "marked", "readback_true"))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual((self.fake.writes[0]["field"], self.fake.writes[0]["done"]),
                         ("daily", True))
        before["games"][0]["daily"] = True
        self.assertEqual(self.fake.state, before)

    def test_71_A_observed_empty_still_splits_short_sessions(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 101, 10):
            self.poll_at(tracker, self.game_processes([1]), tick)
        self.poll_at(tracker, {}, 110)
        for tick in range(120, 221, 10):
            self.poll_at(tracker, self.game_processes([2]), tick)
        self.poll_at(tracker, {}, 230)
        rows = self.store.data["sessions"]
        self.assertEqual([r["duration_s"] for r in rows], [100, 100])
        self.assertEqual([(r["action"], r["reason"]) for r in rows],
                         [("skipped", "duration_below_120")] * 2)
        self.assertEqual(self.fake.writes, [])

    def test_72_A_actual_121_may_only_be_observed_119(self):
        tracker = app.Tracker(self.engine, 30)
        # Hidden lifetime is 0..121; first observed at 1, last observed at 120.
        for tick in [*range(1, 112, 10), 120]:
            self.poll_at(tracker, self.game_processes([1]), tick)
        self.poll_at(tracker, {}, 131)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (119, "skipped", "duration_below_120"))
        self.assertEqual(self.fake.writes, [])

    def test_73_A_observed_manual_cancel_blocks_later_aggregated_run(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 201, 10):
            self.poll_at(tracker, self.game_processes([1]), tick)
        self.poll_at(tracker, {}, 210)
        self.assertEqual(len(self.fake.writes), 1)
        self.fake.set_daily(False)
        self.engine.observe_disk()
        for tick in range(220, 421, 10):
            self.poll_at(tracker, self.game_processes([2 if tick < 320 else 3]), tick)
        self.poll_at(tracker, {}, 430)
        rows = self.store.data["sessions"]
        self.assertEqual([r["duration_s"] for r in rows], [200, 200])
        self.assertEqual((rows[-1]["action"], rows[-1]["reason"]),
                         ("skipped", "manual_cancel_detected"))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertFalse(self.fake.state["games"][0]["daily"])


    def write_daily_log(self, *records):
        self.state_path.with_name("daily-log.json").write_text(
            json.dumps([{"name": self.game, "date": "11/06", **record} for record in records]),
            encoding="utf-8")

    def test_daily_log_user_cancel_locks_without_observed_completion(self):
        for source in ({}, {"src": "user"}):
            with self.subTest(source=source):
                self.store.ledger(self.game, app.day_key(self.now)).clear()
                self.write_daily_log({"act": "撤销", "date": "11/6", **source})
                self.engine.observe_disk()
                self.assertIs(self.store.ledger(self.game, app.day_key(self.now))["cancelled"], True)

    def test_daily_log_auto_cancel_clears_persisted_lock_after_restart(self):
        key = app.day_key(self.now)
        self.write_daily_log({"act": "撤销", "src": "user"},
                             {"act": "撤销", "src": "auto"},
                             {"act": "撤销", "src": "user", "date": "11/7"})
        for ledger in ({"seen_true": True}, {"seen_true": True, "cancelled": True}):
            with self.subTest(ledger=ledger):
                self.store.ledger(self.game, key).update(ledger)
                self.store.save()
                restarted = app.Engine(app.Store(self.root), self.api, self.state_path, lambda: self.now)
                restarted.observe_disk()
                self.assertIs(app.Store(self.root).ledger(self.game, key)["cancelled"], False)

    def test_daily_log_latest_completion_clears_lock(self):
        key = app.day_key(self.now)
        ledger = self.store.ledger(self.game, key)
        ledger["cancelled"] = True
        self.write_daily_log({"act": "撤销", "src": "user"}, {"act": "完成", "src": "user"})
        self.engine.observe_disk()
        self.assertEqual(ledger, {"seen_true": True, "cancelled": False})

    def test_daily_log_missing_or_invalid_falls_back_with_diagnostic(self):
        key = app.day_key(self.now)
        path = self.state_path.with_name("daily-log.json")
        events_path = self.root / "logs" / "events.jsonl"
        for content, reason in (
                (None, "daily_log_missing"),
                (b"{", "daily_log_invalid"),
                (b"\xff", "daily_log_invalid"),
                (b"{}", "daily_log_invalid"),
                (json.dumps([{"name": self.game, "date": "bad", "act": "完成"}]).encode("utf-8"),
                 "daily_log_no_matching_record"),
        ):
            with self.subTest(content=content):
                if content is not None:
                    path.write_bytes(content)
                ledger = self.store.ledger(self.game, key)
                ledger.clear()
                events_path.unlink(missing_ok=True)
                self.fake.set_daily(True)
                self.engine.observe_disk()
                self.fake.set_daily(False)
                self.engine.observe_disk()
                self.engine.observe_disk()
                self.assertIs(ledger["cancelled"], True)
                events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
                self.assertEqual(
                    [(e["event"], e["game"], e["day_key"], e["reason"]) for e in events],
                    [("cancel_unattributed", self.game, key, reason)])

    def test_74_current_install_paths_and_zenless_name_fallback(self):
        rows = []
        for pid, (game, name, path) in enumerate((
                ("绝区零", "ZenlessZoneZero.exe",
                 r"D:\GAME\ZZZ\HoYoPlay\games\ZenlessZoneZero Game\ZenlessZoneZero.exe"),
                ("鸣潮", "Client-Win64-Shipping.exe",
                 r"D:\GAME\Wuthering Waves\Wuthering Waves Game\Client\Binaries\Win64\Client-Win64-Shipping.exe"))):
            with self.subTest(game=game):
                self.assertEqual(app.match_process(path, name), (game, "path"))
                self.assertEqual(app.match_process(path.swapcase(), name.swapcase()), (game, "path"))
                self.assertEqual(app.match_process("E:\\Other\\" + name, name), (None, None))
                self.assertEqual(app.match_process(app.RULES[game][0].rstrip("\\") + "-other\\" + name,
                                                   name), (None, None))
            rows.append({"pid": pid, "born": "first", "name": name, "path": path})
        snapshot = app._processes_from_rows(rows)
        self.assertTrue(snapshot.complete)
        self.assertEqual(snapshot.present_pids, {0, 1})
        self.assertEqual(list(snapshot.values()), [("绝区零", rows[0]["path"]), ("鸣潮", rows[1]["path"])])
        for path in (None, ""):
            self.assertEqual(app.match_process(path, "ZENLESSZONEZERO.EXE"), ("绝区零", "name_fallback"))
            self.assertEqual(app.match_process(path, "Client-Win64-Shipping.exe"), (None, None))
            for name in ("ZenlessZoneZero", "FakeZenlessZoneZero.exe", "ZenlessZoneZero.exe.bak",
                         " ZenlessZoneZero.exe", "ZenlessZoneZero.exe "):
                self.assertEqual(app.match_process(path, name), (None, None))
        self.assertEqual(app.match_process(None, "HoYoPlay.exe"), (None, None))

    @unittest.skipUnless(app.os.name == "nt", "Windows ctypes collector regression")
    def test_75_complete_snapshot_can_have_zero_game_matches(self):
        api = FakeWin32([{"pid": 123, "name": "python.exe", "path": r"C:\Python\python.exe"}])
        with patch.object(app, "_win32_api", return_value=api):
            snapshot = app.process_snapshot()
        self.assertEqual(len(snapshot), 0)
        self.assertTrue(snapshot.complete)
        self.assertEqual(snapshot.present_pids, {123})
        self.assertEqual(api.closed, [100123, 90000])


    def check_path_transition(self, initial_path, final_path, expected_routes):
        tracker = app.Tracker(self.engine, 30)
        identity = (9936, "first", "zenlesszonezero.exe")
        session = None
        for tick in range(0, 121, 5):
            snapshot = self.processes(initial_path if tick < 60 else final_path)
            self.assertEqual(list(snapshot), [identity])
            self.assertIsInstance(next(iter(snapshot)), app.ProcessIdentity)
            self.poll_at(tracker, snapshot, tick)
            if session is None:
                session = tracker.active[identity]
            self.assertIs(tracker.active[identity], session)
            self.assertEqual(session.uncertain_pids, set())
            self.assertEqual(self.store.data["sessions"], [])
            self.assertEqual(self.fake.writes, [])
        self.poll_at(tracker, app.ProcessSnapshot(), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["end"], row["action"], row["readback"]),
                         (120, (self.now + timedelta(seconds=120)).isoformat(), "marked", True))
        self.assertEqual((row["match"], row["exe_path"]), (expected_routes[-1], self.exe))
        self.assertEqual([e["match"] for e in self.match_events()], expected_routes)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertEqual(tracker.active, {})

    def test_76_readable_to_empty_path_marks_actual_duration(self):
        self.check_path_transition(self.exe, "", ["path", "name_fallback"])

    def test_77_empty_to_readable_path_marks_actual_duration(self):
        self.check_path_transition("", self.exe, ["name_fallback", "path"])

    def check_identity_change(self, **replacement):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 91, 5):
            self.poll_at(tracker, self.processes(self.exe), tick)
        old_identity, = tracker.active
        old_session = tracker.active[old_identity]
        snapshot = self.processes(self.exe, **replacement)
        new_identity, = snapshot
        self.assertNotEqual(old_identity, new_identity)
        self.poll_at(tracker, snapshot, 95)
        self.assertNotIn(old_identity, tracker.active)
        self.assertIsNot(tracker.active[new_identity], old_session)
        self.assertEqual(tracker.active[new_identity].tick, 95)
        old_row, = self.store.data["sessions"]
        # Retain the existing conservative skip on an observed identity change.
        self.assertEqual((old_row["duration_s"], old_row["action"], old_row["reason"]),
                         (90, "skipped", "process_identity_changed_or_path_unavailable"))
        self.poll_at(tracker, snapshot, 100)
        self.poll_at(tracker, app.ProcessSnapshot(), 105)
        self.assertEqual([r["duration_s"] for r in self.store.data["sessions"]], [90, 5])
        self.assertEqual(self.fake.writes, [])

    def test_78_changed_born_splits_same_pid_and_name(self):
        self.check_identity_change(born="second")

    def test_79_changed_name_splits_same_pid_and_born(self):
        self.check_identity_change(name="different.exe")

    def test_80_readable_path_session_still_marks_on_exit(self):
        self.check_path_transition(self.exe, self.exe, ["path"])

    def test_81_pid_handoff_then_hidden_paths_does_not_leave_uncertainty(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            snapshot = self.game_processes([1, 2] if tick < 30 else [3, 4],
                                           fallback=tick >= 60)
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(tracker.games[self.game].uncertain_pids, set())
            self.assertEqual(self.store.data["sessions"], [])
            self.assertEqual(self.fake.writes, [])
        self.poll_at(tracker, app.ProcessSnapshot(), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["match"]),
                         (120, "marked", "name_fallback"))
        self.assertEqual(len(self.fake.writes), 1)

    def test_82_missing_born_window_remains_uncertain_until_identity_returns(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            snapshot = self.game_processes([1, 2])
            if 60 <= tick < 120:
                snapshot = app._processes_from_rows([
                    {"pid": 1, "born": "", "name": "ZenlessZoneZero.exe", "path": ""},
                    {"pid": 2, "born": "born-2", "name": "ZenlessZoneZero.exe", "path": ""}])
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(tracker.games[self.game].uncertain_pids,
                             {1} if 60 <= tick < 120 else set())
            self.assertEqual(self.store.data["sessions"], [])
        self.poll_at(tracker, app.ProcessSnapshot(), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (120, "marked"))
        self.assertEqual(len(self.fake.writes), 1)


    def uncertainty_events(self):
        return [e for e in map(json.loads, (self.root / "logs" / "events.jsonl")
                              .read_text(encoding="utf-8").splitlines())
                if e["event"] == "uncertainty"]

    def test_83_reused_pid_logs_born_changed_and_still_skips(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(self.exe), tick)
        self.poll_at(tracker, self.processes(r"C:\Other\worker.exe", name="worker.exe",
                                             born="second"), 125)
        event, = self.uncertainty_events()
        self.assertEqual((event["game"], event["pid"], event["cause"], event["born"]),
                         (self.game, 9936, "born_changed", "second"))
        self.assertEqual(event["previous_identities"],
                         [{"born": "first", "name": "zenlesszonezero.exe"}])
        self.assertEqual((event["name"], event["path"]),
                         ("worker.exe", r"C:\Other\worker.exe"))
        self.assertTrue(all(event[k] for k in ("present", "snapshot_row_available",
                                              "name_readable", "born_readable", "path_readable")))
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (120, "skipped", "process_identity_changed_or_path_unavailable"))
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(tracker.games, {})

    def test_84_born_missing_logs_once_per_entry_and_recovery_still_marks(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            missing = 60 <= tick < 90 or 100 <= tick < 110
            rows = [{"pid": pid, "born": "" if missing and pid == 1 else f"born-{pid}",
                     "name": "ZenlessZoneZero.exe", "path": self.exe} for pid in (1, 2)]
            self.poll_at(tracker, app._processes_from_rows(rows), tick)
            self.assertEqual(tracker.games[self.game].uncertain_pids, {1} if missing else set())
            self.assertEqual(len(self.uncertainty_events()),
                             0 if tick < 60 else 1 if tick < 100 else 2)
        for event in self.uncertainty_events():
            self.assertEqual((event["pid"], event["cause"], event["born"]), (1, "born_missing", ""))
            self.assertFalse(event["born_readable"])
            self.assertTrue(event["present"] and event["path_readable"])
        self.poll_at(tracker, app.ProcessSnapshot(), 125)
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (120, "marked", "readback_true"))
        self.assertEqual(len(self.fake.writes), 1)

    def test_85_normal_session_has_no_uncertainty_events(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(self.exe), tick)
        self.poll_at(tracker, app.ProcessSnapshot(), 125)
        self.assertEqual(self.uncertainty_events(), [])
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"]), (120, "marked"))

    def test_86_other_causes_are_supported_by_snapshot_evidence(self):
        cases = [
            ("name_changed", {"name": "worker.exe", "path": r"C:\Other\worker.exe"}),
            ("path_mismatch", {"path": r"C:\Other\ZenlessZoneZero.exe"}),
            ("name_missing", {"name": "", "path": r"C:\Other\worker.exe"}),
            ("unreadable_identity", {"name": "", "path": None}),
            ("snapshot_metadata_missing", None),
        ]
        for cause, replacement in cases:
            with self.subTest(cause=cause):
                tracker = app.Tracker(self.engine, 30)
                self.poll_at(tracker, self.processes(self.exe), 0)
                if replacement is None:
                    snapshot = app.ProcessSnapshot()
                    snapshot.present_pids.add(9936)
                else:
                    snapshot = app._processes_from_rows([
                        {"pid": 9936, "born": "first", "name": "ZenlessZoneZero.exe",
                         "path": self.exe, **replacement}])
                self.poll_at(tracker, snapshot, 5)
                event = self.uncertainty_events()[-1]
                self.assertEqual((event["cause"], event["present"]), (cause, True))
                self.assertEqual(event["previous_identities"][0]["born"], "first")
                if replacement is None:
                    self.assertFalse(event["snapshot_row_available"])
                    self.assertIsNone(event["born_readable"])
                else:
                    self.assertTrue(event["born_readable"])
                    self.assertEqual(event["name"], replacement.get("name", "ZenlessZoneZero.exe"))
                    self.assertEqual(event["path"], replacement["path"])
                    self.assertEqual(event["path_readable"], replacement["path"] is not None)
                row = self.store.data["sessions"][-1]
                self.assertEqual((row["action"], row["reason"]),
                                 ("skipped", "process_identity_changed_or_path_unavailable"))
        self.assertEqual(len(self.uncertainty_events()), len(cases))
        self.assertEqual(self.fake.calls, [])

    def test_87_retained_uncertainty_is_silent_even_if_evidence_changes(self):
        tracker = app.Tracker(self.engine, 30)
        self.poll_at(tracker, self.game_processes([1, 2]), 0)
        for tick in range(5, 126, 5):
            snapshot = app._processes_from_rows([
                {"pid": 1, "born": "second" if tick < 90 else "third",
                 "name": "worker.exe", "path": r"C:\Other\worker.exe"},
                *([{"pid": 2, "born": "born-2", "name": "ZenlessZoneZero.exe",
                    "path": self.exe}] if tick <= 120 else [])])
            self.poll_at(tracker, snapshot, tick)
            self.assertEqual(len(self.uncertainty_events()), 1)
            if tick <= 120:
                self.assertEqual(tracker.games[self.game].uncertain_pids, {1})
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (120, "skipped", "process_identity_changed_or_path_unavailable"))
        self.assertEqual(self.fake.calls, [])

    def test_88_path_loss_and_same_poll_rematch_do_not_enter_uncertainty(self):
        tracker = app.Tracker(self.engine, 30)
        for tick in range(0, 121, 5):
            self.poll_at(tracker, self.processes(self.exe if tick < 60 else ""), tick)
        # The three existing set operations remove a PID that matches again in
        # this same poll, even if born changed. Preserve that distinction.
        self.poll_at(tracker, self.processes("", born="second"), 125)
        self.assertEqual(self.uncertainty_events(), [])
        row, = self.store.data["sessions"]
        self.assertEqual((row["duration_s"], row["action"], row["reason"]),
                         (120, "skipped", "process_identity_changed_or_path_unavailable"))


class DoctorTests(unittest.TestCase):
    def payload(self):
        return {"ok": True, "day": "2026-11-07", "games": [
            {"id": str(i), "name": name, "daily": False} for i, name in enumerate(app.RULES)]}

    def helper_payload_check(self, value):
        return app.check_helper_payload(value, app.RULES, "2026-11-07")

    def test_89_doctor_config_paths_all_present(self):
        rows = app.check_config_paths(app.RULES, dict.fromkeys(app.RULES, True))
        self.assertEqual(len(rows), len(app.RULES))
        self.assertTrue(all(row.level == "OK" for row in rows))

    def test_90_doctor_missing_path_fails_with_actionable_text(self):
        paths = dict.fromkeys(app.RULES, True)
        paths["绝区零"] = False
        failed, = [r for r in app.check_config_paths(app.RULES, paths) if r.level == "FAIL"]
        for text in ("配置路径", app.RULES["绝区零"][0], "该路径不存在", "建议核对安装目录"):
            self.assertIn(text, failed.message)

    def test_91_doctor_zero_matches_is_ok(self):
        row, = app.check_current_matches(app.ProcessSnapshot())
        self.assertEqual(row.level, "OK")
        self.assertIn("未命中", row.message)

    def test_92_doctor_matches_include_every_pid_and_route(self):
        snapshot = app._processes_from_rows([
            {"pid": 10, "born": "a", "name": "ZenlessZoneZero.exe",
             "path": app.RULES["绝区零"][0] + "ZenlessZoneZero.exe"},
            {"pid": 20, "born": "b", "name": "ZenlessZoneZero.exe", "path": None}])
        row, = app.check_current_matches(snapshot)
        self.assertEqual(row.level, "OK")
        for text in ("绝区零", "10(match=path)", "20(match=name_fallback)"):
            self.assertIn(text, row.message)

    def test_93_doctor_incomplete_scan_cannot_be_ok_empty(self):
        snapshot = app.ProcessSnapshot()
        snapshot.complete = False
        self.assertEqual(app.check_current_matches(snapshot)[0].level, "FAIL")
        self.assertEqual(app.check_current_matches(None, OSError())[0].level, "FAIL")

    def test_94_doctor_list_reports_count_and_accepts_extra_games(self):
        payload = self.payload()
        payload["games"].append({"id": "extra", "name": "额外游戏", "daily": True})
        row = self.helper_payload_check(payload)
        self.assertEqual(row.level, "OK")
        self.assertIn(f"{len(payload['games'])} 个游戏", row.message)
        self.assertIn(f"{len(app.RULES)}/{len(app.RULES)}", row.message)

    def test_95_doctor_list_rejects_missing_fields_games_and_duplicates(self):
        cases = [None, {"ok": False}, {"ok": True}, {"ok": True, "games": []}]
        for field in ("id", "name", "daily"):
            payload = self.payload()
            del payload["games"][0][field]
            cases.append(payload)
        for field, value in (("id", ""), ("daily", 0), ("name", " ")):
            payload = self.payload()
            payload["games"][0][field] = value
            cases.append(payload)
        payload = self.payload()
        payload["games"][1]["id"] = payload["games"][0]["id"]
        cases.append(payload)
        payload = self.payload()
        payload["games"].append(dict(payload["games"][0], id="different-id"))
        cases.append(payload)
        payload = self.payload()
        del payload["day"]
        cases.append(payload)
        for value in cases:
            with self.subTest(value=value):
                self.assertEqual(self.helper_payload_check(value).level, "FAIL")

    def test_96_doctor_helper_day_must_match_jst_reset_day(self):
        payload = self.payload()
        payload["day"] = "2026-11-06"
        row = self.helper_payload_check(payload)
        self.assertEqual(row.level, "FAIL")
        self.assertIn("应为 2026-11-07", row.message)

    def transport_failure(self, exc):
        connection = Mock()
        connection.read_text.return_value = "http://127.0.0.1:12345/" + "x" * 32
        with self.assertRaises(app.Unavailable) as caught:
            app.HelperHTTP(connection, Mock(open=Mock(side_effect=exc)), endpoint_file=None).call("list")
        return caught.exception

    def test_97_doctor_connection_file_missing_is_distinct(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "absent"
            with self.assertRaises(app.Unavailable) as caught:
                app.HelperHTTP(path, endpoint_file=None).call("list")
            self.assertEqual(caught.exception.failure, "file_missing")
            self.assertFalse(caught.exception.sent)
            row = app.check_helper_connection("present", caught.exception)
            self.assertEqual(row.level, "FAIL")
            self.assertIn("文件缺失", row.message)
            self.assertFalse(path.exists())

    def test_98_doctor_connection_refusal_is_not_timeout(self):
        error = self.transport_failure(urllib.error.URLError(ConnectionRefusedError()))
        self.assertEqual(error.failure, "connection")
        self.assertFalse(error.sent)
        row = app.check_helper_connection("present", error)
        self.assertEqual(row.level, "FAIL")
        self.assertIn("连接失败", row.message)
        self.assertNotIn("超时", row.message)

    def test_99_doctor_timeout_before_or_during_response_is_distinct(self):
        for cause in (TimeoutError(), urllib.error.URLError(socket.timeout()),
                      OSError(app.errno.ETIMEDOUT, "timeout")):
            with self.subTest(cause=cause):
                error = self.transport_failure(cause)
                self.assertTrue(error.sent)
                self.assertEqual(error.failure, "timeout")
                self.assertIn("超时", app.check_helper_connection("present", error).message)
        response = Response(None)
        response.read = Mock(side_effect=TimeoutError())
        connection = Mock()
        connection.read_text.return_value = "http://127.0.0.1:12345/" + "x" * 32
        with self.assertRaises(app.Unavailable) as caught:
            app.HelperHTTP(connection, Mock(open=Mock(return_value=response)), endpoint_file=None).call("list")
        self.assertEqual(caught.exception.failure, "timeout")
        self.assertTrue(caught.exception.sent)

    def test_100_doctor_other_errors_do_not_infer_timeout_from_text(self):
        error = self.transport_failure(urllib.error.URLError("timed out maybe"))
        self.assertEqual(error.failure, "connection")
        self.assertTrue(error.sent)
        for error, text in ((app.Unauthorized(), "鉴权失败"), (app.ProtocolError("bad"), "协议异常"),
                            (app.Unavailable("unreadable", failure="file_unreadable"), "文件不可读")):
            row = app.check_helper_connection("present", error)
            self.assertEqual(row.level, "FAIL")
            self.assertIn(text, row.message)
        connection = Mock()
        connection.read_text.side_effect = UnicodeError()
        with self.assertRaises(app.ProtocolError):
            app.HelperHTTP(connection, endpoint_file=None).call("list")

    def test_101_doctor_lock_occupied_and_absent_are_different(self):
        self.assertEqual(app.check_watch_lock("occupied").level, "OK")
        for status in ("missing", "free"):
            self.assertEqual(app.check_watch_lock(status).level, "WARN")
            self.assertIn("未发现持锁", app.check_watch_lock(status).message)

    @unittest.skipUnless(app.os.name == "nt", "Windows lock probe")
    def test_102_doctor_native_lock_probe_is_read_only_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "data" / "watch.lock"
            self.assertEqual(app.probe_watch_lock(path)[0], "missing")
            self.assertFalse(path.parent.exists())
            with app.watch_lock(root):
                before = path.stat().st_mtime_ns
                self.assertEqual(app.probe_watch_lock(path)[0], "occupied")
                self.assertEqual(path.stat().st_mtime_ns, before)
            self.assertEqual(app.probe_watch_lock(path)[0], "free")
            with app.watch_lock(root):
                self.assertEqual(app.probe_watch_lock(path)[0], "occupied")
            self.assertEqual(path.read_bytes(), b"0")

    def test_103_doctor_lock_permission_failure_does_not_claim_running(self):
        row = app.check_watch_lock("error", "WinError 5")
        self.assertEqual(row.level, "WARN")
        self.assertIn("无法判断", row.message)

    def test_104_doctor_log_permission_results(self):
        # Permission success cannot prove writer compatibility with third-party
        # handles on Windows; even complete coverage is WARN by design.
        row = app.check_logs_writable("writable")
        self.assertEqual(row.level, "WARN")
        for text in ("权限探测通过", "无法证明第三方持锁时真实日志仍可写", "Windows 共享语义", "运维手册"):
            self.assertIn(text, row.message)
        healthy = [app.DoctorCheck("OK", "healthy") for _ in range(11)]
        self.assertIn("OK=11 WARN=0 FAIL=0", app.doctor_lines(healthy)[-2])
        self.assertIn("[WARN] 汇总 | OK=11 WARN=1 FAIL=0 | 退出码=0",
                      app.doctor_lines(healthy + [row]))
        self.assertEqual(app.doctor_exit_code(healthy + [row]), 0)
        self.assertEqual(app.check_logs_writable("error", "WinError 5").level, "FAIL")
        self.assertEqual(app.check_logs_writable("unsupported").level, "WARN")

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_105_doctor_native_logs_probe_and_reader_never_block_replace(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(app.probe_logs_writable(root / "missing")[0], "error")
            self.assertFalse((root / "missing").exists())
            self.assertEqual(app.probe_logs_writable(root)[0], "writable")
            self.assertEqual(list(root.iterdir()), [])
            path = root / "auto_daily.jsonl"
            content = '{"end":"2026-11-07","action":"skipped","reason":"test"}\n'
            path.write_text(content, encoding="utf-8")
            before = path.stat().st_mtime_ns
            kernel = app._doctor_file_api()
            # A reader without FILE_SHARE_DELETE models the tail -F failure.
            handle = kernel.CreateFileW(str(path), 0x80000000, 3, None, 3, 0, None)
            self.assertNotIn(handle, (None, app.INVALID_HANDLE_VALUE))
            try:
                self.assertEqual(app.probe_logs_writable(root)[0], "error")
                self.assertEqual(app.read_last_session(path), (content.strip(), None))
            finally:
                kernel.CloseHandle(handle)
            original_read = kernel.ReadFile
            def read_and_replace(*args):
                # While doctor owns its read handle, replacing is still possible.
                if path.exists():
                    path.rename(root / "old.jsonl")
                return original_read(*args)
            kernel.ReadFile = read_and_replace
            with patch.object(app, "_doctor_file_api", return_value=kernel):
                self.assertEqual(app.read_last_session(path), (content.strip(), None))
            (root / "old.jsonl").rename(path)
            self.assertEqual(app.probe_logs_writable(root)[0], "writable")
            self.assertEqual(path.read_text(encoding="utf-8"), content)
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_106_doctor_recent_no_records_is_warn_without_creating_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "absent.jsonl"
            evidence = app.read_last_session(path)
            self.assertEqual(evidence, ("", None))
            self.assertEqual(app.check_recent_session(*evidence).level, "WARN")
            self.assertFalse(path.exists())
        self.assertEqual(app.check_recent_session("").level, "WARN")

    def test_107_doctor_latest_session_time_action_reason_and_end_fallback(self):
        for field in ("time", "end"):
            row = app.check_recent_session(json.dumps({field: "2026-11-07T12:00:00+09:00",
                                                       "action": "marked", "reason": "readback_true"}))
            self.assertEqual(row.level, "OK")
            for text in ("time=2026-11-07", "action=marked", "reason=readback_true"):
                self.assertIn(text, row.message)
            self.assertEqual("取会话 end" in row.message, field == "end")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sessions.jsonl"
            path.write_text('\ufeff{"reason":"old"}\n{"reason":"last"}\n\n', encoding="utf-8")
            self.assertEqual(app.read_last_session(path), ('{"reason":"last"}', None))

    def test_108_doctor_recent_corruption_or_read_failure_is_visible(self):
        for value in ("not-json", "[]", "{}", '{"end":"now","action":"marked"}'):
            self.assertEqual(app.check_recent_session(value).level, "FAIL")
        self.assertEqual(app.check_recent_session("", OSError()).level, "WARN")

    def test_109_doctor_versions_exit_codes_lines_and_next_steps(self):
        self.assertEqual(app.check_python_version((3, 10, 9)).level, "FAIL")
        self.assertEqual(app.check_python_version((3, 11, 0)).level, "OK")
        for levels, expected in ((["OK"], 0), (["OK", "WARN"], 0), (["WARN", "FAIL"], 1)):
            rows = [app.DoctorCheck(level, "test\nsecond line", "same advice") for level in levels]
            self.assertEqual(app.doctor_exit_code(rows), expected)
            lines = app.doctor_lines(rows)
            self.assertTrue(all(line.startswith(("[OK]", "[WARN]", "[FAIL]")) and "\n" not in line
                                for line in lines))
            self.assertIn("下一步建议", lines[-1])
            self.assertEqual(lines[-1].count("same advice"), 1)

    def test_110_doctor_integration_one_list_one_snapshot_no_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            helper = root / "DailyHelperDesktop"
            helper.mkdir()
            (helper / "active-window.txt").write_text("placeholder", encoding="utf-8")
            (root / "logs").mkdir()
            (root / "logs" / "auto_daily.jsonl").write_text(
                '{"end":"2026-11-07","action":"marked","reason":"readback_true"}', encoding="utf-8")
            rules = {name: (str(root), ()) for name in app.RULES}
            def files():
                return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
                        for p in root.rglob("*") if p.is_file()}
            before = files()
            api, output = Mock(), io.StringIO()
            api.call.return_value = self.payload()
            with patch.dict(app.os.environ, {"LOCALAPPDATA": str(root)}), \
                    patch.object(app, "RULES", rules), \
                    patch.object(app, "now_jst", return_value=datetime(2026, 11, 7, 12, tzinfo=app.JST)), \
                    patch.object(app, "HelperHTTP", return_value=api), \
                    patch.object(app, "process_snapshot", return_value=app.ProcessSnapshot()) as scan, \
                    patch.object(app, "Store", side_effect=AssertionError("Store forbidden")), \
                    patch.object(app, "Engine", side_effect=AssertionError("Engine forbidden")), \
                    patch.object(app, "Tracker", side_effect=AssertionError("Tracker forbidden")), \
                    patch.object(app, "watch_lock", side_effect=AssertionError("watch forbidden")), \
                    patch.object(app, "atomic_text", side_effect=AssertionError("write forbidden")), \
                    redirect_stdout(output):
                self.assertEqual(app.doctor(root), 0)
            scan.assert_called_once_with()
            api.call.assert_called_once_with("list")
            self.assertEqual(files(), before)
            self.assertFalse((root / "data").exists())
            self.assertIn("action=marked", output.getvalue())

    def test_111_doctor_cli_dispatch_and_reset_auth_guard(self):
        with patch.object(app.sys, "argv", ["auto_daily.py", "--doctor"]), \
                patch.object(app, "doctor", return_value=1) as doctor:
            self.assertEqual(app.main(), 1)
            doctor.assert_called_once_with()
        with patch.object(app.sys, "argv", ["auto_daily.py", "--doctor", "--reset-auth"]), \
                patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit) as caught:
            app.main()
        self.assertEqual(caught.exception.code, 2)

    def test_112_doctor_keeps_checking_after_interface_and_snapshot_failure(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict(app.os.environ, {"LOCALAPPDATA": folder}), \
                patch.object(app, "process_snapshot", side_effect=OSError()), \
                patch.object(app, "probe_watch_lock", return_value=("occupied", "")), \
                patch.object(app, "probe_logs_writable", return_value=("error", "WinError 5")), \
                redirect_stdout(output):
            self.assertEqual(app.doctor(Path(folder)), 1)
        for text in ("文件缺失", "进程快照失败", "Python", "已有 watcher 持锁", "日志", "暂无记录", "下一步建议"):
            self.assertIn(text, output.getvalue())

    def locked_log_doctor(self, target, expected):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            logs = root / "logs"
            logs.mkdir()
            for name in ("auto_daily.jsonl", "events.jsonl", "auto_daily.jsonl.tmp"):
                (logs / name).write_text(
                    '{"end":"2026-11-07","action":"skipped","reason":"fixture"}\n', encoding="utf-8")
            def files():
                return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
                        for p in root.rglob("*") if p.is_file()}
            before = files()
            kernel = app._doctor_file_api()
            # Real reviewer-style Windows reader: denies write and delete sharing.
            handle = kernel.CreateFileW(str(logs / target), 0x80000000, 1, None, 3, 0, None)
            self.assertNotIn(handle, (None, app.INVALID_HANDLE_VALUE))
            output = io.StringIO()
            try:
                with patch.dict(app.os.environ, {"LOCALAPPDATA": str(root)}), \
                        patch.object(app.sys, "argv", ["auto_daily.py", "--doctor"]), \
                        patch.object(app.doctor, "__defaults__", (root,)), \
                        patch.object(app, "Store", side_effect=AssertionError("Store forbidden")), \
                        patch.object(app, "atomic_text", side_effect=AssertionError("write forbidden")), \
                        redirect_stdout(output):
                    self.assertEqual(app.main(), 1)
            finally:
                self.assertTrue(kernel.CloseHandle(handle))
            self.assertEqual(files(), before)
            line, = [line for line in output.getvalue().splitlines() if "] 日志 |" in line]
            self.assertTrue(line.startswith("[FAIL]"), output.getvalue())
            self.assertIn(expected, line)
            self.assertIn("WinError 32", line)
            self.assertIn("退出码=1", output.getvalue())
            print("  --doctor (real Windows share lock, synthetic logs): " + line)

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_113_doctor_events_real_share_lock_fails_without_writes(self):
        self.locked_log_doctor("events.jsonl", "events.jsonl 无法追加，watcher 写诊断会失败")

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_114_doctor_tmp_real_share_lock_fails_without_writes(self):
        self.locked_log_doctor("auto_daily.jsonl.tmp", "atomic_text 的临时文件不可写")

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_115_doctor_absent_events_and_tmp_are_unverified_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for main_exists in (False, True):
                with self.subTest(main_exists=main_exists):
                    if main_exists:
                        (root / "auto_daily.jsonl").write_text("sentinel", encoding="utf-8")
                    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()}
                    check = app.check_logs_writable(*app.probe_logs_writable(root))
                    self.assertEqual(check.level, "WARN")  # Missing files add no writer evidence.
                    self.assertIn("已验：目录/主日志 中 2 项" if main_exists else "已验：目录 中 1 项", check.message)
                    self.assertIn("未验：events/临时文件 2 项" if main_exists else
                                  "未验：主日志/events/临时文件 3 项", check.message)
                    self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                                              for p in root.iterdir()})
                    if main_exists:
                        print("  --doctor (events/tmp absent, synthetic logs): " + app.doctor_lines([check])[0])

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_116_doctor_all_logs_verified_read_only_with_exact_native_flags(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("auto_daily.jsonl", "events.jsonl", "auto_daily.jsonl.tmp"):
                (root / name).write_bytes(b"sentinel")
            before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()}
            kernel = app._doctor_file_api()
            create, close, opened, closed = kernel.CreateFileW, kernel.CloseHandle, [], []
            def record_open(*args):
                handle = create(*args)
                opened.append((args, handle))
                return handle
            def record_close(handle):
                closed.append(handle)
                return close(handle)
            kernel.CreateFileW, kernel.CloseHandle = record_open, record_close
            with patch.object(app, "_doctor_file_api", return_value=kernel):
                check = app.check_logs_writable(*app.probe_logs_writable(root))
            self.assertEqual(check.level, "WARN")  # All four permissions still cannot prove real writes.
            self.assertIn("已验：目录/主日志/events/临时文件 中 4 项，未验：无 0 项", check.message)
            self.assertEqual([args[1] for args, _ in opened], [2, 0x10000, 0x4, 0x40000000])
            self.assertTrue(all(args[2] == 7 and args[4] == 3 for args, _ in opened))
            self.assertEqual([handle for _, handle in opened], closed)
            self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()})

    def test_117_doctor_moved_wuthering_path_warns_but_never_matches(self):
        path = r"D:\GAME\Wuthering Waves\3.1.0.0\Wuthering Waves Game\Client\Binaries\Win64\Client-Win64-Shipping.exe"
        snapshot = app._processes_from_rows([
            {"pid": 301, "born": "a", "name": "Client-Win64-Shipping.exe", "path": path}])
        self.assertFalse(snapshot)
        self.assertEqual(app.match_process(path, "Client-Win64-Shipping.exe"), (None, None))
        self.assertEqual(app.match_process(None, "Client-Win64-Shipping.exe"), (None, None))
        row, = app.check_path_drift(snapshot, app.RULES)
        self.assertEqual(row.level, "WARN")
        for text in ("路径漂移疑似", "pid=301", "Client-Win64-Shipping.exe", path,
                     "最接近的配置游戏=鸣潮", "仅提示人工确认"):
            self.assertIn(text, row.message)
        self.assertFalse(snapshot)
        self.assertEqual(snapshot.matches, {})
        self.assertEqual(app.check_current_matches(snapshot)[0].level, "OK")

    def test_118_doctor_all_normal_body_matches_have_no_drift_warning(self):
        for pid, (game, names) in enumerate(app.DOCTOR_BODY_EXES.items(), 1):
            with self.subTest(game=game):
                path = app.RULES[game][0] + names[0]
                snapshot = app._processes_from_rows([
                    {"pid": pid, "born": "a", "name": names[0].upper(), "path": path.upper()}])
                self.assertEqual(app.match_process(path, names[0]), (game, "path"))
                self.assertTrue(snapshot)
                self.assertEqual(app.check_path_drift(snapshot, app.RULES), [])

    def test_119_doctor_drift_uses_directory_boundary_and_ignores_unknown_names(self):
        snapshot = app._processes_from_rows([
            {"pid": 1, "born": "a", "name": "ZenlessZoneZero.exe",
             "path": app.RULES["绝区零"][0].rstrip("\\") + r"-other\ZenlessZoneZero.exe"},
            {"pid": 2, "born": "b", "name": "launcher.exe", "path": r"C:\Other\launcher.exe"},
            {"pid": 3, "born": "c", "name": "UnityCrashHandler64.exe", "path": r"C:\Other\UnityCrashHandler64.exe"}])
        row, = app.check_path_drift(snapshot, app.RULES)
        self.assertIn("pid=1", row.message)
        self.assertIn("最接近的配置游戏=绝区零", row.message)

    def test_120_doctor_drift_handles_missing_born_and_unreadable_paths(self):
        snapshot = app._processes_from_rows([
            {"pid": 1, "born": "", "name": "ZenlessZoneZero.exe", "path": r"C:\Other\ZenlessZoneZero.exe"},
            {"pid": 2, "born": "a", "name": "ZenlessZoneZero.exe", "path": None},
            {"pid": 3, "born": "b", "name": "ZenlessZoneZero.exe", "path": ""}])
        row, = app.check_path_drift(snapshot, app.RULES)
        self.assertIn("pid=1", row.message)
        self.assertNotIn(1, [identity.pid for identity in snapshot])
        self.assertEqual(app.check_path_drift(None, app.RULES), [])

    def test_121_doctor_shared_body_name_chooses_closest_config_only_for_advice(self):
        rules = {"A": ("C:\\One\\Old\\", ()), "B": ("D:\\Two\\Old\\", ())}
        inventory = {"A": ("shared.exe",), "B": ("shared.exe",)}
        snapshot = app._processes_from_rows([
            {"pid": 1, "born": "a", "name": "shared.exe", "path": r"D:\Two\New\shared.exe"}])
        with patch.object(app, "DOCTOR_BODY_EXES", inventory):
            row, = app.check_path_drift(snapshot, rules)
            self.assertIn("最接近的配置游戏=B", row.message)
            rules["B"] = ("D:\\Two\\New\\", ())
            self.assertEqual(app.check_path_drift(snapshot, rules), [])
        self.assertFalse(snapshot)

    def test_122_doctor_drift_integration_preserves_snapshot_and_only_lists(self):
        with tempfile.TemporaryDirectory() as folder:
            root, api, output = Path(folder), Mock(), io.StringIO()
            (root / "logs").mkdir()
            (root / "DailyHelperDesktop").mkdir()
            (root / "DailyHelperDesktop" / "active-window.txt").write_text("fixture", encoding="utf-8")
            api.call.return_value = self.payload()
            snapshot = app._processes_from_rows([
                {"pid": 1, "born": "a", "name": "Client-Win64-Shipping.exe",
                 "path": r"D:\GAME\Wuthering Waves\3.1.0.0\Client-Win64-Shipping.exe"}])
            before = repr(snapshot.__dict__)
            with patch.dict(app.os.environ, {"LOCALAPPDATA": str(root)}), \
                    patch.object(app, "now_jst", return_value=datetime(2026, 11, 7, 12, tzinfo=app.JST)), \
                    patch.object(app, "HelperHTTP", return_value=api), \
                    patch.object(app, "process_snapshot", return_value=snapshot) as scan, \
                    patch.object(app, "Store", side_effect=AssertionError("Store forbidden")), \
                    patch.object(app, "Engine", side_effect=AssertionError("Engine forbidden")), \
                    patch.object(app, "Tracker", side_effect=AssertionError("Tracker forbidden")), \
                    patch.object(app, "atomic_text", side_effect=AssertionError("write forbidden")), \
                    redirect_stdout(output):
                self.assertEqual(app.doctor(root), 0)
            self.assertIn("[WARN] 路径漂移疑似", output.getvalue())
            self.assertIn("当前匹配 | 未命中游戏", output.getvalue())
            self.assertFalse(snapshot)
            self.assertEqual(repr(snapshot.__dict__), before)
            scan.assert_called_once_with()
            api.call.assert_called_once_with("list")


    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_123_doctor_healthy_fixture_has_eleven_ok_one_log_warn_and_exit_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            root, api, output = Path(folder), Mock(), io.StringIO()
            logs = root / "logs"
            logs.mkdir()
            for name in ("auto_daily.jsonl", "events.jsonl", "auto_daily.jsonl.tmp"):
                (logs / name).write_text(
                    '{"end":"2026-11-07","action":"marked","reason":"readback_true"}\n', encoding="utf-8")
            (root / "DailyHelperDesktop").mkdir()
            (root / "DailyHelperDesktop" / "active-window.txt").write_text("fixture", encoding="utf-8")
            before = {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
                      for p in root.rglob("*") if p.is_file()}
            api.call.return_value = self.payload()
            with patch.dict(app.os.environ, {"LOCALAPPDATA": str(root)}), \
                    patch.object(app, "RULES", {name: (str(root), ()) for name in app.RULES}), \
                    patch.object(app, "now_jst", return_value=datetime(2026, 11, 7, 12, tzinfo=app.JST)), \
                    patch.object(app, "HelperHTTP", return_value=api), \
                    patch.object(app, "process_snapshot", return_value=app.ProcessSnapshot()) as scan, \
                    patch.object(app, "probe_watch_lock", return_value=("occupied", "")), \
                    patch.object(app, "Store", side_effect=AssertionError("Store forbidden")), \
                    patch.object(app, "Engine", side_effect=AssertionError("Engine forbidden")), \
                    patch.object(app, "Tracker", side_effect=AssertionError("Tracker forbidden")), \
                    patch.object(app, "atomic_text", side_effect=AssertionError("write forbidden")), \
                    patch.object(app.sys, "argv", ["auto_daily.py", "--doctor"]), \
                    patch.object(app.doctor, "__defaults__", (root,)), redirect_stdout(output):
                self.assertEqual(app.main(), 0)
            lines = output.getvalue().splitlines()
            row, = [line for line in lines if "] 日志 |" in line]
            self.assertTrue(row.startswith("[WARN]"), row)
            self.assertIn("已验：目录/主日志/events/临时文件 中 4 项，未验：无 0 项", row)
            # 汇总里的 OK 数量随 RULES 条目数变化（原基准：5 个游戏 → 11 项 OK）
            expected_ok = 11 - 5 + len(app.RULES)
            self.assertIn(f"[WARN] 汇总 | OK={expected_ok} WARN=1 FAIL=0 | 退出码=0", lines)
            self.assertEqual(sum(line.startswith("[OK]") for line in lines), expected_ok)
            scan.assert_called_once_with()
            api.call.assert_called_once_with("list")
            self.assertEqual(before, {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
                                      for p in root.rglob("*") if p.is_file()})
            print("  --doctor (healthy synthetic environment): " + row)
            print("  " + lines[-2])

    @unittest.skipUnless(app.os.name == "nt", "Windows sharing probe")
    def test_124_doctor_known_stable_share_blind_spots_never_claim_ok(self):
        # r7-r2: these permissions can be obtained while real append/rename would
        # fail. Keep the same holder alive throughout the probe; do not write.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("auto_daily.jsonl", "events.jsonl", "auto_daily.jsonl.tmp"):
                (root / name).write_bytes(b"sentinel")
            before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()}
            kernel = app._doctor_file_api()
            for target, access, share in (("events.jsonl", 0x10000, 7),
                                          ("auto_daily.jsonl.tmp", 0x80000000, 3)):
                with self.subTest(target=target):
                    handle = kernel.CreateFileW(str(root / target), access, share, None, 3, 0, None)
                    self.assertNotIn(handle, (None, app.INVALID_HANDLE_VALUE))
                    try:
                        row = app.check_logs_writable(*app.probe_logs_writable(root))
                        self.assertEqual(row.level, "WARN")
                        self.assertIn("已验：目录/主日志/events/临时文件 中 4 项", row.message)
                        self.assertIn("无法证明第三方持锁时真实日志仍可写", row.message)
                        self.assertEqual(app.doctor_exit_code([row]), 0)
                    finally:
                        self.assertTrue(kernel.CloseHandle(handle))
            self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()})


class PlaytimeTracking(unittest.TestCase):
    """时长统计、瓦洛兰特只认 Riot Client、崩溃后回收未结束会话。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        (self.root / "logs").mkdir()
        self.store = app.Store(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_p1_riot_client_matches_but_game_process_never_does(self):
        self.assertEqual(app.match_game(r"D:\Riot Games\Riot Client\RiotClientServices.exe"), "瓦洛兰特")
        self.assertIsNone(app.match_game(r"D:\Riot Games\VALORANT\live\VALORANT-Win64-Shipping.exe"))
        self.assertIsNone(app.match_game(r"D:\Riot Games\Riot Client\RiotClientCrashHandler.exe"))
        self.assertEqual(app.TRACK_ONLY, {"瓦洛兰特"})
        self.assertNotIn("瓦洛兰特", app.RULES)

    @unittest.skipUnless(os.name == "nt", "Windows collector")
    def test_p9_collector_never_opens_riot_game_processes(self):
        api = FakeWin32([
            {"pid": 11, "name": "VALORANT.exe", "path": r"D:\Riot Games\VALORANT\VALORANT.exe"},
            {"pid": 12, "name": "VALORANT-Win64-Shipping.exe"},
            {"pid": 13, "name": "RiotClientServices.exe", "path": app.RIOT_CLIENT},
        ])
        with patch.object(app, "_win32_api", return_value=api):
            snapshot = app.process_snapshot()
        self.assertTrue(snapshot.complete)
        self.assertEqual(set(api.opened), {100013})
        self.assertEqual(list(snapshot.values()), [("瓦洛兰特", app.RIOT_CLIENT)])

    def test_p2_track_only_records_time_without_any_command(self):
        api = Mock()
        engine = app.Engine(self.store, api, self.root / "state.json")
        start = app.now_jst()
        row = engine.session("瓦洛兰特", "RiotClientServices.exe", start,
                             start + timedelta(seconds=600), 600)
        self.assertEqual(row["action"], "tracked")
        self.assertEqual(api.call.call_count, 0)
        self.assertEqual(self.store.data["playtime"]["瓦洛兰特"]["total_s"], 600.0)
        self.assertEqual(self.store.data["playtime"]["瓦洛兰特"]["sessions"], 1)

    def test_p3_recovering_heartbeat_adds_time_and_drops_short_sessions(self):
        path = app.heartbeat_path(self.root)
        last = app.now_jst()
        path.write_text(json.dumps({
            "鸣潮": {"start": (last - timedelta(seconds=900)).isoformat(), "last": last.isoformat()},
            "短会话": {"start": (last - timedelta(seconds=30)).isoformat(), "last": last.isoformat()},
        }, ensure_ascii=False), encoding="utf-8")
        recovered = app.recover_open_sessions(self.store)
        self.assertEqual([row["game"] for row in recovered], ["鸣潮"])
        self.assertAlmostEqual(self.store.data["playtime"]["鸣潮"]["total_s"], 900, delta=3)
        self.assertNotIn("短会话", self.store.data["playtime"])
        self.assertFalse(path.exists())

    def test_p5_heartbeat_recovery_is_idempotent_after_cleanup_failure(self):
        path = app.heartbeat_path(self.root)
        last = app.now_jst()
        start = last - timedelta(seconds=300)
        heartbeat = json.dumps({"鸣潮": {"start": start.isoformat(), "last": last.isoformat(),
                                         "duration_s": 240}})
        path.write_text(heartbeat, encoding="utf-8")
        with patch.object(Path, "unlink", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                app.recover_open_sessions(self.store)
        reopened = app.Store(self.root)
        self.assertEqual(app.recover_open_sessions(reopened), [])
        self.assertEqual(reopened.data["playtime"]["鸣潮"]["total_s"], 240)
        self.assertEqual(reopened.data["sessions"], [])

    def test_p6_stale_heartbeat_cannot_replay_closed_or_discarded_sessions(self):
        engine = app.Engine(self.store, Mock(), self.root / "state.json")
        path = app.heartbeat_path(self.root)
        tracker = app.Tracker(engine, 600, heartbeat_path=path)
        start = app.now_jst()
        running = {(42, "born", "riotclientservices.exe"): ("瓦洛兰特", app.RIOT_CLIENT)}
        tracker.poll(running, start, 0)
        tracker.poll(running, start + timedelta(seconds=240), 240)
        stale = path.read_text(encoding="utf-8")
        tracker.poll({}, start + timedelta(seconds=250), 250)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {})
        path.write_text(stale, encoding="utf-8")
        self.assertEqual(app.recover_open_sessions(app.Store(self.root)), [])
        self.assertEqual(self.store.data["playtime"]["瓦洛兰特"]["sessions"], 1)

    def test_p7_first_new_session_keeps_legacy_totals(self):
        start = app.now_jst()
        end = start + timedelta(seconds=300)
        self.store.data["sessions"].append({"action": "failed", "game": "鸣潮", "duration_s": 300,
                                            "start": start.isoformat(), "end": end.isoformat()})
        app.Engine(self.store, Mock(), self.root / "state.json").session(
            "瓦洛兰特", app.RIOT_CLIENT, start, end, 300)
        self.assertEqual(self.store.data["playtime"]["鸣潮"]["total_s"], 300)
        self.assertEqual(self.store.data["playtime"]["瓦洛兰特"]["last"], end.isoformat())

    def test_p8_missing_optional_game_warns_but_other_list_errors_fail(self):
        day = "2026-11-07"
        games = [{"name": name, "id": str(i), "daily": False}
                 for i, name in enumerate(app.RULES)]
        def level(rows):
            return app.check_helper_payload({"ok": True, "games": rows, "day": day},
                                            app.RULES, day).level
        self.assertEqual(level(games), "OK")
        # 任选一个游戏标为「可选」，它缺席只报 WARN；把别的游戏漏掉仍是 FAIL
        optional = next(iter(app.RULES))
        with patch.object(app, "OPTIONAL_TERMINAL_GAMES", {optional}):
            self.assertEqual(level([row for row in games if row["name"] != optional]), "WARN")
            self.assertEqual(level(games[1:]) if games[0]["name"] != optional else "FAIL", "FAIL")
        self.assertEqual(level(games[1:]), "FAIL")
        self.assertEqual(level(games + [{"id": "a", "name": "其他", "daily": False},
                                        {"id": "b", "name": "其他", "daily": False}]), "FAIL")

    def test_p4_endpoint_json_wins_but_dead_pid_falls_back_to_legacy_file(self):
        endpoint = self.root / "PersonalGRhineTerminal" / "assistant-endpoint.json"
        endpoint.parent.mkdir()
        endpoint.write_text(json.dumps({"port": 28188, "token": "a" * 32, "pid": os.getpid()}), encoding="utf-8")
        connection = self.root / "active-window.txt"
        connection.write_text("http://127.0.0.1:30000/" + "b" * 32, encoding="utf-8")
        helper = app.HelperHTTP(connection, endpoint_file=endpoint)
        self.assertEqual(helper._connection(), ("http://127.0.0.1:28188", "a" * 32))
        for invalid in ([], {"port": 28188, "token": "a" * 32},
                        {"port": 28188, "token": "a" * 32, "pid": True}):
            endpoint.write_text(json.dumps(invalid), encoding="utf-8")
            self.assertTrue(helper._connection()[0].endswith("b" * 32))
        endpoint.write_text(json.dumps({"port": 28188, "token": "a" * 32, "pid": 1234}), encoding="utf-8")
        with patch.object(app, "process_alive", return_value=False):
            # 旧式文件把 token 放在路径里（旧宿主按 /TOKEN/api/... 提供服务）
            self.assertEqual(helper._connection(),
                             ("http://127.0.0.1:30000/" + "b" * 32, "b" * 32))


class Results(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        self.stream.writeln("PASS " + test._testMethodName)
        if hasattr(test, "snapshot_handles"):
            before, after = test.snapshot_handles
            self.stream.writeln(f"  200 real snapshots: handles {before} -> {after} (delta {after - before})")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.stream.writeln("FAIL " + test._testMethodName)

    def addError(self, test, err):
        super().addError(test, err)
        self.stream.writeln("ERROR " + test._testMethodName)


class SteamPlaytimeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        root_patch = patch.object(steam, "steam_root", return_value=self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.cache = self.root / "data" / "steam-names.json"
        self.write("config/loginusers.vdf",
                   '"users" { "76561197960265729" { "MostRecent" "1" } }')

    def write(self, path, data):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")

    def account(self, id, times):
        apps = " ".join(f'"{key}" {{ "Playtime" "{value}" }}' for key, value in times.items())
        body = '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { '
        self.write(f"userdata/{id}/config/localconfig.vdf", body + apps + " } } } } }")

    def test_vdf_quotes_comments_and_errors(self):
        self.assertEqual(steam.parse_vdf(r'"Root" { "Name" "a \"b\" { c }" } // tail'),
                         {"root": {"name": 'a "b" { c }'}})
        for broken in ('"root" { "key"', '}', '"key" garbage'):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                steam.parse_vdf(broken)

    def test_categories_and_primary_account_sources(self):
        self.account("1", {"730": 30, "431960": 90, "20": 60, "24": 0})
        self.account("2", {"730": 90, "25": 30})
        # 无名条目现在会被隐藏，这里给它们起名以保证行能出现在列表里
        self.write("data/steam-names.json", json.dumps({
            "730": {"name": "Counter-Strike 2", "lang": "schinese"},
            "431960": {"name": "Wallpaper Engine", "lang": "schinese"},
            "20": {"name": "Solo A", "lang": "schinese"},
            "25": {"name": "Solo B", "lang": "schinese"}}, ensure_ascii=False))
        self.write("userdata/3/config/localconfig.vdf", '"broken" {')
        # 本用例测的是多账号聚合与来源标注，白名单置空 = 统计全部账号
        with patch.object(steam, "STEAM_ACCOUNT_IDS", ()):
            result, totals = steam.read_steam_playtime(self.cache, allow_network=False)
        self.assertEqual(totals, {"solo": 90, "live": 120, "excluded": 90})
        self.assertEqual(result["stats"]["appidCount"], 5)
        self.assertEqual(result["accounts"], [{"id": "1", "primary": True},
                                              {"id": "2", "primary": False}])
        self.assertEqual(result["live"][0]["sources"], [
            {"id": "1", "primary": True, "hours": 0.5},
            {"id": "2", "primary": False, "hours": 1.5}])
        self.assertIn("account 3", result["note"])

    def test_whitelist_keeps_only_named_account_and_reports_skip(self):
        self.account("1", {"730": 60})
        self.account("2", {"730": 120})
        with patch.object(steam, "STEAM_ACCOUNT_IDS", ("2",)):
            result, totals = steam.read_steam_playtime(self.cache, allow_network=False)
        self.assertEqual(totals["live"], 120)          # 只算 2 号
        self.assertEqual([row["id"] for row in result["accounts"]], ["2"])
        self.assertIn("skipped non-primary account 1", result["note"])

    def test_name_resolution_precedence_cache_and_rate_limit(self):
        self.account("1", {"11": 120, "12": 120, "13": 120, "14": 120})
        self.write("steamapps/appmanifest_11.acf", '"AppState" { "name" "Installed" }')
        self.write("data/steam-names.json",
                   '{"12":{"name":"Cached","lang":"schinese"}}')
        info = {"name": "商店十一", "lang": "schinese", "type": "game", "cats": []}
        with patch.object(steam, "STEAM_ACCOUNT_IDS", ()), \
                patch.object(steam, "store_details", side_effect=[info, None, None]) as fetch, \
                patch.object(steam.time, "sleep") as delay:
            result, _ = steam.read_steam_playtime(self.cache)
        # 12 命中中文缓存不再查询；11/13/14 各查一次，查询之间限速一次
        self.assertEqual([call.args for call in fetch.call_args_list], [("11",), ("13",), ("14",)])
        self.assertEqual(delay.call_count, 2)
        self.assertEqual([r["name"] for r in result["solo"]], ["商店十一", "Cached"])
        # 中文名与清单英文名不同 → 附带原名供前端 tooltip
        self.assertEqual(result["solo"][0]["nameEn"], "Installed")
        # 查不到名字的两条被隐藏，只计数
        self.assertEqual(result["unnamed"]["count"], 2)
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8"))["11"], info)

    def test_report_contract_and_identical_utf8_exports(self):
        self.account("1", {"730": 59, "20": 61, "431960": 300})
        store = app.Store(self.root)
        app.add_playtime(app.playtime_totals(store), "鸣潮", 3600, "start", "end")
        local, web = self.root / "local", self.root / "web" / "data"
        with patch.object(steam, "STEAM_ACCOUNT_IDS", ()), \
                patch.object(app, "TERMINAL_DATA_DIR", local), \
                patch.object(app, "TERMINAL_WEB_DATA_DIR", web):
            report, success = app.write_playtime(store, allow_network=False)
        self.assertTrue(success)
        self.assertEqual(report["totals"], {"trackedHours": 1.0, "soloHours": 1.02, "liveHours": 0.98})
        self.assertEqual(report["games"], report["tracked"])
        self.assertEqual(report["totalHours"], report["totals"]["trackedHours"])
        self.assertEqual(report["tracked"], [{"game": "鸣潮", "hours": 1.0,
                                              "sessions": 1, "last": "end"}])
        self.assertTrue(report["generatedAt"].endswith("+09:00"))
        payload = (local / "playtime.json").read_bytes()
        self.assertEqual(payload, (web / "playtime.json").read_bytes())
        self.assertEqual(json.loads(payload.decode("utf-8")), report)

    def test_export_failure_keeps_second_destination(self):
        store = app.Store(self.root)
        self.write("blocked", "file")
        web = self.root / "web"
        with patch.object(app, "TERMINAL_DATA_DIR", self.root / "blocked"), \
                patch.object(app, "TERMINAL_WEB_DATA_DIR", web), \
                patch.object(store, "diagnostic") as diagnostic:
            _, success = app.write_playtime(store)
        self.assertFalse(success)
        self.assertTrue((web / "playtime.json").exists())
        self.assertEqual(diagnostic.call_args.args, ("playtime_export_failed",))
        self.assertEqual(diagnostic.call_args.kwargs["stage"], "local")

    def test_watcher_throttle_and_forced_refresh(self):
        export = app.PlaytimeExport(app.Store(self.root))
        with patch.object(app.time, "monotonic", side_effect=[0, 59, 60, 61, 62]), \
                patch.object(app, "write_playtime", return_value=(None, False)) as write:
            export.refresh()
            export.refresh()
            export.refresh()
            export.refresh(force=True)
            export.refresh()
        self.assertEqual(write.call_count, 3)
        self.assertEqual(write.call_args.kwargs, {"allow_network": False})

    def test_session_end_refreshes_after_accounting_and_diagnostic(self):
        actions = Mock()
        engine = Mock()
        engine.session = actions.session
        engine.store.diagnostic = actions.diagnostic
        actions.session.return_value = dict(session_id="test", start="start", end="end",
                                            duration_s=120, day_key="day", action="tracked", reason="")
        now = app.now_jst()
        tracker = app.Tracker(engine, 30, on_session_ended=actions.refresh)
        tracker.end(app.Session("鸣潮", "test.exe", now, 0, now, 120))
        self.assertEqual([call[0] for call in actions.mock_calls],
                         ["session", "diagnostic", "refresh"])


def run():
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(case)
                               for case in (Acceptance, DoctorTests, PlaytimeTracking, SteamPlaytimeTests))
    result = unittest.TextTestRunner(verbosity=0, resultclass=Results, stream=__import__("sys").stdout).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(run())
