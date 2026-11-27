"""Read Steam playtime and resolve app names without using Steam credentials."""
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.request import urlopen

# 只统计这些账号的时长。主人拍板（2026-11-23）：账本只算主号 359369553，
# 另两个号的游戏不进账本。留空元组 = 统计全部账号。
STEAM_ACCOUNT_IDS = ("359369553",)

# 误判改一行即可：在集合中增删对应 App ID。
STEAM_EXCLUDE_IDS = frozenset({
    "3003300",  # ZM Desktop Elf
    "431960",   # Wallpaper Engine
    "5075020",  # Little LUMI Model
    "250820",   # SteamVR
})
# 误判改一行即可：在集合中增删对应 App ID。
STEAM_LIVE_IDS = frozenset({
    "730",      # Counter-Strike 2
    "578080",   # PUBG
    "1172470",  # Apex Legends
    "359550",   # Rainbow Six Siege
    "1085660",  # Destiny 2
    "230410",   # Warframe
    "453480",   # Shadowverse CCG
    "2584990",  # Shadowverse: Worlds Beyond（2026-11-23 核实为真实 ID）
    "2073620",  # Arena Breakout: Infinite（2026-11-23 核实为真实 ID）
    "3052450",  # Morimens / 忘却前夜（2026-11-23 主人指定归长线）
    "4324040",  # 异象回声 Echoes of Vision（长线抽卡，Steam 版）
    "4162040",  # 绝区零 Zenless Zone Zero（长线抽卡，Steam 版）
    "570",      # Dota 2
    "440",      # Team Fortress 2
})
_TOKEN = re.compile(r'\s+|//[^\n]*|"((?:[^"\\]|\\.)*)"|([{}])', re.DOTALL)


def parse_vdf(text):
    """Parse quoted KeyValues strings, blocks, and line comments."""
    root = {}
    stack = [root]
    key = None
    offset = 0
    while offset < len(text):
        match = _TOKEN.match(text, offset)
        if match is None:
            raise ValueError("Invalid VDF token")
        offset = match.end()
        quoted, brace = match.groups()
        if quoted is not None:
            value = re.sub(r'\\(["\\])', r'\1', quoted)
            if key is None:
                key = value.casefold()
            else:
                stack[-1][key] = value
                key = None
        elif brace == "{" and key is not None:
            child = {}
            stack[-1][key] = child
            stack.append(child)
            key = None
        elif brace == "}" and key is None and len(stack) > 1:
            stack.pop()
        elif brace:
            raise ValueError("Invalid VDF block")
    if key is not None or len(stack) != 1:
        raise ValueError("Incomplete VDF")
    return root


def read_vdf(path, *keys):
    value = parse_vdf(path.read_text(encoding="utf-8-sig"))
    for key in keys:
        value = value.get(key, {}) if isinstance(value, dict) else {}
    if not isinstance(value, dict):
        raise ValueError("Expected VDF block")
    return value


def steam_root():
    candidates = []
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
                path, _ = winreg.QueryValueEx(key, "SteamPath")
                if isinstance(path, str) and path:
                    candidates.append(Path(path))
        except OSError:
            pass
    candidates.extend(map(Path, (r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam")))
    return next((p for p in candidates if (p / "userdata").is_dir()), None)


def numeric_id(value):
    return re.fullmatch(r"[0-9]{1,20}", value) is not None


def account_playtime(root, notes):
    primary = set()
    try:
        users = read_vdf(root / "config" / "loginusers.vdf", "users")
        primary = {str(int(uid) & 0xffffffff) for uid, user in users.items()
                   if numeric_id(uid) and isinstance(user, dict) and user.get("mostrecent") == "1"}
    except (OSError, ValueError):
        notes.append("cannot read loginusers.vdf")
    else:
        if not primary:
            notes.append("loginusers.vdf has no MostRecent account")
    accounts = []
    minutes = {}
    allowed = set(STEAM_ACCOUNT_IDS)
    for folder in sorted((root / "userdata").iterdir()):
        if not folder.is_dir() or not numeric_id(folder.name):
            continue
        if allowed and folder.name not in allowed:
            continue
        config = folder / "config" / "localconfig.vdf"
        try:
            apps = read_vdf(config, "userlocalconfigstore", "software", "valve", "steam", "apps")
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            notes.append(f"cannot read localconfig.vdf for account {folder.name}")
            continue
        accounts.append({"id": folder.name, "primary": folder.name in primary})
        for appid, app in apps.items():
            if not numeric_id(appid) or not isinstance(app, dict):
                continue
            value = app.get("playtime", "")
            if isinstance(value, str) and numeric_id(value):
                minutes.setdefault(appid, {})[folder.name] = int(value)
    if allowed:
        for folder in sorted((root / "userdata").iterdir()):
            if folder.is_dir() and numeric_id(folder.name) and folder.name not in allowed:
                if (folder / "config" / "localconfig.vdf").exists():
                    notes.append(f"skipped non-primary account {folder.name}")
    accounts.sort(key=lambda row: (not row["primary"], row["id"]))
    return accounts, minutes


def steam_libraries(root):
    libraries = [root]
    try:
        entries = read_vdf(root / "steamapps" / "libraryfolders.vdf", "libraryfolders")
    except (OSError, ValueError):
        return libraries
    for entry in entries.values():
        path = entry.get("path") if isinstance(entry, dict) else None
        if valid_name(path) and Path(path).is_absolute() and Path(path) not in libraries:
            libraries.append(Path(path))
    return libraries


def manifest_name(libraries, appid):
    for library in libraries:
        try:
            name = read_vdf(library / "steamapps" / f"appmanifest_{appid}.acf", "appstate").get("name")
        except (OSError, ValueError):
            continue
        if valid_name(name):
            return name
    return None


def valid_name(value):
    return isinstance(value, str) and bool(value.strip())


def store_details(appid):
    """先取简中名，拿不到再退回默认语言（避免限流时把条目整条丢成无名）。"""
    for lang in ("schinese", None):
        suffix = f"&l={lang}" if lang else ""
        url = ("https://store.steampowered.com/api/appdetails"
               f"?appids={appid}&filters=basic,categories{suffix}")
        try:
            with urlopen(url, timeout=4) as response:
                entry = json.load(response)[appid]
            details = entry["data"]
            if entry["success"] and valid_name(details.get("name")):
                return {"name": details["name"], "lang": lang or "default",
                        "type": details.get("type"),
                        "cats": details.get("categories", [])}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return None


def write_json_atomic(path, data):
    """Use a unique temporary file so concurrent exports cannot mix bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=path.name + ".", suffix=".tmp",
                                         delete=False)
    temp = Path(stream.name)
    try:
        with stream:
            json.dump(data, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_name_cache(path, notes):
    try:
        cache = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(cache, dict):
            return cache
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        pass
    notes.append("cannot read Steam name cache")
    return {}


def read_steam_playtime(cache_path, *, allow_network=True):
    """Aggregate minutes by App ID, retaining the contributing accounts."""
    notes = []
    root = steam_root()
    stats = {"root": str(root) if root is not None else None, "appidCount": 0,
             "manifestHits": 0, "cacheHits": 0, "networkQueries": 0}
    steam = {"solo": [], "live": [], "excluded": [], "accounts": [], "stats": stats}
    totals = {"solo": 0, "live": 0, "excluded": 0}
    if root is None:
        steam["note"] = "Steam userdata not found"
        return steam, totals
    try:
        steam["accounts"], minutes = account_playtime(root, notes)
    except OSError:
        steam["note"] = "cannot read Steam userdata"
        return steam, totals
    stats["appidCount"] = len(minutes)
    libraries = steam_libraries(root)
    cache = read_name_cache(cache_path, notes)
    updates = {}
    rows = sorted(minutes.items(), key=lambda pair: (-sum(pair[1].values()), int(pair[0])))
    for appid, sources in rows:
        total = sum(sources.values())
        if total == 0:
            continue
        # 名字优先级：中文缓存 → 中文商店查询 → 本地清单（英文）→ 占位
        manifest = manifest_name(libraries, appid)
        entry = cache.get(appid)
        name = None
        if (isinstance(entry, dict) and entry.get("lang") in ("schinese", "default")
                and valid_name(entry.get("name"))):
            name = entry["name"]
            stats["cacheHits"] += 1
        elif allow_network:
            if stats["networkQueries"]:
                time.sleep(0.25)
            stats["networkQueries"] += 1
            fresh = store_details(appid)
            if fresh:
                updates[appid] = fresh
                name = fresh["name"]
        if not valid_name(name) and valid_name(manifest):
            name = manifest
            stats["manifestHits"] += 1
        group = "solo"
        if appid in STEAM_EXCLUDE_IDS:
            group = "excluded"
        elif appid in STEAM_LIVE_IDS:
            group = "live"
        totals[group] += total          # 总数照算：离线时查不到名字也不能让总量塌掉
        if not valid_name(name):
            # 2026-11-23 主人拍板：查不到名字的 appid 不显示成占位条目，
            # 只单独计数留痕（多半是已下架的工具/DLC）。
            unnamed = steam.setdefault("unnamed", {"count": 0, "hours": 0.0, "appids": []})
            unnamed["count"] += 1
            unnamed["hours"] = round(unnamed["hours"] + total / 60, 2)
            if len(unnamed["appids"]) < 10:
                unnamed["appids"].append(appid)
            continue
        row = {"appid": appid, "name": name, "hours": round(total / 60, 2)}
        if valid_name(manifest) and manifest != name:
            row["nameEn"] = manifest
        if len(steam["accounts"]) > 1:
            row["sources"] = [{"id": account["id"], "primary": account["primary"],
                               "hours": round(sources[account["id"]] / 60, 2)}
                              for account in steam["accounts"] if sources.get(account["id"])]
        steam[group].append(row)
    if updates:
        try:
            write_json_atomic(cache_path, {**read_name_cache(cache_path, notes), **updates})
        except OSError:
            notes.append("cannot write Steam name cache")
    if not steam["accounts"]:
        notes.append("no readable Steam account playtime")
    if notes:
        steam["note"] = "; ".join(dict.fromkeys(notes))
    return steam, totals
