# Personal G Rhine Terminal —— 构建与启动
# 指纹策略：src/*.cs 与 build/lib/*.dll 任一变化才重新编译；否则直接启动。
$ErrorActionPreference = 'Stop'
try {
    $buildDir = $PSScriptRoot
    $projectDir = Split-Path -Parent $buildDir
    $srcDir = Join-Path $projectDir 'src'
    $libDir = Join-Path $buildDir 'lib'
    $exePath = Join-Path $projectDir 'RhineTerminal.exe'
    $iconPath = Join-Path $projectDir 'web\app-win.ico'
    $hashPath = Join-Path $buildDir 'build.txt'
    $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

    if (-not (Test-Path $csc)) { throw "找不到 C# 编译器：$csc" }

    $sourceFiles = Get-ChildItem -Path $srcDir -Filter *.cs | Sort-Object Name
    if ($sourceFiles.Count -eq 0) { throw "src\ 下没有 .cs 文件" }

    $fingerprint = ''
    foreach ($file in $sourceFiles) {
        $fingerprint += (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash + ';'
    }
    foreach ($dll in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        $fingerprint += (Get-FileHash -Path (Join-Path $libDir $dll) -Algorithm SHA256).Hash + ';'
    }
    # 图标也在指纹里：只换图标也要重编译，否则 exe 里还是旧图标
    if (Test-Path $iconPath) { $fingerprint += (Get-FileHash -Path $iconPath -Algorithm SHA256).Hash + ';' }
    $fingerprint += (Get-FileHash -Path $PSCommandPath -Algorithm SHA256).Hash

    $built = if (Test-Path $hashPath) { (Get-Content -Path $hashPath -Raw).Trim() } else { '' }

    if ((-not (Test-Path $exePath)) -or $fingerprint -ne $built) {
        Write-Host '编译中…'
        if (Test-Path $exePath) { Remove-Item $exePath -ErrorAction Stop }

        $arguments = @(
            '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
            ('/out:' + $exePath),
            ('/win32icon:' + $iconPath),
            '/reference:System.dll',
            '/reference:System.Core.dll',
            '/reference:System.Drawing.dll',
            '/reference:System.Windows.Forms.dll',
            '/reference:System.Web.Extensions.dll',
            ('/reference:' + (Join-Path $libDir 'Microsoft.Web.WebView2.Core.dll')),
            ('/reference:' + (Join-Path $libDir 'Microsoft.Web.WebView2.WinForms.dll'))
        )
        foreach ($file in $sourceFiles) { $arguments += $file.FullName }

        & $csc $arguments
        if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

        Set-Content -Path $hashPath -Value $fingerprint -Encoding ASCII
        Write-Host '编译完成'
    }

    # 运行时依赖放在 exe 旁边
    foreach ($dll in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        Copy-Item -Path (Join-Path $libDir $dll) -Destination (Join-Path $projectDir $dll) -Force
    }

    Start-Process -FilePath $exePath -WorkingDirectory $projectDir
} catch {
    $detail = $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show("构建或启动失败：`r`n$detail", 'Personal G Rhine Terminal') | Out-Null
    Write-Error $detail
}
