# 第三轮：ctypes Win32 进程快照验收

2026-11-06，本机 Windows / Python 3.14.9。修改范围仅 `auto-daily/`，无新增第三方依赖。

## 性能

在 `auto-daily/` 下运行 `python auto_daily.py --bench`，连续执行 100 次完整快照，包含首次 DLL 绑定、进程枚举、完整路径及创建时间查询、现有匹配逻辑。最终运行输出：

```text
Snapshots: 100; average: 13.614 ms; P95: 16.188 ms
Processes (all enumerated PIDs): 407 last; 406-407 range
CPU time per snapshot: 12.344 ms
```

P95 取排序后第 95 个样本。进程数统计所有枚举 PID，包含无法打开句柄或无法读取路径/创建时间的进程，并非游戏匹配数。不完整扫描会终止基准并报错。

| 项目 | 改前 | 改后 |
| --- | ---: | ---: |
| 平均快照耗时 | 516 ms（用户提供的本机 10 次均值） | 13.614 ms（本次 100 次实测） |
| 默认轮询间隔 | 5 秒 | 10 秒 |
| 快照墙钟时间占空比估算 | 516 / 5000 × 100% = 10.32% | 13.614 / 10000 × 100% = 0.136% |

平均快照约提速 37.9 倍，达到平均小于 20 ms 的要求。仅快照部分的进程 CPU 时间估算为 `12.344 / 10000 × 100% ≈ 0.123%`（以单核满载为 100%）；它与上述墙钟时间占空比口径不同。两项估算均不包含助手 HTTP、存档和日志处理；当前循环在扫描后睡眠 10 秒，真实周期略长。

## 回归

`python auto_daily.py --selftest` 最终运行：

```text
PASS test_01 ... test_36
  200 real snapshots: handles 149 -> 149 (delta 0)
Ran 36 tests in 3.370s
OK
```

原有 30 项回归全部通过；第 30 项原先的 PowerShell 属性异常 fixture 已替换为 Win32 路径查询异常 fixture，仍验证路径异常时保留进程并按名字降级，累计到门槛且退出后才能标记。新增 6 项覆盖：

1. 空串、API 返回失败及抛出 `OSError` 时保留 PID/身份，名字白名单仍降级，非白名单身份保留在路径不可读集合中。
2. 连续 200 次真实快照，当前 Python 进程句柄数严格相等；同时拦截 `subprocess.Popen`，意外创建子进程即失败。
3. 创建时间查询失败和 `OpenProcess` 权限不足时保留 PID、保守跳过可匹配身份。
4. 快照创建失败、枚举开始/中途失败及关闭句柄失败时标记扫描不完整，已有会话按扫描失败跳过，不能当作正常退出后写入。
5. 中文进程名、带空格的 Unicode 长路径、大小写不敏感匹配，以及 FILETIME 相差 100 ns 时身份不同。
6. 默认 `--interval 10` 和自定义 `--interval 2.5` 参数传递。

直接运行口径回归：

```python
match_process(None, "ZenlessZoneZero.exe")
# ('绝区零', 'name_fallback')
```

测试使用临时存档和模拟助手 HTTP，没有连接真实助手。句柄计数及性能数字来自本机真实 Win32 快照。

## 实现依据

使用 [PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w) 的 Unicode 进程枚举结构，显式声明 ctypes 参数和返回类型，句柄与 `ULONG_PTR` 使用指针宽度。路径查询使用 [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew)，创建时间通过 [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) 获取并保留 FILETIME 的 100 ns 精度。进程句柄及快照句柄都在 `finally` 中关闭。
