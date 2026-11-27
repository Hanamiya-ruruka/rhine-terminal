using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

public partial class RhineTerminal
{
    const string AssistantPrefix = "/api/assistant/";
    const string AssistantVersion = "3.0";
    const int AssistantBodyLimit = 4194304;

    readonly object assistantLock = new object();
    readonly SemaphoreSlim assistantWake = new SemaphoreSlim(0, 1);
    readonly Queue<AssistantJob> assistantQueue = new Queue<AssistantJob>();
    readonly Dictionary<string, AssistantJob> assistantJobs = new Dictionary<string, AssistantJob>();
    string assistantSettingsFile, assistantEndpointFile;
    bool assistantEnabled;
    HttpListener assistantListener;

    sealed class AssistantJob
    {
        public string Id, Signature, Lease;
        public object Request, Result;
        public bool Dispatched;
        public readonly TaskCompletionSource<bool> Finished =
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    void LoadAssistantSettings()
    {
        assistantSettingsFile = Path.Combine(dataDir, "assistant-settings.json");
        assistantEndpointFile = Path.Combine(dataDir, "assistant-endpoint.json");
        object enabled;
        assistantEnabled = ReadAssistantSettings().TryGetValue("enabled", out enabled) && enabled is bool && (bool)enabled;
    }

    Dictionary<string, object> ReadAssistantSettings()
    {
        try
        {
            if (File.Exists(assistantSettingsFile))
            {
                var settings = Json().DeserializeObject(File.ReadAllText(assistantSettingsFile, utf8))
                    as Dictionary<string, object>;
                if (settings != null) return settings;
            }
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
        return new Dictionary<string, object>();
    }

    void StartAssistantListener()
    {
        File.Delete(assistantEndpointFile);
        string token;
        var randomBytes = new byte[16];
        using (var random = RandomNumberGenerator.Create())
        {
            random.GetBytes(randomBytes);
            token = BitConverter.ToString(randomBytes).Replace("-", "").ToLowerInvariant();
        }

        var ports = new Random();
        for (int attempt = 0; attempt < 20; attempt++)
        {
            int port = ports.Next(20000, 65001);
            var listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            try { listener.Start(); }
            catch (HttpListenerException) { listener.Close(); continue; }

            try
            {
                using (var process = Process.GetCurrentProcess())
                    WriteAtomic(assistantEndpointFile, Json().Serialize(new
                    {
                        port, token, pid = process.Id, version = AssistantVersion,
                        startedAt = DateTimeOffset.UtcNow.ToString("o")
                    }));
            }
            catch
            {
                listener.Close();
                throw;
            }

            assistantListener = listener;
            FormClosed += (sender, args) => StopAssistantListener();
            Application.ApplicationExit += OnAssistantApplicationExit;
            AcceptAssistantRequests(listener, token);
            return;
        }
        Trace("AI: 无法绑定回环端口");
    }

    void OnAssistantApplicationExit(object sender, EventArgs args) { StopAssistantListener(); }

    void StopAssistantListener()
    {
        if (assistantListener == null) return;
        Application.ApplicationExit -= OnAssistantApplicationExit;
        assistantListener.Close();
        assistantListener = null;
        File.Delete(assistantEndpointFile);
    }

    async void AcceptAssistantRequests(HttpListener listener, string token)
    {
        try
        {
            while (listener.IsListening)
            {
                var context = await listener.GetContextAsync().ConfigureAwait(false);
                ThreadPool.QueueUserWorkItem(_ => ServeAssistantRequest(context, token));
            }
        }
        catch (ObjectDisposedException) { }
        catch (HttpListenerException) { }
    }

    async void ServeAssistantRequest(HttpListenerContext context, string token)
    {
        var request = context.Request;
        var response = context.Response;
        try
        {
            if (!String.Equals(request.Headers["X-Desktop-Token"], token, StringComparison.Ordinal) ||
                !IPAddress.IsLoopback(request.RemoteEndPoint.Address) ||
                !IPAddress.Loopback.Equals(request.LocalEndPoint.Address))
            {
                response.StatusCode = 403;
                return;
            }
            string path = request.Url.AbsolutePath;
            if (!path.StartsWith(AssistantPrefix, StringComparison.Ordinal))
            {
                response.StatusCode = 404;
                return;
            }

            ApiResult result;
            try
            {
                string body = request.HttpMethod == "POST" ? await ReadAssistantBodyAsync(request).ConfigureAwait(false) : "";
                string route = path.Substring("/api/".Length);
                result = await DispatchAssistantAsync(route, request.HttpMethod, body).ConfigureAwait(false);
                if (route == "assistant/settings" && request.HttpMethod == "POST" && result.Status == 200)
                    ScheduleAssistantControlsRefresh();
            }
            catch (Exception error) { result = ApiResult.Fail(400, error.Message); }

            var payload = utf8.GetBytes(result.Body);
            response.StatusCode = result.Status;
            response.ContentType = "application/json; charset=utf-8";
            response.Headers["Cache-Control"] = "no-store";
            response.ContentLength64 = payload.Length;
            await response.OutputStream.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
        }
        catch (IOException) { }
        catch (HttpListenerException) { }
        catch (ObjectDisposedException) { }
        finally { response.Close(); }
    }

    static async Task<string> ReadAssistantBodyAsync(HttpListenerRequest request)
    {
        if (request.ContentLength64 > AssistantBodyLimit) throw new Exception("请求体大小无效");
        using (var buffer = new MemoryStream())
        {
            var chunk = new byte[8192];
            int read;
            while ((read = await request.InputStream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > AssistantBodyLimit) throw new Exception("请求体大小无效");
                buffer.Write(chunk, 0, read);
            }
            return utf8.GetString(buffer.ToArray());
        }
    }

    void ScheduleAssistantControlsRefresh()
    {
        if (!IsHandleCreated) return;
        try { BeginInvoke(new Action(RefreshAssistantControls)); }
        catch (InvalidOperationException) { }
    }

    async void RefreshAssistantControls()
    {
        if (IsDisposed || view.IsDisposed || view.CoreWebView2 == null) return;
        try { await RefreshAssistantControlsAsync(); }
        catch (InvalidOperationException) { }
        catch (System.Runtime.InteropServices.COMException) { }
    }

    Task RefreshAssistantControlsAsync()
    {
        bool enabled;
        lock (assistantLock) enabled = assistantEnabled;
        // The existing page reads settings once at boot. Synchronize its cached switch
        // when a loopback client changes settings, including before delivering a command.
        return view.CoreWebView2.ExecuteScriptAsync(
            "if (typeof assistantAllowed === 'boolean') {" +
            "assistantAllowed = " + (enabled ? "true" : "false") + ";" +
            "document.getElementById('assistantEnabled').checked = assistantAllowed;" +
            "document.getElementById('assistantStatus').textContent = assistantAllowed ?" +
            "'AI操作已开启，等待 Bionic 指令' : 'AI操作已关闭';}");
    }

    void WakeAssistantPoll()
    {
        lock (assistantLock)
        {
            if (assistantWake.CurrentCount == 0) assistantWake.Release();
        }
    }

    static ApiResult AssistantJson(object body) { return ApiResult.Ok(Json().Serialize(body)); }

    static object AssistantError(string id, string code, string message)
    {
        return new { ok = false, requestId = id, code, message };
    }

    async Task<ApiResult> DispatchAssistantAsync(string route, string method, string body, bool fromWebView = false)
    {
        if (route == "assistant/settings" && method == "GET")
        {
            lock (assistantLock) return AssistantJson(new { enabled = assistantEnabled, version = AssistantVersion });
        }
        if (method != "POST") return ApiResult.Fail(405, "请求方法不支持");

        var request = Json().DeserializeObject(body) as Dictionary<string, object>;
        if (request == null) throw new Exception("指令格式无效");
        switch (route)
        {
            case "assistant/settings": return SetAssistantSettings(request);
            case "assistant/poll":
                var job = await PollAssistantAsync();
                if (job != null && fromWebView) await RefreshAssistantControlsAsync();
                return AssistantJson(new
                {
                    command = job == null ? null : new { requestId = job.Id, lease = job.Lease, request = job.Request }
                });
            case "assistant/complete": return CompleteAssistantJob(request);
            case "assistant/command": return await SubmitAssistantCommandAsync(request).ConfigureAwait(false);
            default:
                return new ApiResult
                {
                    Status = 404,
                    Body = Json().Serialize(AssistantError(null, "unsupported", "不支持的AI接口"))
                };
        }
    }

    ApiResult SetAssistantSettings(Dictionary<string, object> request)
    {
        object value;
        if (!request.TryGetValue("enabled", out value) || !(value is bool)) throw new Exception("开关值无效");
        bool enabled = (bool)value;
        lock (assistantLock)
        {
            var settings = ReadAssistantSettings();
            settings["enabled"] = enabled;
            WriteAtomic(assistantSettingsFile, Json().Serialize(settings));
            assistantEnabled = enabled;
            if (!enabled)
            {
                foreach (var job in assistantJobs.Values)
                {
                    if (job.Result != null) continue;
                    job.Result = AssistantError(job.Id, "disabled", "AI操作已关闭，指令未执行");
                    job.Finished.TrySetResult(true);
                }
                assistantQueue.Clear();
            }
        }
        WakeAssistantPoll();
        return AssistantJson(new { ok = true, enabled });
    }

    async Task<AssistantJob> PollAssistantAsync()
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < 5000)
        {
            lock (assistantLock)
            {
                while (assistantEnabled && assistantQueue.Count > 0)
                {
                    var job = assistantQueue.Dequeue();
                    if (job.Result != null) continue;
                    job.Dispatched = true;
                    job.Lease = Guid.NewGuid().ToString("N");
                    if (assistantQueue.Count > 0) WakeAssistantPoll();
                    return job;
                }
            }
            int remaining = 5000 - (int)elapsed.ElapsedMilliseconds;
            if (remaining > 0) await assistantWake.WaitAsync(remaining).ConfigureAwait(false);
        }
        return null;
    }

    ApiResult CompleteAssistantJob(Dictionary<string, object> request)
    {
        string id = AssistantString(request, "requestId"), lease = AssistantString(request, "lease");
        object result, ok;
        var answer = request.TryGetValue("result", out result) ? result as Dictionary<string, object> : null;
        if (answer == null || !answer.TryGetValue("ok", out ok) || !(ok is bool)) throw new Exception("操作结果无效");
        lock (assistantLock)
        {
            AssistantJob job;
            if (!assistantJobs.TryGetValue(id, out job) || !job.Dispatched || job.Lease != lease)
                throw new Exception("指令回执无效");
            if (job.Result == null)
            {
                answer["requestId"] = id;
                job.Result = answer;
                job.Finished.TrySetResult(true);
            }
        }
        return AssistantJson(new { ok = true });
    }

    async Task<ApiResult> SubmitAssistantCommandAsync(Dictionary<string, object> request)
    {
        string requestId = AssistantString(request, "requestId"), action = AssistantString(request, "action");
        if (!Regex.IsMatch(requestId, @"\A[A-Za-z0-9_-]{8,80}\z")) throw new Exception("指令编号无效");
        if (action != "list" && action != "set_completion" && action != "launch" &&
            action != "topup_monthcard" && action != "set_pool_date" && action != "add_pulls")
            throw new Exception("不支持此AI操作");

        string gameId = AssistantString(request, "gameId"), field = AssistantString(request, "field");
        if (action != "list" && (String.IsNullOrEmpty(gameId) || gameId.Length > 128)) throw new Exception("缺少有效游戏编号");
        object done, count;
        request.TryGetValue("done", out done);
        request.TryGetValue("count", out count);
        if (action == "set_completion" && ((field != "daily" && field != "weekly") || !(done is bool)))
            throw new Exception("完成状态参数无效");

        string date = AssistantString(request, "date"), pool = AssistantString(request, "pool");
        DateTime parsedDate;
        if (action == "set_pool_date" && (!Regex.IsMatch(date, @"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z") ||
            !DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out parsedDate)))
            throw new Exception("卡池日期必须为有效的YYYY-MM-DD日期");
        if (action == "add_pulls" && ((pool != "character" && pool != "weapon") ||
            !(count is int) || (int)count < 1 || (int)count > 99999))
            throw new Exception("请明确角色/武器池，并提供1到99999的整数抽数");

        string signature = Json().Serialize(new { action, gameId, field, date, pool, done, count });
        AssistantJob current;
        lock (assistantLock)
        {
            if (assistantJobs.TryGetValue(requestId, out current))
            {
                if (current.Signature != signature) throw new Exception("同一指令编号不能用于不同操作");
            }
            else
            {
                if (!assistantEnabled)
                    return AssistantJson(AssistantError(requestId, "disabled", "请先在日常小助手设置中开启允许AI操作"));
                if (assistantJobs.Count >= 4096)
                    return AssistantJson(AssistantError(requestId, "session_full", "本次运行的AI指令记录已满，请退出并重新打开小助手"));
                int waiting = 0;
                foreach (var job in assistantJobs.Values) if (job.Result == null) waiting++;
                if (waiting >= 6)
                    return AssistantJson(AssistantError(requestId, "busy", "AI指令正在处理，请稍后重试"));
                current = new AssistantJob { Id = requestId, Signature = signature, Request = request };
                assistantJobs.Add(requestId, current);
                assistantQueue.Enqueue(current);
            }
        }
        WakeAssistantPoll();
        if (!current.Finished.Task.IsCompleted)
            await Task.WhenAny(current.Finished.Task, Task.Delay(25000)).ConfigureAwait(false);

        lock (assistantLock)
        {
            if (current.Result == null && !current.Dispatched)
            {
                current.Result = AssistantError(requestId, "not_executed", "小助手界面未响应，指令未执行。请打开窗口后重试");
                current.Finished.TrySetResult(true);
            }
            return AssistantJson(current.Result ?? AssistantError(requestId, "outcome_unknown",
                "指令已交给界面，尚未收到结果。不要重复启动；使用相同RequestId查询结果或检查界面"));
        }
    }

    static string AssistantString(Dictionary<string, object> value, string key)
    {
        object item;
        return value.TryGetValue(key, out item) && item is string ? (string)item : "";
    }
}
