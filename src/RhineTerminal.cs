// Personal G Rhine Terminal —— WebView2 版宿主
// 与旧版（外部 Edge + 本地 HTTP）的区别：
//   * 界面渲染在自身进程的 WebView2 里，窗口/进程归属自己的 exe
//   * WebView2 资源与接口由 WebResourceRequested 应答，外部 AI 接口另走回环监听
//   * 数据仍在宿主侧落盘（state.json / daily-log.json / prefs.json）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// 版本基线：v1.0（2026-11-23 确立）。以后改动以 git tag v1.0 为基线递增。
// 注意：RhineTerminal.Assistant.cs 里的 AssistantVersion（协议版本，当前 "3.0"）是接口契约，不要跟这里一起改。
[assembly: System.Reflection.AssemblyTitle("Personal G Rhine Terminal")]
[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.0.0")]

public partial class RhineTerminal : Form
{
    const string VirtualHost = "app.local";
    const string WindowTitle = "Personal G Rhine Terminal";
    const int LogLimit = 500;

    static readonly Encoding utf8 = new UTF8Encoding(false);
    static string root, webDir, dataDir, stateFile, logFile, prefsFile, windowStateFile, oldDataDir, ledgerFile;
    static readonly object dataLock = new object();
    static readonly object logLock = new object();
    static readonly object prefsLock = new object();
    static long savedRevision;

    WebView2 view;
    Rectangle lastNormalBounds;
    bool hasNormalBounds;

    static JavaScriptSerializer Json()
    {
        return new JavaScriptSerializer { MaxJsonLength = 4194304 };
    }

    [STAThread]
    public static void Main()
    {
        EnableDpiAwareness();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool owner;
        using (Mutex mutex = new Mutex(true, "Local\\PersonalGRhineTerminal-v3", out owner))
        {
            if (!owner) { ActivateExisting(); return; }
            try
            {
                using (var window = new RhineTerminal())
                {
                    window.StartAssistantListener();
                    try { Application.Run(window); }
                    finally { window.StopAssistantListener(); }
                }
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    // 不声明 DPI 感知时，WebView2 按 96 DPI 渲然后被系统整体拉伸，字会发虚。
    // 优先 per-monitor v2（Win10 1703+），退回系统级 DPI 感知。
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static void EnableDpiAwareness()
    {
        IntPtr perMonitorV2 = new IntPtr(-4);
        try { if (SetProcessDpiAwarenessContext(perMonitorV2)) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    static void ActivateExisting()
    {
        IntPtr handle = FindWindow(null, WindowTitle);
        if (handle != IntPtr.Zero) { ShowWindow(handle, 9); SetForegroundWindow(handle); }
        else MessageBox.Show("Personal G Rhine Terminal 已经在运行，请查看任务栏。", WindowTitle);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);

    public RhineTerminal()
    {
        root = AppDomain.CurrentDomain.BaseDirectory;
        webDir = Path.Combine(root, "web");
        dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PersonalGRhineTerminal");
        oldDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DailyHelperDesktop");
        Directory.CreateDirectory(dataDir);
        stateFile = Path.Combine(dataDir, "state.json");
        logFile = Path.Combine(dataDir, "daily-log.json");
        prefsFile = Path.Combine(dataDir, "prefs.json");
        windowStateFile = Path.Combine(dataDir, "window-state.json");
        ledgerFile = Path.Combine(dataDir, "ledger.json");
        MigrateFromOldApp();
        LoadAssistantSettings();

        Text = WindowTitle;
        StartPosition = FormStartPosition.Manual;
        ApplySavedBounds();
        // 窗口/任务栏图标：优先 app-win.ico（BMP 格式档位，GDI+ 能解码）。
        // web\app.ico 是 PNG 压缩型 ICO，System.Drawing.Icon 读它解不出来，会退回系统默认图标。
        foreach (string candidate in new[] {
            Path.Combine(webDir, "app-win.ico"),
            Path.Combine(root, "app-win.ico"),
            Path.Combine(webDir, "app.ico"),
            Path.Combine(root, "app.ico")
        }) {
            if (!File.Exists(candidate)) continue;
            try { Icon = new Icon(candidate); break; } catch { }
        }
        BackColor = Color.FromArgb(244, 244, 240);

        view = new WebView2();
        view.Dock = DockStyle.Fill;
        Controls.Add(view);

        Load += OnFormLoad;
        FormClosing += OnFormClosing;
        // 只在正常态记录尺寸：最大化时 RestoreBounds 会等于最大化尺寸，存下去会得到越界窗口
        SizeChanged += OnSizeChanged;
        Trace("BOOT web=" + webDir + " data=" + dataDir);
    }

    void OnFormLoad(object sender, EventArgs e)
    {
        StartBrowser();
    }

    async void StartBrowser()
    {
        if (!Directory.Exists(webDir))
        {
            MessageBox.Show("缺少界面目录：\r\n" + webDir, WindowTitle);
            Close();
            return;
        }
        try
        {
            CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
            options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling";
            string userDataFolder = Path.Combine(dataDir, "WebView2");
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
            await view.EnsureCoreWebView2Async(environment);
            CoreWebView2 core = view.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;
            // 不用 SetVirtualHostNameToFolderMapping：映射会先一步吃掉请求，WebResourceRequested 不触发。
            // 静态文件与接口统一由事件处理器应答。
            core.AddWebResourceRequestedFilter("https://" + VirtualHost + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnResourceRequested;
            core.Navigate("https://" + VirtualHost + "/index.html");
        }
        catch (Exception error)
        {
            MessageBox.Show("界面初始化失败：\r\n" + error.Message, WindowTitle);
            Close();
        }
    }

    // ── 接口层：把 /api/* 的请求就地处理，不经过网络 ───────────────────────

    void OnResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        string path = "";
        try { path = new Uri(args.Request.Uri).AbsolutePath; } catch { }
        if (path.StartsWith("/api/", StringComparison.Ordinal))
        {
            CoreWebView2Deferral deferral = args.GetDeferral();
            HandleApiAsync(args, deferral);
        }
        else ServeStatic(args, path);
    }

    static readonly Dictionary<string, string> MimeTypes = BuildMimeTypes();

    static Dictionary<string, string> BuildMimeTypes()
    {
        Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        map[".html"] = "text/html; charset=utf-8";
        map[".js"] = "text/javascript; charset=utf-8";
        map[".css"] = "text/css; charset=utf-8";
        map[".json"] = "application/json; charset=utf-8";
        map[".wav"] = "audio/wav";
        map[".ico"] = "image/x-icon";
        map[".png"] = "image/png";
        map[".svg"] = "image/svg+xml";
        map[".woff2"] = "font/woff2";
        map[".txt"] = "text/plain; charset=utf-8";
        return map;
    }

    void ServeStatic(CoreWebView2WebResourceRequestedEventArgs args, string path)
    {
        try
        {
            string relative = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            if (relative.Length == 0) relative = "index.html";
            string full = Path.GetFullPath(Path.Combine(webDir, relative));
            if (!full.StartsWith(Path.GetFullPath(webDir), StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                args.Response = BuildRawResponse(404, "text/plain; charset=utf-8", utf8.GetBytes("Not Found"));
                return;
            }
            string mime;
            if (!MimeTypes.TryGetValue(Path.GetExtension(full), out mime)) mime = "application/octet-stream";
            args.Response = BuildRawResponse(200, mime, File.ReadAllBytes(full));
        }
        catch (Exception error)
        {
            Trace("STATIC-ERR " + path + " " + error.Message);
            try { args.Response = BuildRawResponse(500, "text/plain; charset=utf-8", utf8.GetBytes(error.Message)); } catch { }
        }
    }

    CoreWebView2WebResourceResponse BuildRawResponse(int status, string contentType, byte[] payload)
    {
        MemoryStream stream = new MemoryStream(payload);
        liveResponses.Add(stream);
        if (liveResponses.Count > 512) liveResponses.RemoveRange(0, 256);
        string headers = "Content-Type: " + contentType + Environment.NewLine + "Cache-Control: no-store";
        return view.CoreWebView2.Environment.CreateWebResourceResponse(stream, status, status == 200 ? "OK" : "Error", headers);
    }

    sealed class ApiResult
    {
        public int Status;
        public string Body;
        public static ApiResult Ok(string body) { ApiResult r = new ApiResult(); r.Status = 200; r.Body = body; return r; }
        public static ApiResult Fail(int status, string message)
        {
            ApiResult r = new ApiResult(); r.Status = status;
            r.Body = "{\"error\":" + Json().Serialize(message) + "}"; return r;
        }
    }

    static void Trace(string line)
    {
        try
        {
            string path = Path.Combine(dataDir, "requests.log");
            FileInfo info = new FileInfo(path);
            if (info.Exists && info.Length > 524288) File.Delete(path);   // 诊断日志限长 512 KB
            File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine, utf8);
        }
        catch { }
    }

    static readonly List<MemoryStream> liveResponses = new List<MemoryStream>();

    async void HandleApiAsync(CoreWebView2WebResourceRequestedEventArgs args, CoreWebView2Deferral deferral)
    {
        ApiResult result;
        try
        {
            Trace("REQ " + args.Request.Method + " " + args.Request.Uri);
            string absolutePath = new Uri(args.Request.Uri).AbsolutePath;   // /api/xxx
            string route = absolutePath.Substring(5);
            string method = args.Request.Method;
            string body = ReadBody(args.Request);
            string revisionHeader = "";
            if (args.Request.Headers.Contains("X-Save-Revision")) revisionHeader = args.Request.Headers.GetHeader("X-Save-Revision");
            result = await DispatchAsync(route, method, body, revisionHeader);
        }
        catch (Exception error)
        {
            Trace("ERR " + error.GetType().Name + ": " + error.Message + " | " + error.StackTrace);
            result = ApiResult.Fail(400, error.Message);
        }
        try
        {
            Trace("RES " + result.Status + " " + result.Body.Substring(0, Math.Min(80, result.Body.Length)));
            args.Response = BuildResponse(result.Status, result.Body);
        }
        catch (Exception error)
        {
            result = ApiResult.Fail(500, error.Message);
        }
        deferral.Complete();
    }

    static string ReadBody(CoreWebView2WebResourceRequest request)
    {
        Stream content = request.Content;
        if (content == null) return "";
        using (MemoryStream buffer = new MemoryStream())
        {
            content.CopyTo(buffer);
            return utf8.GetString(buffer.ToArray());
        }
    }

    CoreWebView2WebResourceResponse BuildResponse(int status, string body)
    {
        return BuildRawResponse(status, "application/json; charset=utf-8", utf8.GetBytes(body));
    }

    async Task<ApiResult> DispatchAsync(string route, string method, string body, string revisionHeader)
    {
        if (route == "state" && method == "GET")
        {
            string state = LoadState();
            if (state == null) return ApiResult.Ok("{\"state\":null,\"revision\":" + Interlocked.Read(ref savedRevision) + "}");
            return ApiResult.Ok("{\"state\":" + state + ",\"revision\":" + Interlocked.Read(ref savedRevision) + "}");
        }
        if (route == "log" && method == "GET") return ApiResult.Ok("{\"entries\":" + Json().Serialize(LoadLog()) + "}");
        if (route == "prefs" && method == "GET") return ApiResult.Ok("{\"prefs\":" + Json().Serialize(LoadPrefs()) + "}");
        if (route == "ledger" && method == "GET")
        {
            string ledger = LoadLedger();
            return ApiResult.Ok("{\"ledger\":" + (ledger ?? "null") + "}");
        }
        if (route.StartsWith("assistant/", StringComparison.Ordinal))
            return await DispatchAssistantAsync(route, method, body, true);
        if (route == "heartbeat") return ApiResult.Ok("{\"ok\":true}");
        if (method != "POST") return ApiResult.Fail(405, "请求方法不支持");

        if (route == "save") return SaveState(body, revisionHeader);
        if (route == "log") return SaveLogEntry(body);
        if (route == "prefs") return SavePref(body);
        if (route == "ledger") return SaveLedger(body);
        if (route == "launch") return Launch(body);
        if (route == "browse") return Browse();
        if (route == "exit") { BeginInvoke(new Action(Close)); return ApiResult.Ok("{\"ok\":true}"); }
        return ApiResult.Fail(404, "未知操作");
    }

    // ── 数据层 ───────────────────────────────────────────────────────────

    static string LoadState()
    {
        lock (dataLock)
        {
            if (!File.Exists(stateFile)) return null;
            string raw = File.ReadAllText(stateFile, utf8);
            ValidateState(raw);
            return raw;
        }
    }

    static readonly string[] GameFields = new string[] { "id", "name", "launchPath", "daily" };

    static void ValidateState(string raw)
    {
        object parsed = Json().DeserializeObject(raw);
        Dictionary<string, object> state = parsed as Dictionary<string, object>;
        if (state == null) throw new Exception("存档格式无效");
        object gamesValue;
        if (!state.TryGetValue("games", out gamesValue)) throw new Exception("存档格式无效");
        object[] games = gamesValue as object[];
        if (games == null) throw new Exception("存档格式无效");
        HashSet<string> ids = new HashSet<string>();
        for (int i = 0; i < games.Length; i++)
        {
            Dictionary<string, object> game = games[i] as Dictionary<string, object>;
            if (game == null) throw new Exception("存档格式无效");
            object idValue;
            if (!game.TryGetValue("id", out idValue)) throw new Exception("游戏编号无效或重复");
            string id = Convert.ToString(idValue);
            if (String.IsNullOrEmpty(id) || !ids.Add(id)) throw new Exception("游戏编号无效或重复");
        }
    }

    ApiResult SaveState(string body, string revisionHeader)
    {
        long revision;
        if (!Int64.TryParse(revisionHeader, out revision)) return ApiResult.Fail(400, "保存序号无效");
        ValidateState(body);
        lock (dataLock)
        {
            if (revision <= savedRevision) return ApiResult.Fail(409, "较旧的保存请求已忽略，请重试最新修改");
            WriteAtomic(stateFile, body);
            savedRevision = revision;
        }
        return ApiResult.Ok("{\"ok\":true}");
    }

    static List<object> LoadLog()
    {
        lock (logLock)
        {
            List<object> list = new List<object>();
            if (!File.Exists(logFile)) return list;
            try
            {
                object[] raw = Json().DeserializeObject(File.ReadAllText(logFile, utf8)) as object[];
                if (raw != null)
                {
                    for (int i = 0; i < raw.Length; i++)
                    {
                        Dictionary<string, object> item = raw[i] as Dictionary<string, object>;
                        if (item != null) list.Add(item);
                    }
                }
            }
            catch { }
            return list;
        }
    }

    ApiResult SaveLogEntry(string body)
    {
        Dictionary<string, object> request = Json().DeserializeObject(body) as Dictionary<string, object>;
        if (request == null) return ApiResult.Fail(400, "日志请求格式无效");
        object actionValue;
        string action = request.TryGetValue("action", out actionValue) ? Convert.ToString(actionValue) : "append";
        int count;
        lock (logLock)
        {
            List<object> list = LoadLog();
            if (action == "clear") { list.Clear(); WriteAtomic(logFile, Json().Serialize(list)); count = 0; }
            else if (action == "append")
            {
                object entryValue;
                if (!request.TryGetValue("entry", out entryValue)) return ApiResult.Fail(400, "缺少日志条目");
                Dictionary<string, object> entry = entryValue as Dictionary<string, object>;
                if (entry == null) return ApiResult.Fail(400, "缺少日志条目");
                string[] fields = new string[] { "time", "date", "code", "name", "act" };
                for (int i = 0; i < fields.Length; i++)
                {
                    object value;
                    if (!entry.TryGetValue(fields[i], out value)) return ApiResult.Fail(400, "日志条目缺少字段：" + fields[i]);
                    string text = Convert.ToString(value).Trim();
                    if (text.Length == 0 && fields[i] != "code") return ApiResult.Fail(400, "日志字段不能为空：" + fields[i]);
                    if (text.Length > 64) return ApiResult.Fail(400, "日志字段过长：" + fields[i]);
                    entry[fields[i]] = text;
                }
                object atValue;
                if (!entry.TryGetValue("at", out atValue) || String.IsNullOrWhiteSpace(Convert.ToString(atValue)))
                    entry["at"] = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                list.Add(entry);
                if (list.Count > LogLimit) list.RemoveRange(0, list.Count - LogLimit);
                WriteAtomic(logFile, Json().Serialize(list));
                count = list.Count;
            }
            else return ApiResult.Fail(400, "未知日志操作");
        }
        return ApiResult.Ok("{\"ok\":true,\"count\":" + count + "}");
    }

    static Dictionary<string, object> LoadPrefs()
    {
        lock (prefsLock)
        {
            Dictionary<string, object> prefs = new Dictionary<string, object>();
            if (!File.Exists(prefsFile)) return prefs;
            try
            {
                Dictionary<string, object> raw = Json().DeserializeObject(File.ReadAllText(prefsFile, utf8)) as Dictionary<string, object>;
                if (raw != null) foreach (KeyValuePair<string, object> pair in raw) prefs[pair.Key] = pair.Value;
            }
            catch { }
            return prefs;
        }
    }

    ApiResult SavePref(string body)
    {
        Dictionary<string, object> request = Json().DeserializeObject(body) as Dictionary<string, object>;
        if (request == null) return ApiResult.Fail(400, "设置请求格式无效");
        object keyValue, valueValue;
        if (!request.TryGetValue("key", out keyValue) || !request.TryGetValue("value", out valueValue))
            return ApiResult.Fail(400, "缺少设置键或值");
        string key = Convert.ToString(keyValue).Trim();
        string value = Convert.ToString(valueValue);
        if (!System.Text.RegularExpressions.Regex.IsMatch(key, "^[a-z0-9._-]{1,64}$")) return ApiResult.Fail(400, "设置键无效");
        if (value.Length > 256) return ApiResult.Fail(400, "设置值过长");
        lock (prefsLock)
        {
            Dictionary<string, object> prefs = LoadPrefs();
            prefs[key] = value;
            WriteAtomic(prefsFile, Json().Serialize(prefs));
        }
        return ApiResult.Ok("{\"ok\":true}");
    }

    static string LoadLedger()
    {
        lock (dataLock)
        {
            if (!File.Exists(ledgerFile)) return null;
            try { return File.ReadAllText(ledgerFile, utf8); }
            catch (Exception error) { Trace("LEDGER-READ-ERR " + error.Message); return null; }
        }
    }

    ApiResult SaveLedger(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return ApiResult.Fail(400, "账本内容为空");
        object parsed;
        try { parsed = Json().DeserializeObject(body); }
        catch (Exception error) { return ApiResult.Fail(400, "账本 JSON 无效: " + error.Message); }
        Dictionary<string, object> payload = parsed as Dictionary<string, object>;
        if (payload == null || !(payload.ContainsKey("transactions") && payload["transactions"] is object[]))
            return ApiResult.Fail(400, "账本缺少 transactions 数组");
        lock (dataLock)
        {
            try
            {
                // 每次落盘前把上一版留成 ledger.json.bak —— 误删/误改可回退一版
                if (File.Exists(ledgerFile)) File.Copy(ledgerFile, ledgerFile + ".bak", true);
                WriteAtomic(ledgerFile, body);
            }
            catch (Exception error) { Trace("LEDGER-WRITE-ERR " + error.Message); return ApiResult.Fail(500, error.Message); }
        }
        return ApiResult.Ok("{\"ok\":true}");
    }

    static void WriteAtomic(string path, string content)
    {
        string temp = path + ".tmp";
        File.WriteAllText(temp, content, utf8);
        if (File.Exists(path)) File.Replace(temp, path, null);
        else File.Move(temp, path);
    }

    // ── 系统动作 ─────────────────────────────────────────────────────────

    ApiResult Launch(string body)
    {
        Dictionary<string, object> request = Json().DeserializeObject(body) as Dictionary<string, object>;
        if (request == null) return ApiResult.Fail(400, "缺少游戏编号");
        object idValue;
        if (!request.TryGetValue("id", out idValue)) return ApiResult.Fail(400, "缺少游戏编号");
        string id = Convert.ToString(idValue);
        string target = null;
        string raw = LoadState();
        if (raw != null)
        {
            Dictionary<string, object> state = Json().DeserializeObject(raw) as Dictionary<string, object>;
            if (state != null)
            {
                object[] games = state["games"] as object[];
                if (games != null)
                {
                    for (int i = 0; i < games.Length; i++)
                    {
                        Dictionary<string, object> game = games[i] as Dictionary<string, object>;
                        if (game == null) continue;
                        object gameId;
                        if (!game.TryGetValue("id", out gameId) || Convert.ToString(gameId) != id) continue;
                        object pathValue;
                        target = game.TryGetValue("launchPath", out pathValue) ? Convert.ToString(pathValue) : null;
                        break;
                    }
                }
            }
        }
        if (String.IsNullOrWhiteSpace(target)) return ApiResult.Fail(400, "请先在设置中保存启动位置");
        try
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.UseShellExecute = true;
            if (System.Text.RegularExpressions.Regex.IsMatch(target, "^steam://(?:rungameid|run)/[0-9]+/?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            {
                start.FileName = target;
            }
            else
            {
                target = Environment.ExpandEnvironmentVariables(target.Trim().Trim('"'));
                if (!Path.IsPathRooted(target)) return ApiResult.Fail(400, "请填写完整的程序路径");
                string ext = Path.GetExtension(target).ToLowerInvariant();
                if (ext != ".exe" && ext != ".lnk") return ApiResult.Fail(400, "请选择 .exe 程序、.lnk 快捷方式或 Steam 启动链接");
                if (!File.Exists(target)) return ApiResult.Fail(400, "启动文件不存在，请在设置中重新选择");
                start.FileName = target;
                if (ext == ".exe") start.WorkingDirectory = Path.GetDirectoryName(target);
            }
            Process.Start(start);
        }
        catch (Exception error)
        {
            return ApiResult.Fail(400, error.Message);
        }
        return ApiResult.Ok("{\"ok\":true}");
    }

    ApiResult Browse()
    {
        ApiResult result = ApiResult.Ok("{\"path\":null}");
        using (OpenFileDialog dialog = new OpenFileDialog())
        {
            dialog.Title = "选择游戏程序或快捷方式";
            dialog.Filter = "程序与快捷方式 (*.exe;*.lnk)|*.exe;*.lnk|所有文件 (*.*)|*.*";
            dialog.CheckFileExists = true;
            dialog.Multiselect = false;
            dialog.RestoreDirectory = true;
            if (dialog.ShowDialog(this) == DialogResult.OK)
                result = ApiResult.Ok("{\"path\":" + Json().Serialize(dialog.FileName) + "}");
        }
        return result;
    }

    // ── 窗口状态与迁移 ───────────────────────────────────────────────────

    void ApplySavedBounds()
    {
        bool applied = false;
        try
        {
            if (File.Exists(windowStateFile))
            {
                Dictionary<string, object> saved = Json().DeserializeObject(File.ReadAllText(windowStateFile, utf8)) as Dictionary<string, object>;
                if (saved != null)
                {
                    Rectangle bounds = new Rectangle(
                        Convert.ToInt32(saved["x"]), Convert.ToInt32(saved["y"]),
                        Convert.ToInt32(saved["w"]), Convert.ToInt32(saved["h"]));
                    if (bounds.Width > 640 && bounds.Height > 400)
                    {
                        // 存档可能是跨屏/高 DPI 下算出来的越界矩形，先夹回工作区再套用
                        Rectangle area = Screen.FromRectangle(bounds).WorkingArea;
                        bounds.Width = Math.Min(bounds.Width, area.Width);
                        bounds.Height = Math.Min(bounds.Height, area.Height);
                        if (bounds.Right > area.Right) bounds.X = area.Right - bounds.Width;
                        if (bounds.Bottom > area.Bottom) bounds.Y = area.Bottom - bounds.Height;
                        if (bounds.X < area.Left) bounds.X = area.Left;
                        if (bounds.Y < area.Top) bounds.Y = area.Top;
                        Bounds = bounds;
                        applied = true;
                    }
                    // m=1 上次是最大化；没有 m 字段（旧存档）也按最大化处理——默认就该最大化
                    object flag;
                    bool maximized = !saved.TryGetValue("m", out flag) || Convert.ToInt32(flag) == 1;
                    if (maximized) { WindowState = FormWindowState.Maximized; applied = true; }
                }
            }
        }
        catch { }
        if (!applied) WindowState = FormWindowState.Maximized;
    }

    void OnSizeChanged(object sender, EventArgs e)
    {
        if (WindowState == FormWindowState.Normal)
        {
            lastNormalBounds = Bounds;
            hasNormalBounds = true;
        }
    }

    void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        try
        {
            Dictionary<string, object> saved = new Dictionary<string, object>();
            Rectangle bounds;
            if (WindowState == FormWindowState.Normal) bounds = Bounds;
            else if (hasNormalBounds) bounds = lastNormalBounds;
            else
            {
                // 从没以正常态显示过：给一个安全的后备尺寸（工作区的九成，居中），
                // 这样点「还原」不会弹出比屏幕还大的窗口
                Rectangle area = Screen.PrimaryScreen.WorkingArea;
                bounds = new Rectangle(
                    area.X + area.Width / 20, area.Y + area.Height / 20,
                    area.Width * 9 / 10, area.Height * 9 / 10);
            }
            // 存档前再夹一次工作区：屏分辨率/缩放变了也不会写出越界矩形
            Rectangle workArea = Screen.FromRectangle(bounds).WorkingArea;
            bounds.Width = Math.Min(bounds.Width, workArea.Width);
            bounds.Height = Math.Min(bounds.Height, workArea.Height);
            if (bounds.Right > workArea.Right) bounds.X = workArea.Right - bounds.Width;
            if (bounds.Bottom > workArea.Bottom) bounds.Y = workArea.Bottom - bounds.Height;
            if (bounds.X < workArea.Left) bounds.X = workArea.Left;
            if (bounds.Y < workArea.Top) bounds.Y = workArea.Top;
            saved["x"] = bounds.X; saved["y"] = bounds.Y;
            saved["w"] = bounds.Width; saved["h"] = bounds.Height;
            saved["m"] = WindowState == FormWindowState.Maximized ? 1 : 0;
            WriteAtomic(windowStateFile, Json().Serialize(saved));
        }
        catch { }
    }

    void MigrateFromOldApp()
    {
        // 首次运行：把旧版（外部 Edge 版）的存档复制过来，不动原件
        if (File.Exists(stateFile)) return;
        if (!Directory.Exists(oldDataDir)) return;
        string[] names = new string[] { "state.json", "daily-log.json", "prefs.json" };
        for (int i = 0; i < names.Length; i++)
        {
            string from = Path.Combine(oldDataDir, names[i]);
            if (!File.Exists(from)) continue;
            try { File.Copy(from, Path.Combine(dataDir, names[i]), false); } catch { }
        }
    }
}
