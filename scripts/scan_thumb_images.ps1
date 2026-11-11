# 扫描 addons 目录下的所有封面图片，按像素数排序，用于定位「超大图导致卡片滚动掉帧」的问题
param(
    [string]$Root = 'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons'
)

Add-Type -AssemblyName System.Drawing

$extPattern = '^\.(jpg|jpeg|png|webp|bmp|gif)$'
$files = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match $extPattern }

Write-Output "IMAGE FILE COUNT: $($files.Count)"

$rows = foreach ($f in $files) {
    $w = 0
    $h = 0
    $frames = 0
    try {
        $img = [System.Drawing.Image]::FromFile($f.FullName)
        $w = $img.Width
        $h = $img.Height
        try {
            $frames = $img.GetFrameCount([System.Drawing.Imaging.FrameDimension]::Time)
        } catch {
            $frames = 1
        }
        $img.Dispose()
    } catch {
        $w = -1
        $h = -1
    }
    [pscustomobject]@{
        Name   = $f.Name
        Ext    = $f.Extension
        KB     = [math]::Round($f.Length / 1KB, 1)
        W      = $w
        H      = $h
        Frames = $frames
        Pixels = if ($w -gt 0) { [int64]$w * $h } else { 0 }
        Path   = $f.FullName
    }
}

Write-Output '--- TOP 25 BY PIXEL COUNT ---'
$rows | Sort-Object Pixels -Descending | Select-Object -First 25 | Format-Table -AutoSize

Write-Output '--- TOP 25 BY FILE SIZE ---'
$rows | Sort-Object KB -Descending | Select-Object -First 25 | Format-Table -AutoSize

Write-Output '--- ANIMATED (multi-frame) IMAGES ---'
$rows | Where-Object { $_.Frames -gt 1 } | Format-Table -AutoSize

Write-Output '--- HUGE (>4000px on any edge) ---'
$rows | Where-Object { $_.W -gt 4000 -or $_.H -gt 4000 } | Format-Table -AutoSize

Write-Output '--- LARGE FILES (>2MB) ---'
$rows | Where-Object { $_.KB -gt 2048 } | Format-Table -AutoSize

Write-Output '--- UNREADABLE / DECODE FAILED ---'
$rows | Where-Object { $_.W -lt 0 } | Select-Object Name, KB, Path | Format-Table -AutoSize
