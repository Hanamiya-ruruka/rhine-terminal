#!/usr/bin/env python3
"""Manual foreground game-session watcher. Python 3.11+, standard library only."""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import errno
import http.client
import json
import math
import ntpath
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import sys
from threading import Thread
import time
from typing import NamedTuple
import urllib.error
import urllib.parse
import urllib.request

from steam_playtime import (read_steam_playtime, write_json_atomic, steam_root,
                            steam_libraries, read_vdf)

ROOT = Path(__file__).resolve().parent
TERMINAL_DATA_DIR = Path(os.environ["LOCALAPPDATA"]) / "PersonalGRhineTerminal" if os.environ.get("LOCALAPPDATA") else None
# 默认写入当前仓库的 web/data 目录（由 tools/auto-daily 向上两级定位）
TERMINAL_WEB_DATA_DIR = ROOT.parent.parent / "web" / "data"
PLAYTIME_REFRESH_SECONDS = 60
JST = timezone(timedelta(hours=9))
MIN_SECONDS = 120
RESET_GUARD_SECONDS = 60
RULES = {
    "绝区零": ("D:\\GAME\\ZZZ\\HoYoPlay\\games\\ZenlessZoneZero Game\\",
              (r"D:\GAME\ZZZ\HoYoPlay\launcher.exe",)),
    "鸣潮": ("D:\\GAME\\Wuthering Waves\\Wuthering Waves Game\\Client\\Binaries\\Win64\\",
            (r"D:\GAME\Wuthering Waves\launcher.exe",)),
    "星救": ("D:\\SteamLibrary\\steamapps\\common\\StarSavior\\", ()),
    "异象回声": ("D:\\SteamLibrary\\steamapps\\common\\Echoes of Vision\\", ()),
    "蓝色星原": ("D:\\GAME\\YostarGames\\AZUPRO_JP\\",
                (r"D:\GAME\YostarGames\AZUPRO_JP_Gamelauncher\AZUPRO_JP_Gamelauncher.exe",)),
}
# Riot Client provides client uptime only, independent of which Riot title is open.
RIOT_CLIENT = r"D:\Riot Games\Riot Client\RiotClientServices.exe"
TRACK_ONLY = frozenset({"瓦洛兰特"})
# 会计入时长账本的全部游戏名：有日常的 + 只计时的
TRACKED_GAMES = frozenset(RULES) | TRACK_ONLY
# 可选游戏：名字写进这里后，终端列表缺它只报 WARN。目前没有可选游戏。
OPTIONAL_TERMINAL_GAMES = frozenset()
NAME_FALLBACK = {"zenlesszonezero.exe": "绝区零", "azurpromiliajp.exe": "蓝色星原"}
LAUNCHER_NAMES = frozenset({"launcher.exe", "hoyoplay.exe"})


def now_jst():
    return datetime.now(JST)


def day_key(now):
    if now.tzinfo is None:
        raise ValueError("An aware timestamp is required")
    return (now.astimezone(JST) - timedelta(hours=5)).date().isoformat()


def reset_seconds(now):
    reset = now.astimezone(JST).replace(hour=5, minute=0, second=0, microsecond=0)
    if reset <= now:
        reset += timedelta(days=1)
    return (reset - now).total_seconds()


def normalized_path(path):
    return ntpath.normcase(ntpath.normpath(path))


def match_game(path):
    if not isinstance(path, str) or not ntpath.isabs(path):
        return None
    path = normalized_path(path)
    if ntpath.basename(path).casefold() in LAUNCHER_NAMES:
        return None
    if path == normalized_path(RIOT_CLIENT):
        return "瓦洛兰特"
    if any(path == normalized_path(p) for _, blocked in RULES.values() for p in blocked):
        return None
    for name, (prefix, _) in RULES.items():
        if path.startswith(normalized_path(prefix).rstrip("\\") + "\\"):
            return name
    return None


def match_process(path, name):
    """Readable paths are authoritative; only missing paths allow exact names."""
    if name.casefold() in LAUNCHER_NAMES:
        return None, None
    if path is None or path == "":
        game = NAME_FALLBACK.get(name.casefold())
        return game, "name_fallback" if game else None
    game = match_game(path)
    return game, "path" if game else None


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def read_state(path):
    state = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(state, dict) or not isinstance(state.get("games"), list):
        raise ValueError("Invalid helper state")
    return state


class Unavailable(Exception):
    def __init__(self, reason, sent=False, *, failure=None):
        super().__init__(reason)
        self.sent = sent
        # Diagnostic category only: never changes the watcher's retry decisions.
        self.failure = failure


class Unauthorized(Exception):
    pass


class ProtocolError(Exception):
    def __init__(self, reason, retryable=False):
        super().__init__(reason)
        self.retryable = retryable


def definitely_not_sent(exc):
    """Only typed failures before opening a response prove no HTTP request was sent.

    Generic SSL errors, timeouts and resets are ambiguous; never infer from text.
    Certificate verification fails during the initial handshake, before HTTP data.
    The current loopback endpoint is HTTP, so TLS is only a defensive classification.
    """
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    return (isinstance(reason, (ConnectionRefusedError, socket.gaierror,
                                ssl.SSLCertVerificationError))
            or isinstance(reason, OSError)
            and (reason.errno == errno.ECONNREFUSED
                 or getattr(reason, "winerror", None) == 10061))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_ENDPOINT_UNSET = object()


def default_endpoint_file():
    """新版 Personal G Rhine Terminal 的发现文件（JSON，token 只走请求头）。"""
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) / "PersonalGRhineTerminal" / "assistant-endpoint.json" if local else None


class HelperHTTP:
    def __init__(self, connection_file, opener=None, endpoint_file=_ENDPOINT_UNSET):
        self.connection_file = connection_file
        # endpoint_file=None 表示禁用 JSON 发现（测试用）；不传则用默认位置
        self.endpoint_file = (default_endpoint_file() if endpoint_file is _ENDPOINT_UNSET
                              else endpoint_file)
        # Ignore proxies and refuse redirects so the desktop token stays on loopback.
        self.opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect())

    def _connection(self):
        """优先新宿主的 JSON 发现文件，回退旧版的 active-window.txt。

        新版：http://127.0.0.1:PORT + 头部 token（路径不带 token）
        旧版：http://127.0.0.1:PORT/TOKEN + 头部 token
        """
        if self.endpoint_file:
            try:
                info = json.loads(Path(self.endpoint_file).read_text(encoding="utf-8-sig"))
                if not isinstance(info, dict):
                    raise ValueError
                port, token, pid = info.get("port"), info.get("token"), info.get("pid")
                if (type(port) is int and 20000 <= port <= 65000
                        and isinstance(token, str)
                        and re.fullmatch(r"[0-9a-fA-F]{32}", token)
                        and (type(pid) is int and 0 < pid <= 0xffffffff and process_alive(pid))):
                    return f"http://127.0.0.1:{port}", token
            except (OSError, ValueError, UnicodeError, TypeError):
                pass
        try:
            address = self.connection_file.read_text(encoding="utf-8-sig").strip()
        except OSError as exc:
            raise Unavailable("connection_file_missing_or_unreadable", failure=(
                "file_missing" if isinstance(exc, FileNotFoundError) else "file_unreadable")) from None
        except UnicodeError:
            raise ProtocolError("invalid_connection_file") from None
        try:
            parsed = urllib.parse.urlsplit(address)
            token = parsed.path.strip("/")
            if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                    or not parsed.port or parsed.username or parsed.password
                    or parsed.query or parsed.fragment
                    or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", token)):
                raise ValueError
        except ValueError:
            raise ProtocolError("invalid_connection_file") from None
        return address.rstrip("/"), token

    def call(self, action, **fields):
        address, token = self._connection()
        body = {"requestId": secrets.token_hex(16), "action": action, **fields}
        req = urllib.request.Request(
            address.rstrip("/") + "/api/assistant/command",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8",
                     "X-Desktop-Token": token}, method="POST")
        opened = False
        try:
            with self.opener.open(req, timeout=8) as response:
                opened = True
                result = json.loads(response.read().decode("utf-8-sig"))
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise Unauthorized("http_" + str(exc.code)) from None
            if exc.code >= 500:
                raise Unavailable("http_server_error", sent=True) from None
            raise ProtocolError("http_" + str(exc.code)) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            sent = opened or not definitely_not_sent(exc)
            cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            timeout = (isinstance(cause, TimeoutError) or isinstance(cause, OSError)
                       and (cause.errno == errno.ETIMEDOUT or getattr(cause, "winerror", None) == 10060))
            raise Unavailable("transport_outcome_unconfirmed" if sent else
                              "connection_not_sent", sent=sent,
                              failure="timeout" if timeout else "connection") from None
        except (ValueError, UnicodeError):
            raise ProtocolError("invalid_http_response") from None
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise ProtocolError("invalid_http_response")
        return result


class Store:
    """Durable queue/ledger; session JSONL is a projection (one line per session)."""
    def __init__(self, root):
        self.root = root
        self.path = root / "data" / "runtime.json"
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
            if (self.data.get("schema") != 1
                    or not isinstance(self.data.get("sessions"), list)
                    or not isinstance(self.data.get("ledger"), dict)):
                raise ValueError("Invalid runtime data; refusing to discard safety history")
        else:
            self.data = {"schema": 1, "sessions": [], "ledger": {}, "auth_stopped": False}

    def ledger(self, game, key):
        return self.data["ledger"].setdefault(key, {}).setdefault(game, {})

    def save(self):
        atomic_text(self.path, json.dumps(self.data, ensure_ascii=False, indent=2) + "\n")
        atomic_text(self.root / "logs" / "auto_daily.jsonl", "".join(
            json.dumps(row, ensure_ascii=False) + "\n" for row in self.data["sessions"]))

    def diagnostic(self, event, **fields):
        row = {"time": now_jst().isoformat(), "event": event, **fields}
        path = self.root / "logs" / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)


def add_playtime(play, game, duration, start, end):
    entry = play.setdefault(game, {"total_s": 0.0, "sessions": 0, "first": start, "last": end})
    entry["total_s"] = round(entry["total_s"] + duration, 3)
    entry["sessions"] += 1
    entry["first"] = min(entry["first"], start)
    entry["last"] = max(entry["last"], end)


def playtime_totals(store):
    if "playtime" not in store.data:
        play = {}
        for row in store.data["sessions"]:
            # A rejected terminal command does not invalidate the observed duration.
            if row["action"] != "skipped" and row["duration_s"] >= MIN_SECONDS:
                add_playtime(play, row["game"], row["duration_s"], row["start"], row["end"])
        store.data["playtime"] = play
    return store.data["playtime"]


def heartbeat_path(root):
    return root / "data" / "open-sessions.json"


def recover_open_sessions(store):
    """Recover observed duration only, with receipts persisted alongside totals."""
    path = heartbeat_path(store.root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (ValueError, UnicodeError):
        data = None
    recovered = []
    receipts = store.data.get("playtime_recovery_receipts", {})
    finalized = {(row["game"], row["start"]) for row in store.data["sessions"]}
    for game, info in (data.items() if isinstance(data, dict) else ()):
        receipt = json.dumps([game, info.get("start")]) if isinstance(info, dict) else None
        if receipt is None or receipt in receipts:
            continue
        try:
            start = datetime.fromisoformat(info["start"])
            last = datetime.fromisoformat(info["last"])
            duration = info.get("duration_s", (last - start).total_seconds())
        except (KeyError, TypeError, ValueError):
            continue
        if ((game, info["start"]) in finalized or type(duration) not in (int, float)
                or not math.isfinite(duration) or duration < MIN_SECONDS):
            continue
        add_playtime(playtime_totals(store), game, duration, start.isoformat(), last.isoformat())
        receipts[receipt] = True
        recovered.append({"game": game, "duration_s": round(duration, 3)})
    if recovered:
        store.data["playtime_recovery_receipts"] = receipts
        store.save()
    path.unlink(missing_ok=True)
    if recovered:
        store.diagnostic("playtime_recovered", count=len(recovered), games=recovered)
    return recovered


class Engine:
    def __init__(self, store, api, state_path, clock=now_jst):
        self.store, self.api, self.state_path, self.clock = store, api, state_path, clock

    def validate_snapshot(self, snapshot, source):
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("games"), list):
            self.store.diagnostic("invalid_game_list", source=source)
            raise ProtocolError("invalid_game_list", retryable=True)
        valid, invalid, ids = [], [], Counter()
        for index, game in enumerate(snapshot["games"]):
            # Count IDs even on discarded rows: filtering must not hide duplicates.
            if isinstance(game, dict) and isinstance(game.get("id"), str):
                ids[game["id"]] += 1
            if (not isinstance(game, dict)
                    or not isinstance(game.get("id"), str) or not game["id"]
                    or not isinstance(game.get("name"), str) or not game["name"]
                    or type(game.get("daily")) is not bool):
                invalid.append(index)
            else:
                valid.append(game)
        if invalid:
            self.store.diagnostic("invalid_game_elements_discarded", source=source,
                                  indexes=invalid, count=len(invalid))
            if not valid:
                raise ProtocolError("invalid_game_list", retryable=True)
        return {**snapshot, "games": valid, "_id_counts": ids,
                "_malformed_games": bool(invalid)}

    def unique_target(self, row, snapshot, target_id):
        if snapshot["_id_counts"].get(target_id, 0) != 1:
            self.finish(row, "skipped", "id_ambiguous")
            return False
        if snapshot["_malformed_games"]:
            self.finish(row, "skipped", "invalid_game_elements")
            return False
        return True

    def daily_log_records(self, key):
        path = self.state_path.with_name("daily-log.json")
        try:
            records = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            return {}, "daily_log_missing"
        except OSError:
            return {}, "daily_log_unreadable"
        except (ValueError, RecursionError):
            return {}, "daily_log_invalid"
        if not isinstance(records, list):
            return {}, "daily_log_invalid"

        month_day = tuple(map(int, key.split("-")[1:]))
        latest = {}
        for record in records:
            if not isinstance(record, dict):
                continue
            name, date = record.get("name"), record.get("date")
            if not isinstance(name, str) or name not in RULES:
                continue
            if not isinstance(date, str) or not re.fullmatch(r"[0-9]{1,2}/[0-9]{1,2}", date):
                continue
            if tuple(map(int, date.split("/"))) == month_day:
                latest[name] = record
        return latest, "daily_log_no_matching_record"

    def observe(self, snapshot, key_field):
        key = snapshot.get(key_field)
        # Never mistake the daily reset (True -> False) for manual cancellation.
        if key != day_key(self.clock()):
            return
        records, fallback_reason = self.daily_log_records(key)
        for game in snapshot.get("games", []):
            if game.get("name") not in RULES or type(game.get("daily")) is not bool:
                continue
            name = game["name"]
            ledger = self.store.ledger(name, key)
            record = records.get(name, {})
            act = record.get("act")
            if game["daily"] or act == "完成":
                ledger["seen_true"] = True
            if act == "完成":
                ledger["cancelled"] = False
            elif act == "撤销" and record.get("src", "user") in ("user", "auto"):
                ledger["cancelled"] = record.get("src") != "auto"
            elif not game["daily"] and ledger.get("seen_true"):
                if not ledger.get("cancelled"):
                    self.store.diagnostic("cancel_unattributed", game=name, day_key=key,
                                          reason="daily_log_invalid_record" if record else fallback_reason)
                ledger["cancelled"] = True

    def observe_disk(self):
        try:
            state = self.validate_snapshot(read_state(self.state_path), "disk_observation")
        except (OSError, ValueError, UnicodeError, ProtocolError):
            return
        before = json.dumps(self.store.data["ledger"], sort_keys=True)
        self.observe(state, "lastDailyKey")
        if json.dumps(self.store.data["ledger"], sort_keys=True) != before:
            self.store.save()

    def session(self, game, exe, start, end, duration, reason=None, match="path"):
        row = {"session_id": secrets.token_hex(16), "game": game, "exe_path": exe,
               "start": start.isoformat(), "end": end.isoformat(),
               "duration_s": round(max(0, duration), 3), "day_key": day_key(start),
               "action": "queued", "reason": "awaiting_helper", "readback": None,
               "phase": "write", "replayed": False, "match": match}
        if reason or duration < MIN_SECONDS:
            row.update(action="skipped", reason=reason or f"duration_below_{MIN_SECONDS}")
        else:
            if game in TRACK_ONLY:
                # 只统计时长，不向助手发指令（该条目没有日常/周常）
                row.update(action="tracked", reason="track_only")
            add_playtime(playtime_totals(self.store), game, row["duration_s"],
                         row["start"], row["end"])
        self.store.data["sessions"].append(row)
        # Persist the event before any HTTP work; abrupt exit cannot lose the queue.
        self.store.save()
        if game not in TRACK_ONLY:
            self.flush()
        return row

    def stop_auth(self, reason):
        if not self.store.data["auth_stopped"]:
            self.store.data["auth_stopped"] = True
            self.store.save()
            self.store.diagnostic("authorization_stopped", reason=reason)

    def list_current(self):
        result = self.api.call("list")
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise ProtocolError("invalid_http_response", retryable=True)
        if not result["ok"]:
            raise Unavailable("helper_list_rejected")
        result = self.validate_snapshot(result, "http_list")
        self.observe(result, "day")
        self.store.save()
        return result

    @staticmethod
    def finish(row, action, reason, readback=None):
        row.update(action=action, reason=reason, readback=readback)

    def process(self, row):
        key, game = row["day_key"], row["game"]
        if self.store.data["auth_stopped"]:
            self.finish(row, "failed", "authorization_stopped")
            return
        if key != day_key(self.clock()):
            self.finish(row, "skipped", "start_day_expired")
            return
        self.observe_disk()
        ledger = self.store.ledger(game, key)
        if ledger.get("cancelled"):
            self.finish(row, "skipped", "manual_cancel_detected")
            return
        result = self.list_current()  # Always list before considering a write.
        if result.get("day") != key:
            self.finish(row, "skipped", "helper_day_mismatch")
            return
        legacy_verify = row["phase"] == "verify" and row.get("target_id") is None
        if row["phase"] == "verify" and not legacy_verify:
            if not self.unique_target(row, result, row["target_id"]):
                return
        games = [g for g in result["games"] if g.get("name") == game]
        if len(games) != 1 or type(games[0].get("daily")) is not bool:
            if legacy_verify:
                self.finish(row, "failed", "legacy_row_ambiguous" if games else
                            "legacy_row_missing")
                return
            if any(result["_id_counts"][g["id"]] != 1 for g in games):
                self.finish(row, "skipped", "id_ambiguous")
                return
            self.finish(row, "failed", "missing_or_ambiguous_api_game")
            return
        current = games[0]
        if not self.unique_target(row, result, current["id"]):
            return
        if legacy_verify:
            # Old verify rows lack an ID. Bind only after name/ID validation;
            # this remains read-only recovery, never permission to resend.
            row["target_id"] = current["id"]
        if row["phase"] == "verify" and row.get("target_id") != current["id"]:
            self.finish(row, "failed", "write_outcome_unconfirmed_id_changed")
            return
        if ledger.get("cancelled"):
            self.finish(row, "skipped", "manual_cancel_detected", current["daily"])
        elif current["daily"]:
            if row["phase"] == "verify":
                ledger["confirmed"] = True
                row["outcome_unconfirmed"] = False
                self.finish(row, "marked", "readback_true", True)
            else:
                self.finish(row, "skipped", "daily_already_true", True)
        elif row["phase"] == "verify" or ledger.get("attempted"):
            # A timed-out/previous write may have applied and then been cancelled.
            self.finish(row, "failed", "write_outcome_unconfirmed_no_retry", False)
        else:
            self.write(row, ledger, current)

    def write(self, row, ledger, current):
        try:
            state = read_state(self.state_path)
        except (OSError, ValueError, UnicodeError):
            raise Unavailable("state_unavailable") from None
        state = self.validate_snapshot(state, "disk_prewrite")
        self.observe(state, "lastDailyKey")
        if ledger.get("cancelled"):
            self.finish(row, "skipped", "manual_cancel_detected")
            return
        games = [g for g in state["games"] if g.get("name") == row["game"]]
        if not self.unique_target(row, state, current["id"]):
            return
        if (len(games) != 1 or not isinstance(games[0].get("id"), str)
                or not games[0]["id"] or games[0]["id"] != current.get("id")):
            self.finish(row, "failed", "state_api_id_mismatch_or_ambiguous_name")
            return
        if state.get("lastDailyKey") != row["day_key"]:
            raise Unavailable("state_day_not_current")
        if games[0].get("daily") is True:
            self.finish(row, "skipped", "disk_daily_true")
            return
        if day_key(self.clock()) != row["day_key"]:
            self.finish(row, "skipped", "start_day_expired")
            return
        if reset_seconds(self.clock()) <= RESET_GUARD_SECONDS:
            raise Unavailable("reset_guard")
        # Reserve before sending. Only a proven unsent request releases the lock.
        ledger["attempted"] = True
        row.update(phase="verify", target_id=current["id"], outcome_unconfirmed=True,
                   retry_count=ledger.get("not_sent_failures", 0))
        self.store.save()
        try:
            response = self.api.call("set_completion", gameId=games[0]["id"],
                                     field="daily", done=True)
        except Unavailable as exc:
            if not exc.sent:
                ledger.pop("attempted", None)
                ledger["not_sent_failures"] = ledger.get("not_sent_failures", 0) + 1
                row.update(phase="write", outcome_unconfirmed=False)
                self.store.save()
            raise
        # Even a negative response can indicate applied:true/save_failed: read only.
        verified = self.list_current()
        if not self.unique_target(row, verified, current["id"]):
            return
        found = [g for g in verified["games"] if g.get("id") == games[0]["id"]]
        actual = found[0].get("daily") if len(found) == 1 else None
        if (verified.get("day") == row["day_key"] and actual is True
                and found[0]["name"] == row["game"]):
            ledger["confirmed"] = True
            row["outcome_unconfirmed"] = False
            self.finish(row, "marked", "readback_true", True)
        else:
            reason = "readback_not_true" if response["ok"] else "write_rejected_or_unconfirmed"
            self.finish(row, "failed", reason, actual)

    def flush(self):
        replayed = 0
        for row in self.store.data["sessions"]:
            if row["action"] != "queued":
                continue
            was_queued = row.get("deferred", False)
            try:
                self.process(row)
            except Unauthorized as exc:
                self.stop_auth(str(exc))
                self.finish(row, "failed", "authorization_stopped")
            except Unavailable as exc:
                reason = ("write_outcome_unconfirmed:" + str(exc)
                          if row["phase"] == "verify" else str(exc))
                row.update(reason=reason, deferred=True)
                self.store.save()
                break  # One unavailable probe per poll, not one per queued event.
            except ProtocolError as exc:
                reason = ("write_outcome_unconfirmed:" + str(exc)
                          if row["phase"] == "verify" else str(exc))
                if exc.retryable:
                    row.update(reason=reason, deferred=True)
                    self.store.save()
                    break
                self.finish(row, "failed", reason)
            if was_queued and row["action"] == "marked":
                row["replayed"] = True
                replayed += 1
            self.store.save()
        if replayed:
            self.store.diagnostic("queue_replayed", count=replayed)


TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
ERROR_NO_MORE_FILES = 18


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]


class Win32Processes:
    """Bind once, with pointer-sized handles on both 32- and 64-bit Python."""
    def __init__(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Process32FirstW": ([wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)], wintypes.BOOL),
            "Process32NextW": ([wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)], wintypes.BOOL),
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "QueryFullProcessImageNameW": ([wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                           ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4,
                                wintypes.BOOL),
            "GetExitCodeProcess": ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(kernel, name)
            function.argtypes, function.restype = arguments, result
            setattr(self, name, function)


_WIN32 = None


def _win32_api():
    global _WIN32
    if _WIN32 is None:
        _WIN32 = Win32Processes()
    return _WIN32


def process_alive(pid):
    """Reject a missing or exited PID; let authenticated loopback HTTP resolve uncertainty."""
    if os.name != "nt":
        return True
    try:
        api = _win32_api()
        handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: missing PID
        try:
            status = wintypes.DWORD()
            return not api.GetExitCodeProcess(handle, ctypes.byref(status)) or status.value == 259
        finally:
            _close_handle(api, handle)
    except (OSError, AttributeError):
        return True


def _close_handle(api, handle):
    # Never retry a failed close: the numeric handle could already be reused.
    try:
        return bool(api.CloseHandle(handle))
    except OSError:
        return False


def process_snapshot():
    """Toolhelp + limited-query handles only; no child process or third-party code."""
    if os.name != "nt":
        raise RuntimeError("Process snapshots require Windows")
    processes = ProcessSnapshot()
    processes.complete = False
    try:
        api = _win32_api()
        snapshot = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    except (OSError, AttributeError):
        return processes
    if snapshot in (None, 0, INVALID_HANDLE_VALUE):
        return processes
    rows = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        # Reuse one full-size Unicode buffer within this scan, including long paths.
        path_buffer = ctypes.create_unicode_buffer(32768)
        creation, exit_time, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        more = api.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            # Skip Riot game executables before opening any per-process handle.
            if entry.szExeFile.casefold().startswith("valorant"):
                more = api.Process32NextW(snapshot, ctypes.byref(entry))
                continue
            row = {"pid": entry.th32ProcessID, "name": entry.szExeFile, "path": "", "born": ""}
            rows.append(row)  # Even OpenProcess access denial must preserve the PID.
            try:
                handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, row["pid"])
            except OSError:
                handle = None
            if handle not in (None, 0, INVALID_HANDLE_VALUE):
                try:
                    try:
                        size = wintypes.DWORD(len(path_buffer))
                        path_buffer[0] = "\0"
                        if api.QueryFullProcessImageNameW(handle, 0, path_buffer, ctypes.byref(size)):
                            row["path"] = path_buffer.value
                    except OSError:
                        pass  # A path failure must not prevent the creation-time query.
                    try:
                        if api.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                               ctypes.byref(kernel_time), ctypes.byref(user_time)):
                            # Preserve all 100 ns bits; this is an opaque identity token.
                            ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
                            if ticks:
                                row["born"] = str(ticks)
                    except OSError:
                        pass
                finally:
                    closed = _close_handle(api, handle)
                if not closed:
                    return processes
            more = api.Process32NextW(snapshot, ctypes.byref(entry))
        # Only normal end-of-enumeration proves absence. A partial scan cannot.
        if ctypes.get_last_error() != ERROR_NO_MORE_FILES:
            return processes
        processes = _processes_from_rows(rows)
    except OSError:
        pass  # Keep an incomplete snapshot; the watcher skips interrupted sessions.
    finally:
        if not _close_handle(api, snapshot):
            processes.complete = False
    return processes


class ProcessIdentity(NamedTuple):
    """Stable liveness key; path and match route are deliberately excluded."""
    pid: int
    born: str
    name: str  # casefolded executable name


class ProcessSnapshot(dict):
    """Dict of game matches; present_pids holds all PIDs, even with zero matches."""
    def __init__(self):
        super().__init__()
        self.present_pids = set()
        self.observations = {}  # Diagnostic evidence, including rows rejected below.
        self.unreadable_identities = set()
        self.matches = {}
        self.complete = True


def parse_processes(raw):
    rows = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(rows, list):
        raise ValueError("Invalid process snapshot")
    return _processes_from_rows(rows)


def _processes_from_rows(rows):
    processes = ProcessSnapshot()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("pid"), int):
            raise ValueError("Invalid process row")
        processes.present_pids.add(row["pid"])
        path = row.get("path")
        name = row.get("name")
        # Older path-only snapshots can still identify a readable executable.
        if name is None and isinstance(path, str) and ntpath.isabs(path):
            name = ntpath.basename(path)
        born = row.get("born")
        processes.observations[row["pid"]] = {
            "name": name, "raw_name": row.get("name"), "born": born, "path": path}
        if not isinstance(name, str) or not name or not isinstance(born, str) or not born:
            continue  # No creation time: cannot rule out PID reuse, so never write.
        identity = ProcessIdentity(row["pid"], born, name.casefold())
        if path is None or path == "":
            processes.unreadable_identities.add(identity)
        game, route = match_process(path, name)
        if game:
            processes[identity] = (game, path or "")
            processes.matches[identity] = route
    return processes


def uncertainty_evidence(processes, pid, old):
    """Classify snapshot evidence only; never feed this back into tracking."""
    row = getattr(processes, "observations", {}).get(pid)
    previous = [{"born": i[1], "name": i[2]} for i in sorted(old) if i[0] == pid]
    evidence = {"present": pid in getattr(processes, "present_pids", set()),
                "snapshot_row_available": row is not None, "previous_identities": previous}
    if row is None:
        return {**evidence, "cause": "snapshot_metadata_missing", "name": None,
                "raw_name": None, "born": None, "path": None,
                "name_readable": None, "born_readable": None, "path_readable": None}
    name, born, path = row["name"], row["born"], row["path"]
    name_readable = isinstance(name, str) and bool(name)
    born_readable = isinstance(born, str) and bool(born)
    path_readable = path is not None and path != ""
    # Precedence matters: a reused PID may also have a different name/path.
    if not born_readable:
        cause = "born_missing"
    elif all(born != i["born"] for i in previous):
        cause = "born_changed"
    elif name_readable and all((born, name.casefold()) != (i["born"], i["name"])
                               for i in previous):
        cause = "name_changed"
    elif not name_readable and path_readable:
        cause = "name_missing"
    elif path_readable:
        cause = "path_mismatch"
    else:
        cause = "unreadable_identity"
    return {**evidence, **row, "cause": cause, "name_readable": name_readable,
            "born_readable": born_readable, "path_readable": path_readable}


def bench():
    """Time 100 complete snapshots, including enumeration and existing matching."""
    samples = []
    counts = []
    cpu_start = time.process_time()
    for _ in range(100):
        start = time.perf_counter_ns()
        snapshot = process_snapshot()
        samples.append((time.perf_counter_ns() - start) / 1_000_000)
        if not snapshot.complete:
            raise RuntimeError("Incomplete process snapshot; benchmark aborted")
        counts.append(len(snapshot.present_pids))
    cpu_ms = (time.process_time() - cpu_start) * 1000 / len(samples)
    average = sum(samples) / len(samples)
    p95 = sorted(samples)[math.ceil(len(samples) * 0.95) - 1]
    print(f"Snapshots: {len(samples)}; average: {average:.3f} ms; P95: {p95:.3f} ms")
    print(f"Processes (all enumerated PIDs): {counts[-1]} last; {min(counts)}-{max(counts)} range")
    print(f"CPU time per snapshot: {cpu_ms:.3f} ms")


@dataclass
class Session:
    game: str
    exe: str
    start: datetime
    tick: float
    last: datetime
    last_tick: float
    match: str = "path"
    uncertain_pids: set = field(default_factory=set)


class Tracker:
    def __init__(self, engine, max_gap, heartbeat_path=None, on_session_ended=None):
        self.engine, self.max_gap = engine, max_gap
        self.heartbeat_path = heartbeat_path
        self.on_session_ended = on_session_ended
        # One clock per game. Identity aliases are only liveness/path evidence;
        # multiple aliases can point to the very same Session.
        self.games = {}
        self.active = {}
        self.matches = {}
        self.last_poll = None

    def write_heartbeat(self):
        """记录当前未结束的会话，供崩溃/断电后回收时长（不写自动勾选）。"""
        if not self.heartbeat_path:
            return
        data = {session.game: {"start": session.start.isoformat(),
                               "last": session.last.isoformat(),
                               "duration_s": round(session.last_tick - session.tick, 3)}
                for session in self.games.values()}
        try:
            self.heartbeat_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_text(self.heartbeat_path, json.dumps(data, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def discard(self, reason):
        for session in self.games.values():
            self.end(session, reason)
        self.games.clear()
        self.active.clear()
        self.matches.clear()
        self.last_poll = None
        self.write_heartbeat()

    def end(self, session, reason=None):
        row = self.engine.session(session.game, session.exe, session.start, session.last,
                                  session.last_tick - session.tick, reason, match=session.match)
        self.engine.store.diagnostic(
            "session_ended", session_id=row["session_id"], game=session.game,
            start=row["start"], end=row["end"], duration_s=row["duration_s"],
            day_key=row["day_key"], action=row["action"], reason=row["reason"])
        if self.on_session_ended:
            self.on_session_ended()

    def poll(self, processes, now, tick):
        if not getattr(processes, "complete", True):
            self.discard("process_scan_failed")
            return
        if self.last_poll is not None and tick - self.last_poll > self.max_gap:
            self.discard("monitoring_gap")
        self.last_poll = tick
        # Build the whole game's membership before deciding whether it ended.
        # Removing A before adding B would falsely split a PID handoff.
        grouped = {}
        for identity, (game, exe) in processes.items():
            route = getattr(processes, "matches", {}).get(identity, "path")
            grouped.setdefault(game, {})[identity] = (exe, route)
        for identity, session in self.active.items():
            if (identity not in processes
                    and identity in getattr(processes, "unreadable_identities", set())):
                # Exact, previously verified identities can survive path loss.
                grouped.setdefault(session.game, {})[identity] = ("", self.matches[identity])

        present = getattr(processes, "present_pids", set())
        previous = {}
        for identity, session in self.active.items():
            previous.setdefault(session.game, set()).add(identity)
        for game in list(self.games):
            session = self.games[game]
            old = previous.get(game, set())
            current = grouped.get(game, {})
            # A present former PID may lack born/name, have a changed identity,
            # or have a readable path that no longer matches the game. Retain
            # that uncertainty while a verified sibling lives. Path loss alone
            # with the same identity is already handled above, not uncertainty.
            previously_uncertain = session.uncertain_pids.copy()
            session.uncertain_pids.intersection_update(present)
            session.uncertain_pids.update(i[0] for i in old if i not in current and i[0] in present)
            session.uncertain_pids.difference_update(i[0] for i in current)
            for pid in sorted(session.uncertain_pids - previously_uncertain):
                self.engine.store.diagnostic(
                    "uncertainty", game=game, pid=pid, start=session.start.isoformat(),
                    **uncertainty_evidence(processes, pid, old))
            reused = (not old.intersection(current) and
                      any(a[0] == b[0] and a != b for a in old for b in current))
            if not current or reused:
                # A recycled numeric PID with a new creation time proves an
                # actual restart when no sibling survives; retain that safeguard.
                reason = None
                if session.uncertain_pids or reused and any(i[0] in present for i in old):
                    reason = "process_identity_changed_or_path_unavailable"
                if not current and any(i in processes for i in old):
                    reason = "process_match_changed"
                self.end(session, reason)
                del self.games[game]

        active, matches = {}, {}
        for game, members in grouped.items():
            if game not in self.games:
                self.games[game] = Session(game, "", now, tick, now, tick)
                self.engine.store.diagnostic("session_started", game=game,
                                             start=now.isoformat(), day_key=day_key(now))
            session = self.games[game]
            for identity, (exe, route) in members.items():
                if (self.active.get(identity) is not session
                        or self.matches.get(identity) != route):
                    self.engine.store.diagnostic("process_match", game=game, pid=identity[0], match=route)
                if exe:
                    session.exe = exe
                active[identity], matches[identity] = session, route
            # Record the latest poll's route, including path -> name_fallback.
            # Prefer positive path evidence when both routes coexist. Membership
            # count never enters elapsed time: this is one monotonic wall clock.
            session.match = ("path" if any(route == "path" for _, route in members.values())
                             else "name_fallback")
            session.last, session.last_tick = now, tick
        self.active, self.matches = active, matches
        self.write_heartbeat()


@contextmanager
def watch_lock(root):
    import msvcrt
    path = root / "data" / "watch.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError("Another auto-daily watcher is already running") from None
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def watch(args):
    if os.name != "nt":
        raise RuntimeError("--watch requires Windows")
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise RuntimeError("LOCALAPPDATA is missing")
    helper = Path(local) / "DailyHelperDesktop"
    with watch_lock(ROOT):
        store = Store(ROOT)
        recovered = recover_open_sessions(store)
        if recovered:
            print(f"Recovered playtime from {len(recovered)} unfinished session(s).", flush=True)
        if args.reset_auth:
            store.data["auth_stopped"] = False
            store.save()
        api = HelperHTTP(helper / "active-window.txt")
        engine = Engine(store, api, helper / "state.json")
        playtime = PlaytimeExport(store)
        tracker = Tracker(engine, max(30, args.interval * 3), heartbeat_path=heartbeat_path(ROOT),
                          on_session_ended=lambda: playtime.refresh(force=True))
        store.save()  # Rebuild JSONL from the durable queue after interrupted projection.
        print(f"Watching every {args.interval:g}s; Ctrl+C to stop. JST day={day_key(now_jst())}", flush=True)
        if store.data["auth_stopped"]:
            print("Saved authorization stop is active; --reset-auth is required to rearm.", flush=True)
        scan_failed = False
        try:
            while True:
                try:
                    address, _ = api._connection()
                except (Unavailable, ProtocolError):
                    pass
                else:
                    if urllib.parse.urlsplit(address).path:
                        engine.state_path = helper / "state.json"
                    else:
                        engine.state_path = api.endpoint_file.with_name("state.json")
                    engine.observe_disk()
                engine.flush()
                try:
                    processes = process_snapshot()
                    if not processes.complete:
                        raise OSError("Incomplete process snapshot")
                except (OSError, ValueError):
                    tracker.discard("process_scan_failed")
                    if not scan_failed:
                        store.diagnostic("process_scan_failed")
                    scan_failed = True
                else:
                    scan_failed = False
                    tracker.poll(processes, now_jst(), time.monotonic())
                playtime.refresh()
                time.sleep(args.interval)
        except KeyboardInterrupt:
            tracker.discard("monitoring_stopped")
            store.save()
            print("Stopped; unfinished sessions were skipped. Queue is saved.")


def report():
    store = Store(ROOT)
    key = day_key(now_jst())
    rows = [r for r in store.data["sessions"] if r["day_key"] == key]
    print(f"JST 日常日期: {key}")
    print("game | sessions | seconds | marked | skipped | queued | failed")
    for game in RULES:
        own = [r for r in rows if r["game"] == game]
        counts = Counter(r["action"] for r in own)
        print(f"{game} | {len(own)} | {sum(r['duration_s'] for r in own):.1f} | "
              + " | ".join(str(counts[a]) for a in ("marked", "skipped", "queued", "failed")))
    print(f"待补写总数: {sum(r['action'] == 'queued' and r['phase'] == 'write' for r in store.data['sessions'])}; "
          f"当日补写成功: {sum(bool(r.get('replayed')) for r in rows)}; "
          f"鉴权停止: {store.data['auth_stopped']}")
    for game, ledger in store.data["ledger"].get(key, {}).items():
        if ledger.get("attempted") and not ledger.get("confirmed"):
            print(f"需人工确认（结果未确认，禁止自动重发）: {game}; 日期: {key}")
    for row in rows:
        if row.get("retry_count"):
            print(f"未发送后重试: {row['game']}; 次数: {row['retry_count']}")


def local_steam_aliases():
    """{appid: 本地游戏名}：库清单里的 installdir 与 RULES 前缀目录同名的，视为同一款游戏。

    这样「StarSavior」这种 Steam 英文名会被认成「星救」，账本里不会重复出现，
    而且它本来就是有日常的长线游戏，应归 LIVE_OPS。
    """
    root = steam_root()
    if root is None:
        return {}
    wanted = {Path(prefix.rstrip("\\")).name.casefold(): game
              for game, (prefix, _) in RULES.items()}
    aliases = {}
    try:
        libraries = steam_libraries(root)
    except (OSError, ValueError):
        return {}
    for library in libraries:
        for manifest in (library / "steamapps").glob("appmanifest_*.acf"):
            try:
                state = read_vdf(manifest, "appstate")
            except (OSError, ValueError):
                continue
            appid = str(state.get("appid", "")).strip()
            folder = str(state.get("installdir", "")).strip().casefold()
            if appid and folder in wanted:
                aliases[appid] = wanted[folder]
    return aliases


def build_playtime(store, *, allow_network=True):
    play = playtime_totals(store)
    games = sorted(play.items(), key=lambda kv: -float(kv[1].get("total_s", 0)))
    # 只报送当前规则里的游戏：已从 RULES/TRACK_RULES 移除的（如绿梦）保留原始历史，
    # 但不再出现在账本里，免得已删除的游戏又冒出来。
    tracked = [{"game": game, "hours": round(float(v.get("total_s", 0)) / 3600, 2),
                "sessions": v.get("sessions", 0), "last": v.get("last", "")}
               for game, v in games if game in TRACKED_GAMES]
    tracked_hours = round(sum(float(v.get("total_s", 0)) for game, v in play.items()
                              if game in TRACKED_GAMES) / 3600, 2)
    steam, minutes = read_steam_playtime(store.root / "data" / "steam-names.json",
                                        allow_network=allow_network)
    # Steam 里的英文名认回本地游戏名，并把这些「有日常的长线游戏」从单机挪到长线
    aliases = local_steam_aliases()
    if aliases:
        moved = []
        for group in ("solo", "live"):
            keep = []
            for row in steam.get(group, []):
                local_name = aliases.get(str(row.get("appid", "")))
                if not local_name:
                    keep.append(row)
                    continue
                renamed = dict(row)
                if row.get("name") != local_name:
                    renamed["nameEn"] = row.get("nameEn") or row.get("name")
                    renamed["name"] = local_name
                moved.append((group, renamed))
            steam[group] = keep
        for group, row in moved:
            hours = float(row.get("hours", 0))
            if group == "solo":
                minutes["solo"] = minutes.get("solo", 0) - hours * 60
            if not any(r.get("appid") == row.get("appid") for r in steam["live"]):
                steam["live"].append(row)
                if group == "solo":
                    minutes["live"] = minutes.get("live", 0) + hours * 60
        if moved:
            steam["live"].sort(key=lambda r: -float(r.get("hours", 0)))
    return {
        "ok": True,
        "generatedAt": now_jst().isoformat(),
        "totals": {"trackedHours": tracked_hours, "soloHours": round(minutes["solo"] / 60, 2),
                   "liveHours": round(minutes["live"] / 60, 2)},
        "tracked": tracked,
        "steam": steam,
        "totalHours": tracked_hours,
        "games": tracked,
    }


def playtime_report():
    print(json.dumps(build_playtime(Store(ROOT)), allow_nan=False))
    return 0


def playtime_diagnostic(store, stage, exc):
    try:
        store.diagnostic("playtime_export_failed", stage=stage, error=type(exc).__name__)
    except OSError:
        pass


def write_playtime(store, *, allow_network=True):
    try:
        data = build_playtime(store, allow_network=allow_network)
    except (OSError, ValueError, TypeError) as exc:
        playtime_diagnostic(store, "build", exc)
        return None, False
    success = True
    for stage, directory in (("local", TERMINAL_DATA_DIR), ("web", TERMINAL_WEB_DATA_DIR)):
        try:
            if directory is None:
                raise FileNotFoundError
            write_json_atomic(directory / "playtime.json", data)
        except (OSError, ValueError, TypeError) as exc:
            playtime_diagnostic(store, stage, exc)
            success = False
    return data, success


class PlaytimeExport:
    def __init__(self, store):
        self.store = store
        self.last_refresh = float("-inf")
        self.last_lookup = float("-inf")
        self.lookup = None

    def warm_names(self):
        try:
            read_steam_playtime(self.store.root / "data" / "steam-names.json")
        except (OSError, ValueError, TypeError) as exc:
            playtime_diagnostic(self.store, "steam_names", exc)

    def refresh(self, *, force=False):
        tick = time.monotonic()
        if not force and tick - self.last_refresh < PLAYTIME_REFRESH_SECONDS:
            return
        self.last_refresh = tick
        data, _ = write_playtime(self.store, allow_network=False)
        if (data and tick - self.last_lookup >= 3600
                and (self.lookup is None or not self.lookup.is_alive())
                and any(row.get("unnamed") for group in ("solo", "live", "excluded")
                        for row in data["steam"][group])):
            self.last_lookup = tick
            self.lookup = Thread(target=self.warm_names, daemon=True)
            self.lookup.start()


@dataclass(frozen=True)
class DoctorCheck:
    level: str
    message: str
    advice: str = ""


# Explicit body executable inventory for doctor only; never a match fallback.
# Names were checked against the configured installations; see README.
DOCTOR_BODY_EXES = {
    "绝区零": ("ZenlessZoneZero.exe",),
    "鸣潮": ("Client-Win64-Shipping.exe",),
    "星救": ("StarSavior.exe",),
    "异象回声": ("Echoes of Vision.exe",),
}


# These check_* functions only interpret supplied evidence. All OS/HTTP I/O is
# below them, so failures and output can be tested without a running helper.
def check_config_paths(rules, directories):
    return [DoctorCheck("OK", f"配置路径 | {name} | {prefix}") if directories[name] else
            DoctorCheck("FAIL", f"配置路径 | {name} | {prefix} | 该路径不存在 | 建议核对安装目录",
                        "核对 RULES 中的安装目录；游戏大版本更新后重新自检。")
            for name, (prefix, _) in rules.items()]


def check_current_matches(snapshot, error=None):
    if error or snapshot is None or not snapshot.complete:
        return [DoctorCheck("FAIL", "当前匹配 | 进程快照失败或不完整，不能据此判断游戏已退出",
                            "检查进程枚举权限并重新运行 --doctor。")]
    if not snapshot:
        return [DoctorCheck("OK", "当前匹配 | 未命中游戏（现在没有可匹配的游戏进程，不代表故障）")]
    grouped = {}
    for identity, (game, _) in sorted(snapshot.items()):
        grouped.setdefault(game, []).append(
            f"{identity.pid}(match={snapshot.matches[identity]})")
    return [DoctorCheck("OK", f"当前匹配 | {game} | pid=[{', '.join(pids)}]")
            for game, pids in grouped.items()]


def check_path_drift(snapshot, rules):
    """Interpret all observed rows, including unmatched or born-missing ones."""
    if snapshot is None:
        return []
    checks = []
    for pid, row in sorted(snapshot.observations.items()):
        path = row.get("path")
        if not isinstance(path, str) or not ntpath.isabs(path):
            continue
        exe = row.get("raw_name") or row.get("name") or ntpath.basename(path)
        candidates = [game for game in rules if exe.casefold() in
                      {name.casefold() for name in DOCTOR_BODY_EXES.get(game, ())}]
        actual = normalized_path(path)
        if not candidates or any(actual.startswith(normalized_path(rules[game][0]).rstrip("\\") + "\\")
                                 for game in candidates):
            continue
        def proximity(game):
            try:
                return len(ntpath.commonpath([actual, normalized_path(rules[game][0])]).split("\\"))
            except ValueError:  # Different drives have no common directory.
                return 0
        closest = max(candidates, key=proximity)
        checks.append(DoctorCheck(
            "WARN", f"路径漂移疑似 | pid={pid} | exe={exe} | 实际路径={path} | "
            f"最接近的配置游戏={closest} | 仅提示人工确认",
            "核对游戏实际安装位置与 RULES 前缀；同名其他安装也可能告警，仅提示人工确认。"))
    return checks


def check_helper_connection(file_status, error=None):
    if file_status == "missing" or isinstance(error, Unavailable) and error.failure == "file_missing":
        return DoctorCheck("FAIL", "助手接口 | 连接文件缺失（新终端 assistant-endpoint.json / 旧版 active-window.txt 均不在）",
                           "确认 Personal G Rhine Terminal 或旧版小助手已启动。")
    if file_status != "present" or isinstance(error, Unavailable) and error.failure == "file_unreadable":
        return DoctorCheck("FAIL", "助手接口 | 连接文件不可读",
                           "检查连接文件的权限与 LOCALAPPDATA。")
    if error is None:
        return DoctorCheck("OK", "助手接口 | 连接信息存在；POST list 已返回响应")
    if isinstance(error, Unavailable) and error.failure == "timeout":
        return DoctorCheck("FAIL", "助手接口 | 超时：POST /api/assistant/command 在 8 秒内未完成；"
                           "端口 LISTEN 也不代表接口可用",
                           "检查助手是否被模态框挡住或 UI 线程阻塞；关闭模态框，必要时重开助手，无需重装。")
    if isinstance(error, Unavailable):
        return DoctorCheck("FAIL", "助手接口 | 连接失败或服务拒绝 list；不能仅据此认定助手没启动",
                           "核对助手运行状态、连接文件与本机接口；连接失败和 POST 超时分别排查。")
    if isinstance(error, Unauthorized):
        return DoctorCheck("FAIL", "助手接口 | 鉴权失败（401/403）",
                           "检查助手的 AI 接口授权和当前连接文件。")
    return DoctorCheck("FAIL", "助手接口 | 连接文件格式或响应协议异常",
                       "检查连接文件格式及助手接口版本；不要手工复制 token。")


def check_helper_payload(result, expected_names, expected_day):
    """Validate the fields consumed by auto-daily, including every configured game."""
    if not isinstance(result, dict) or result.get("ok") is not True:
        return DoctorCheck("FAIL", "助手列表 | list 未成功（ok 不为 true）",
                           "检查助手是否允许 AI 操作，再重新自检。")
    games = result.get("games")
    if not isinstance(games, list):
        return DoctorCheck("FAIL", "助手列表 | 缺少有效 games 列表",
                           "检查助手 list 返回格式。")
    issues, ids, names = [], [], Counter()
    for index, game in enumerate(games):
        if (not isinstance(game, dict)
                or not isinstance(game.get("id"), str) or not game["id"].strip()
                or not isinstance(game.get("name"), str) or not game["name"].strip()
                or type(game.get("daily")) is not bool):
            issues.append(f"games[{index}] 的 id/name/daily 缺失或类型错误")
            continue
        ids.append(game["id"])
        names[game["name"]] += 1
    if len(ids) != len(set(ids)):
        issues.append("游戏 id 重复")
    for name, count in names.items():
        if count > 1:
            issues.append(f"{name} 数量={count}（应为 1）")
    missing = [name for name in expected_names if name not in names]
    required_missing = [name for name in missing if name not in OPTIONAL_TERMINAL_GAMES]
    if required_missing:
        issues.append("缺少必需游戏：" + "、".join(required_missing))
    day = result.get("day")
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        issues.append("day 缺失或格式错误")
    if issues:
        return DoctorCheck("FAIL", f"助手列表 | 返回 {len(games)} 个游戏 | " + "；".join(issues),
                           "核对助手列表中的五个游戏、唯一 id 及 day/id/name/daily 字段。")
    if day != expected_day:
        return DoctorCheck("FAIL", f"助手列表 | 返回 {len(games)} 个游戏；字段完整；day={day}，应为 {expected_day}",
                           "核对助手切日状态与系统时间（JST 05:00 切日）。")
    if missing:
        return DoctorCheck("WARN", f"助手列表 | 返回 {len(games)} 个游戏；配置游戏 "
                           f"{len(expected_names) - len(missing)}/{len(expected_names)}；"
                           f"终端列表里没有: {', '.join(missing)}",
                           "如果这些游戏已从终端删除，就同步从 RULES 移除；否则确认终端里的游戏条目还在。")
    return DoctorCheck("OK", f"助手列表 | 返回 {len(games)} 个游戏；配置游戏 {len(expected_names)}/"
                       f"{len(expected_names)}；day/id/name/daily 完整且 id 唯一；day={day}")


def check_python_version(version):
    supported = tuple(version[:2]) >= (3, 11)
    return DoctorCheck("OK" if supported else "FAIL",
                       "Python | " + ".".join(map(str, version[:3])) + "（要求 3.11+）",
                       "" if supported else "使用 Python 3.11 或更高版本运行。")


def check_watch_lock(status, detail=""):
    if status == "occupied":
        return DoctorCheck("OK", "自身状态 | data/watch.lock 被占用，已有 watcher 持锁")
    if status in ("missing", "free"):
        return DoctorCheck("WARN", "自身状态 | data/watch.lock " +
                           ("不存在" if status == "missing" else "存在但未被占用") + "，当前未发现持锁 watcher",
                           "需要自动记录时通过小助手启动 watcher；不要手动另起实例。")
    return DoctorCheck("WARN", f"自身状态 | 无法判断 watch.lock 占用情况（{detail}）",
                       "检查锁文件权限；不要凭文件存在判断 watcher 是否运行，也不要删除锁文件。")


def check_logs_writable(status, detail=""):
    if status == "writable":
        coverage = detail or "已验：无 0 项，未验：目录/主日志/events/临时文件 4 项"
        # Always WARN by design, not a pending fix: these probes only prove we
        # can obtain the requested access. Windows bidirectional sharing means
        # a real writer may still fail under the very same third-party handle.
        return DoctorCheck("WARN", f"日志 | 权限探测通过（{coverage}）；"
                           "但无法证明第三方持锁时真实日志仍可写（Windows 共享语义），历史同类故障见运维手册")
    if status == "unsupported":
        return DoctorCheck("WARN", "日志 | 非 Windows，无法执行只读的 Windows 权限/共享检查",
                           "在运行 watcher 的 Windows 环境重新自检。")
    return DoctorCheck("FAIL", f"日志 | 日志不可写或不可替换（{detail}）",
                       "检查 logs/ 权限与占用；关闭 tail -F/-f，改用 tail -n 50 读完即关。")


def check_recent_session(last_line, error=None):
    if error:
        return DoctorCheck("WARN", "最近会话 | 无法读取 logs/auto_daily.jsonl",
                           "检查会话日志读取权限。")
    if not last_line:
        return DoctorCheck("WARN", "最近会话 | 暂无记录（日志不存在或为空）；不能据此确认最近工作过",
                           "通过小助手启动监控；下一场游戏正常结束后检查最近会话。")
    try:
        row = json.loads(last_line)
        stamp = row.get("time") or row.get("end")
        if not all(isinstance(v, str) and v for v in (stamp, row.get("action"), row.get("reason"))):
            raise ValueError
    except (ValueError, AttributeError):
        return DoctorCheck("FAIL", "最近会话 | 最后一条记录损坏或缺少 time/end、action、reason",
                           "检查会话日志和 runtime 存档；不要手工覆盖安全历史。")
    source = "" if row.get("time") else "（取会话 end）"
    return DoctorCheck("OK", f"最近会话 | time={stamp}{source} | action={row['action']} | reason={row['reason']}")


def doctor_exit_code(checks):
    return int(any(check.level == "FAIL" for check in checks))


def doctor_lines(checks):
    lines = [f"[{check.level}] " + " ".join(check.message.splitlines()) for check in checks]
    counts = Counter(check.level for check in checks)
    overall = 'FAIL' if counts['FAIL'] else 'WARN' if counts['WARN'] else 'OK'
    lines.append(f"[{overall}] "
                 f"汇总 | OK={counts['OK']} WARN={counts['WARN']} FAIL={counts['FAIL']} | "
                 f"退出码={doctor_exit_code(checks)}")
    advice = list(dict.fromkeys(check.advice for check in checks if check.advice))
    lines.append(f"[{overall}] 下一步建议：" + ("；".join(a.rstrip("。") for a in advice) + "。" if advice else
                 "当前检查均正常；游戏大版本更新后再跑一次 --doctor，保留本次输出便于对照。"))
    return lines


def _doctor_file_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes, kernel.CloseHandle.restype = [wintypes.HANDLE], wintypes.BOOL
    return kernel


@contextmanager
def _doctor_existing_handle(kernel, path, access, directory=False):
    # OPEN_EXISTING + share read/write/delete: never create/truncate a file and
    # never keep an observer handle that prevents the watcher's atomic replace.
    handle = kernel.CreateFileW(str(path), access, 7, None, 3,
                                0x02000000 if directory else 0, None)
    if handle in (None, INVALID_HANDLE_VALUE):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield handle
    finally:
        if not kernel.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


def probe_watch_lock(path):
    if os.name != "nt":
        return "error", "需要 Windows"
    class Overlapped(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                    ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                    ("hEvent", wintypes.HANDLE)]
    kernel = _doctor_file_api()
    signature = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                 wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
    kernel.LockFileEx.argtypes, kernel.LockFileEx.restype = signature, wintypes.BOOL
    kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                    wintypes.DWORD, ctypes.POINTER(Overlapped)]
    kernel.UnlockFileEx.restype = wintypes.BOOL
    try:
        with _doctor_existing_handle(kernel, path, 0x80000000) as handle:  # GENERIC_READ
            overlapped = Overlapped()
            if not kernel.LockFileEx(handle, 3, 0, 1, 0, ctypes.byref(overlapped)):
                error = ctypes.get_last_error()
                if error == 33:  # ERROR_LOCK_VIOLATION, not a permission failure
                    return "occupied", ""
                raise ctypes.WinError(error)
            if not kernel.UnlockFileEx(handle, 0, 1, 0, ctypes.byref(overlapped)):
                raise ctypes.WinError(ctypes.get_last_error())
        return "free", ""
    except OSError as exc:
        if getattr(exc, "winerror", None) in (2, 3):
            return "missing", ""
        return "error", f"WinError {getattr(exc, 'winerror', '?')}"


def probe_logs_writable(path):
    if os.name != "nt":
        return "unsupported", ""
    kernel = _doctor_file_api()
    verified, missing, failures = [], [], []
    # All probes use OPEN_EXISTING and share READ/WRITE/DELETE, then close.
    # Requesting access never creates, appends, truncates or deletes anything.
    # Success is limited permission evidence, never proof of real writer success:
    # events' Python append uses different sharing; .tmp rename also needs DELETE.
    # check_logs_writable therefore always reports WARN unless a probe fails.
    probes = (
        ("目录", path, 2, True, "logs/ 目录无新建权限"),  # FILE_ADD_FILE
        ("主日志", path / "auto_daily.jsonl", 0x10000, False,
         "auto_daily.jsonl 不可替换"),  # DELETE: retain atomic replace check
        ("events", path / "events.jsonl", 0x4, False,
         "events.jsonl 无法追加，watcher 写诊断会失败"),  # FILE_APPEND_DATA
        ("临时文件", path / "auto_daily.jsonl.tmp", 0x40000000, False,
         "atomic_text 的临时文件不可写"),  # GENERIC_WRITE
    )
    for label, target, access, directory, failure in probes:
        try:
            with _doctor_existing_handle(kernel, target, access, directory=directory):
                pass
            verified.append(label)
        except OSError as exc:
            if not directory and getattr(exc, "winerror", None) in (2, 3):
                missing.append(label)
            else:
                failures.append(f"{failure}（WinError {getattr(exc, 'winerror', '?')}）")
    coverage = (f"已验：{'/'.join(verified) or '无'} 中 {len(verified)} 项，"
                f"未验：{'/'.join(missing) or '无'} {len(missing)} 项")
    return ("error", "；".join(failures + [coverage])) if failures else ("writable", coverage)


def read_last_session(path):
    try:
        if os.name == "nt":
            # Python's normal open does not share DELETE on Windows. Reading a
            # live projection must not transiently block the watcher's replace.
            kernel = _doctor_file_api()
            kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
            kernel.ReadFile.restype = wintypes.BOOL
            chunks, buffer, count = [], ctypes.create_string_buffer(65536), wintypes.DWORD()
            with _doctor_existing_handle(kernel, path, 0x80000000) as handle:
                while True:
                    if not kernel.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if not count.value:
                        break
                    chunks.append(buffer.raw[:count.value])
            content = b"".join(chunks).decode("utf-8-sig")
        else:
            content = path.read_text(encoding="utf-8-sig")
        return next((line.strip() for line in reversed(content.splitlines()) if line.strip()), ""), None
    except FileNotFoundError:
        return "", None
    except (OSError, UnicodeError) as exc:
        return "", exc


def doctor(root=ROOT):
    """One snapshot and one list only; no Store/Engine/Tracker/watch side effects."""
    checks = check_config_paths(RULES, {name: Path(prefix).is_dir()
                                       for name, (prefix, _) in RULES.items()})
    try:
        snapshot = process_snapshot()
        checks.extend(check_current_matches(snapshot))
        checks.extend(check_path_drift(snapshot, RULES))
    except (OSError, ValueError, RuntimeError) as exc:
        checks.extend(check_current_matches(None, exc))
    local = os.environ.get("LOCALAPPDATA")
    endpoint = default_endpoint_file() if local else None
    connection = Path(local) / "DailyHelperDesktop" / "active-window.txt" if local else None
    try:
        present = bool((endpoint and endpoint.is_file()) or (connection and connection.is_file()))
        file_status = "present" if present else "missing"
    except OSError:
        file_status = "unreadable"
    result, error = None, None
    if file_status == "present":
        try:
            result = HelperHTTP(connection).call("list")
        except (Unavailable, Unauthorized, ProtocolError) as exc:
            error = exc
    checks.append(check_helper_connection(file_status, error))
    if file_status == "present" and error is None:
        checks.append(check_helper_payload(result, RULES, day_key(now_jst())))
    checks.append(check_python_version(sys.version_info))
    checks.append(check_watch_lock(*probe_watch_lock(root / "data" / "watch.lock")))
    checks.append(check_logs_writable(*probe_logs_writable(root / "logs")))
    checks.append(check_recent_session(*read_last_session(root / "logs" / "auto_daily.jsonl")))
    for line in doctor_lines(checks):
        print(line)
    return doctor_exit_code(checks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for name in ("watch", "report", "selftest", "bench", "doctor", "playtime", "write-playtime"):
        mode.add_argument("--" + name, action="store_true")
    parser.add_argument("--interval", type=float, default=10, help="poll seconds (default: 10)")
    parser.add_argument("--reset-auth", action="store_true", help="manually rearm authorization with --watch")
    args = parser.parse_args()
    if not math.isfinite(args.interval) or args.interval <= 0:
        parser.error("--interval must be finite and positive")
    if args.reset_auth and not args.watch:
        parser.error("--reset-auth requires --watch")
    try:
        if args.selftest:
            from selftest import run
            return run()
        if args.doctor:
            return doctor()
        if args.bench:
            bench()
        elif args.report:
            report()
        elif args.playtime:
            return playtime_report()
        elif args.write_playtime:
            return 0 if write_playtime(Store(ROOT))[1] else 1
        else:
            watch(args)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
