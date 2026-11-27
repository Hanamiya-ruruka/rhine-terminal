[CmdletBinding(SupportsShouldProcess)]
param([switch]$StopWatcher)

$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AutoDailyWatch'
$watchRoot = Split-Path -Parent $PSScriptRoot
$watchScript = Join-Path $watchRoot 'auto_daily.py'
$backupDir = $null

function New-BackupDirectory {
    $name = 'auto-daily-startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')
    (New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA $name)).FullName
}

$key = Get-Item -LiteralPath $runKey -ErrorAction SilentlyContinue
if ($key -and $key.GetValueNames() -contains $valueName) {
    if ($PSCmdlet.ShouldProcess("HKCU Run\$valueName", 'Back up and remove startup entry')) {
        $backupDir = New-BackupDirectory
        [pscustomobject]@{
            Name = $valueName
            Value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Kind = $key.GetValueKind($valueName).ToString()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'startup.json') -Encoding UTF8
        Remove-ItemProperty -LiteralPath $runKey -Name $valueName
        Write-Output "Removed $valueName. Backup: $backupDir"
    }
}

if ($StopWatcher) {
    $scriptPattern = '^\s*(?:"[^"]*\\pythonw\.exe"|\S*pythonw\.exe)\s+(?:"' +
        [regex]::Escape($watchScript) + '"|' + [regex]::Escape($watchScript) + ')\s+--watch(?:\s|$)'
    $watchers = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
        Where-Object { $_.CommandLine -match $scriptPattern }
    foreach ($watcher in $watchers) {
        if ($PSCmdlet.ShouldProcess("watcher PID $($watcher.ProcessId)", 'Back up session data and stop')) {
            if (-not $backupDir) { $backupDir = New-BackupDirectory }
            foreach ($name in 'runtime.json', 'open-sessions.json') {
                $dataFile = Join-Path (Join-Path $watchRoot 'data') $name
                if (Test-Path -LiteralPath $dataFile -PathType Leaf) {
                    Copy-Item -LiteralPath $dataFile -Destination $backupDir
                }
            }
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($watcher.ProcessId)"
            if ($current -and $current.CreationDate -eq $watcher.CreationDate -and
                $current.CommandLine -eq $watcher.CommandLine) {
                Stop-Process -Id $watcher.ProcessId
                Write-Output "Stopped watcher PID $($watcher.ProcessId). Backup: $backupDir"
            }
        }
    }
}
