param(
    [ValidateSet('list','set_completion','launch','topup_monthcard','set_pool_date','add_pulls')][string]$Action = 'list',
    [string]$GameId = '',
    [ValidateSet('daily','weekly','')][string]$Field = '',
    [ValidateSet('true','false','')][string]$Done = '',
    [string]$RequestId = '',
    [string]$PoolDate = '',
    [ValidateSet('character','weapon','')][string]$Pool = '',
    [string]$Count = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if (-not $RequestId) { $RequestId = [Guid]::NewGuid().ToString('N') }
function Fail([string]$Code, [string]$Message) {
    @{ok=$false;requestId=$RequestId;code=$Code;message=$Message} | ConvertTo-Json -Compress -Depth 10
    exit 1
}
if ($RequestId -notmatch '\A[A-Za-z0-9_-]{8,80}\z') { Fail 'invalid_arguments' 'RequestId格式无效' }
if ($Action -ne 'list' -and -not $GameId) { Fail 'invalid_arguments' '请先查看列表并使用返回的游戏id' }
if ($Action -eq 'set_completion' -and (-not $Field -or -not $Done)) { Fail 'invalid_arguments' '设置完成状态需要Field和Done（true或false）' }
$request = @{requestId=$RequestId;action=$Action}
if ($Action -ne 'list') { $request.gameId = $GameId }
if ($Action -eq 'set_completion') { $request.field=$Field; $request.done=($Done -eq 'true') }
if ($Action -eq 'set_pool_date') {
    $parsedPoolDate = [datetime]::MinValue
    if ($PoolDate -notmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z' -or -not [datetime]::TryParseExact($PoolDate,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsedPoolDate)) { Fail 'invalid_arguments' '请提供有效的YYYY-MM-DD卡池日期' }
    $request.date = $PoolDate
}
if ($Action -eq 'add_pulls') {
    if (-not $Pool -or $Count -notmatch '\A[1-9][0-9]{0,4}\z') { Fail 'invalid_arguments' '请明确角色/武器池，并提供1到99999的整数抽数' }
    $request.pool=$Pool; $request.count=[int]$Count
}
$connectionFile = Join-Path $env:LOCALAPPDATA 'PersonalGRhineTerminal\assistant-endpoint.json'
if (-not (Test-Path -LiteralPath $connectionFile)) { Fail 'not_running' '请先打开日常小助手v0.7.0或更新版' }
try { $endpointJson = [IO.File]::ReadAllText($connectionFile) }
catch { Fail 'connection_error' '无法读取小助手连接信息，请重新打开小助手' }
try { $endpoint = ConvertFrom-Json -InputObject $endpointJson }
catch { Fail 'invalid_connection' '本地连接信息无效，请重新打开小助手' }
if ($endpoint.port -notmatch '\A[0-9]{1,5}\z' -or $endpoint.token -cnotmatch '\A[a-f0-9]{32}\z') { Fail 'invalid_connection' '本地连接信息无效，请重新打开小助手' }
$portNumber = [int]$endpoint.port
$desktopToken = [string]$endpoint.token
if ($portNumber -lt 20000 -or $portNumber -gt 65000) { Fail 'invalid_connection' '本地连接端口无效' }
# 进程可能崩过：发现文件还在但 pid 已死，直接判 not_running，别去撞连接
if ($endpoint.pid) {
    $alive = $null -ne (Get-Process -Id ([int]$endpoint.pid) -ErrorAction SilentlyContinue)
    if (-not $alive) { Fail 'not_running' '小助手已退出（发现文件是上次残留），请重新打开' }
}
$address = "http://127.0.0.1:${portNumber}/"
try {
    $body = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
    # Keep the connection URL and token inside this helper; output only operation results.
    $response = Invoke-RestMethod -Uri ($address + 'api/assistant/command') -Method Post -Headers @{'X-Desktop-Token'=$desktopToken} -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 40
    $response | ConvertTo-Json -Compress -Depth 15
    if ($response.ok -ne $true) { exit 1 }
} catch {
    Fail 'connection_error' '未收到有效执行结果。请检查小助手是否已升级并打开；不要重复充值、累加抽数或启动游戏，可使用相同RequestId查询或检查界面'
}

