# 只编译，不启动（给验收用）
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $projectDir 'src'
$libDir = Join-Path $projectDir 'build\lib'
$exePath = Join-Path $projectDir 'RhineTerminal.exe'
$iconPath = Join-Path $projectDir 'web\app-win.ico'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (Test-Path $exePath) { Remove-Item $exePath -ErrorAction Stop }

$args = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    ('/out:' + $exePath),
    ('/win32icon:' + $iconPath),
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    ('/reference:' + (Join-Path $libDir 'Microsoft.Web.WebView2.Core.dll')),
    ('/reference:' + (Join-Path $libDir 'Microsoft.Web.WebView2.WinForms.dll'))
)
foreach ($f in (Get-ChildItem -Path $srcDir -Filter *.cs | Sort-Object Name)) { $args += $f.FullName }

& $csc $args
if ($LASTEXITCODE -ne 0) { Write-Host "COMPILE_FAILED $LASTEXITCODE"; exit 1 }

foreach ($dll in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
    Copy-Item -Path (Join-Path $libDir $dll) -Destination (Join-Path $projectDir $dll) -Force
}
Write-Host ("COMPILE_OK " + (Get-Item $exePath).Length + " bytes")
