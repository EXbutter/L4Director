# 端到端验证「卡片缩略图转码」是否真的能消灭卡顿元凶：
#   1. 启动临时后端（提供 /api/thumbnail 接口）
#   2. 用 esbuild 打包 src/renderer/utils/thumbnailImage.ts（跑的就是生产代码）
#   3. 在真实 Electron（Chromium）里对几张「问题图」执行转码
#
# 期望结果：
#   - 8504x8504 的巨图      -> 转码为静态小图（几十 KB）
#   - 28MB / 81 帧的伪 jpg  -> 转码为静态小图（几十 KB，且不再有动画）
#   - 640x360 的普通小图    -> 直接使用原图（不做无谓转码）
param(
    [string]$Root = 'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons',
    [int]$Port = 8289
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$repo = Split-Path $PSScriptRoot -Parent
$python = Join-Path $repo '.venv\Scripts\python.exe'
$backend = Join-Path $repo 'backend'
$frontend = Join-Path $repo 'frontend'
$utilOut = Join-Path $PSScriptRoot '.tmp-thumb-util.js'

$proc = $null
try {
    Write-Output "== 启动临时后端 (127.0.0.1:$Port) =="
    $proc = Start-Process -FilePath $python -ArgumentList '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', $Port `
        -WorkingDirectory $backend -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 4

    Write-Output '== 打包 thumbnailImage.ts（esbuild）=='
    $esbuild = Join-Path $frontend 'node_modules\.bin\esbuild.cmd'
    if (-not (Test-Path $esbuild)) { throw "找不到 esbuild: $esbuild" }
    & $esbuild (Join-Path $frontend 'src\renderer\utils\thumbnailImage.ts') --bundle --format=iife --global-name=ThumbUtil --outfile=$utilOut 2>$null | Out-Null
    if (-not (Test-Path $utilOut)) { throw 'esbuild 打包失败' }

    # 挑选验证目标
    $picks = @(
        @{ name = '8504x8504 巨图';       filter = '3363891764.jpg' },
        @{ name = '28MB/81帧 伪 jpg';     filter = '2926277287.jpg' },
        @{ name = '250x250 小尺寸动图';   filter = '3322300698.jpg' },
        @{ name = '640x360 普通图';       filter = '1529915869.jpg' }
    )
    $targets = @()
    foreach ($pick in $picks) {
        $file = Get-ChildItem -Path $Root -Recurse -File -Filter $pick.filter -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $file) { Write-Output "  (未找到 $($pick.filter)，跳过)"; continue }
        $targets += [pscustomobject]@{
            name = $pick.name
            url  = "http://127.0.0.1:$Port/api/thumbnail?path=" + [uri]::EscapeDataString($file.FullName)
        }
    }
    if ($targets.Count -eq 0) { throw '没有可用的验证目标' }

    Write-Output '== 在 Electron 中执行转码 =='
    $reportOut = Join-Path $PSScriptRoot '.tmp-thumb-report.json'
    Remove-Item $reportOut -ErrorAction SilentlyContinue
    $env:THUMB_UTIL = $utilOut
    $env:THUMB_OUT = $reportOut
    $env:THUMB_TARGETS = ($targets | ConvertTo-Json -Compress)

    $electron = Join-Path $frontend 'node_modules\.bin\electron.cmd'
    if (-not (Test-Path $electron)) { throw "找不到 electron: $electron" }

    Push-Location $repo
    # Electron 会往 stderr 打一堆无关警告（libpng/GPU 等），PowerShell 在
    # $ErrorActionPreference='Stop' 下会把它当成终止错误，这里临时放宽
    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $electron (Join-Path $PSScriptRoot 'verify-thumb-electron.cjs') 2>$null | Out-Null
    $ErrorActionPreference = $prevErrorAction
    Pop-Location

    if (-not (Test-Path $reportOut)) { throw 'Electron 未产出验证报告' }
    $report = Get-Content $reportOut -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Output '=== Electron 转码验证结果 ==='
    foreach ($row in $report) {
        $size = if ($null -ne $row.kb) { " -> $($row.kb) KB" } else { '' }
        Write-Output ("  {0}: {1}{2} ({3} ms)" -f $row.name, $row.action, $size, $row.ms)
        if ($row.probe) { Write-Output ("      探测: {0}" -f $row.probe) }
    }
} finally {
    Remove-Item Env:\THUMB_UTIL -ErrorAction SilentlyContinue
    Remove-Item Env:\THUMB_OUT -ErrorAction SilentlyContinue
    Remove-Item Env:\THUMB_TARGETS -ErrorAction SilentlyContinue
    Remove-Item $utilOut -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $PSScriptRoot '.tmp-thumb-report.json') -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
        Write-Output "== 已停止临时后端 (PID $($proc.Id)) =="
    }
}
