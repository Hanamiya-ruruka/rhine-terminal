# auto-daily watcher

Python 3.11+ 标准库，`ctypes` 直调 Windows API，支持前台运行和登录后后台常驻。进程快照不创建子进程、无需安装第三方依赖、不会启动游戏或助手。

## 快速开始

使用前请先打开 `auto_daily.py`，按你的本机安装目录修改顶部的 `RULES`（游戏名 → 本体目录前缀与启动器黑名单）。

在 PowerShell 中运行：

```powershell
Set-Location 'tools\auto-daily'
python auto_daily.py --selftest       # 运行内置单元测试
python auto_daily.py --bench          # 性能基准测试（100 次真实快照）
python auto_daily.py --doctor         # 一键环境与 AI 接口自检
python auto_daily.py --playtime       # 输出当前时长统计 JSON
python auto_daily.py --write-playtime # 手动导出 playtime.json 快照
python auto_daily.py --report         # 查看今日会话报告
python auto_daily.py --watch          # 启动后台监控（默认 10 秒轮询）
python auto_daily.py --watch --interval 10
```

默认轮询间隔为 10 秒，可用 `--interval <秒>` 调整。`Ctrl+C` 停止；同一目录通过 `data/watch.lock` 保证单实例运行。

---

## Windows 登录后自动启动

在 `tools\auto-daily` 目录下运行（需保证 `pythonw.exe` 在系统 `PATH` 中，或按需编辑 `start-watch.cmd` 指定解释器路径）：

```powershell
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$launcher = (Resolve-Path -LiteralPath .\start-watch.cmd).Path
Set-ItemProperty -LiteralPath $run -Name AutoDailyWatch -Value ('"' + $launcher + '"')
cmd.exe /d /c .\start-watch.cmd
```

卸载开机自启（加 `-StopWatcher` 可同时停止正在运行的 watcher）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\uninstall-startup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\uninstall-startup.ps1 -StopWatcher
```

---

## `--playtime` 与时长导出

- `--playtime` 输出标准 JSON，包含 `totals`、`tracked`（本地进程统计）和 `steam`（读取本地 Steam `localconfig.vdf` 累计时长，分为 `solo` / `live` / `excluded`）。
- 分类调整：可在 `steam_playtime.py` 的 `STEAM_EXCLUDE_IDS` 或 `STEAM_LIVE_IDS` 集合中增删 Steam AppID，未列出的默认归入 `3A_SINGLE`。
- `--write-playtime`（以及 watcher 每 60 秒节流刷新）会向 `%LOCALAPPDATA%\PersonalGRhineTerminal\playtime.json` 与当前仓库的 `web/data/playtime.json` 原子写入同一份 UTF-8 无 BOM JSON。

---

## `--doctor` 环境自检

```powershell
python .\tools\auto-daily\auto_daily.py --doctor
```

检查项包括：
- `RULES` 中配置的游戏安装目录是否存在；
- 一次真实进程快照与匹配测试；
- BIONIC LINK 连接文件（`%LOCALAPPDATA%\PersonalGRhineTerminal\assistant-endpoint.json`）与一次只读 `list` 探测；
- Python 版本（要求 3.11+）、锁文件状态与 `logs/` 写入权限。

全部通过或仅存在预期 `WARN` 时退出码为 `0`；存在 `FAIL` 时退出码为 `1`。

---

## 匹配与安全写入机制

- **进程识别**：通过 `CreateToolhelp32Snapshot` + `QueryFullProcessImageNameW` + `GetProcessTimes` 获取 `(pid, born, name)` 三元身份，防止 PID 复用误判。
- **反作弊路径屏蔽兼容**：若某游戏开启反作弊导致可执行路径不可读，仅对 `NAME_FALLBACK` 白名单中的精确进程名做降级匹配，仍须累计满门槛时长且确认退出后才触发。
- **防重复与取消保护**：
  - 仅调用 `POST /api/assistant/command` 的 `set_completion`（`field="daily", done=true`），不触碰周常或其他字段；
  - 写入前先 `list` 核对游戏 ID 唯一性，写入后回读确认；
  - 当日若观察到人工手动取消勾选（`True → False`），会持久记录取消标记，当天不再自动补勾；
  - 遇到超时的未确认请求不盲目重发，避免覆盖人工操作。

---

## 本地运行时文件（已纳入 `.gitignore`）

- `data/runtime.json`：会话队列、取消记录与状态持久化。
- `logs/auto_daily.jsonl`：已结束/中断会话流水。
- `logs/events.jsonl`：匹配与诊断事件日志。
