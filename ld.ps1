param(
    [string]$command = "help"
)

# 无论从哪个目录调用，都以脚本所在目录为项目根目录
# （PowerShell 里 `.\ld` 实际解析到 ld.ps1；报“无法识别 .\ld”通常是因为当前目录不是项目根目录）
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:projectRoot = $rootDir

function Get-ProjectProcesses {
    # 只结束「可执行文件位于项目目录内」的进程（项目自带的 Electron / 内置或虚拟环境 Python）。
    # 关键：绝不按“命令行里出现项目路径”去杀 node.exe —— 那会误伤编辑器 / 终端 / 其它工具
    # （实测会把承载当前终端的进程杀掉，导致终端直接关闭）。
    $root = $script:projectRoot
    Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
        }
}

function Stop-ProjectProcesses {
    $targets = @(Get-ProjectProcesses)
    foreach ($p in $targets) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    return $targets.Count
}

function Stop-StaleViteOn5173 {
    # 5173 的占用者若是 node.exe（上一次没退干净的 Vite），只结束这一个 PID。
    # 端口被别的程序占用时不动它（改为提示用户）。
    try {
        $conns = @(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
    } catch {
        $conns = @()
    }
    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; return $true } catch { }
        }
    }
    return $false
}

function Test-Port5173Busy {
    try {
        return [bool](Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return [bool](netstat -ano | Select-String ":5173\s+.*LISTENING")
    }
}

switch ($command.ToLower()) {
    "run" {
        Set-Location $rootDir
        Write-Host "========================================"
        Write-Host "  Starting L4D2 Manager (Ctrl+C to stop)"
        Write-Host "========================================"
        Write-Host ""

        # 清理上次残留的本项目进程（项目自带的 Electron / Python），
        # 以及占用 5173 的残留 Vite（按端口精确结束，不误伤其它 node 程序）
        $killed = Stop-ProjectProcesses
        if ($killed -gt 0) { Write-Host "[准备] 已清理上次残留进程: $killed 个" }
        if (Stop-StaleViteOn5173) { Write-Host "[准备] 已结束占用 5173 的残留 Vite(node)" }
        Start-Sleep -Milliseconds 400

        # 5173 被别的程序占用时 Vite 会启动失败，而 Electron 会连上旧/坏的 dev server 导致白屏
        if (Test-Port5173Busy) {
            Write-Host "[警告] 端口 5173 仍被占用，Vite 将无法启动（Electron 可能连上旧页面）。" -ForegroundColor Yellow
            Write-Host "       可执行:  netstat -ano | findstr :5173   找到 PID 后结束它" -ForegroundColor Yellow
            Read-Host "        按回车继续 / Ctrl+C 取消"
        }

        # 后端由 Electron 主进程在加载页面的同时并行启动（不再串行等待后端就绪）
        Write-Host "[1/1] Starting Electron + Vite frontend (backend starts in parallel)..."
        Write-Host ""
        Write-Host "--------------------------------------------------"
        Write-Host "  Backend:  http://localhost:8288"
        Write-Host "  Frontend: http://localhost:5173"
        Write-Host "  Press Ctrl+C to stop everything"
        Write-Host "--------------------------------------------------"
        Write-Host ""

        Set-Location (Join-Path $rootDir "frontend")

        try {
            npm run dev
        } finally {
            Write-Host ""
            Write-Host "Shutting down all services..."
            Set-Location $rootDir
            $killed = Stop-ProjectProcesses
            if ($killed -gt 0) { Write-Host "已结束本项目进程: $killed 个" }
            if (Stop-StaleViteOn5173) { Write-Host "已结束残留 Vite(node)" }
            Write-Host "All services stopped. Goodbye!"
            Write-Host ""
        }
    }
    "backend" {
        Set-Location $rootDir
        Write-Host "[1/2] Starting Python backend (port 8288)..."
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "python"
        $psi.Arguments = "main.py"
        $psi.WorkingDirectory = Join-Path $rootDir "backend"
        $psi.UseShellExecute = $true
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized
        $psi.CreateNoWindow = $false
        $backendProcess = [System.Diagnostics.Process]::Start($psi)
        Write-Host "Backend started"
    }
    default {
        Write-Host "========================================"
        Write-Host "  L4D2 Manager - Launch"
        Write-Host "========================================"
        Write-Host ""
        Write-Host "Usage:"
        Write-Host "  .\ld run      - Start full project, press Ctrl+C to stop"
        Write-Host "  .\ld backend  - Start backend only"
        Write-Host "  .\ld help     - Show this help"
        Write-Host ""
        Write-Host "Tip: ld run keeps running. Press Ctrl+C to stop all."
        Write-Host ""
        Write-Host "【若提示 “无法识别 .\ld”】说明当前终端不在项目根目录，"
        Write-Host "  先执行：cd `"$rootDir`"   然后再次运行 .\ld run"
        Write-Host "  或用完整路径：& `"$rootDir\ld.ps1`" run"
        Write-Host ""
    }
}
