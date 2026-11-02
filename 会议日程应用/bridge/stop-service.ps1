# ============================================================
#  停止「会议日程 · 同步服务」，并取消开机自启
#  说明：平时它自己不会停；只有运行本脚本才会停。
#        停止后需运行「恢复自启动.bat」才会重新自启。
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch {}

$app      = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $app 'logs'
$taskName = 'MeetingSyncBridge'

# 递归结束进程树（子进程先结束，避免孤儿）
function Stop-ProcessTree($id) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ProcessTree $_.ProcessId
    }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '  正在停止「会议日程 · 同步服务」……' -ForegroundColor Cyan
Write-Host ''

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Content -Path (Join-Path $logDir '.stopped') -Value ('stopped at ' + (Get-Date -Format 'o')) -Encoding UTF8

# 1) 禁用计划任务：开机不再自启
Disable-ScheduledTask -TaskName $taskName | Out-Null

# 2) 结束正在运行的任务实例
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

# 3) 结束后台守护进程（连带它的子进程）
$pidFile = Join-Path $logDir 'daemon.pid'
if (Test-Path $pidFile) {
    $dpid = (Get-Content $pidFile | Select-Object -First 1)
    if ($dpid -match '^\d+$') {
        Write-Host ('  结束守护进程 PID ' + $dpid)
        Stop-ProcessTree $dpid
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# 4) 兜底：还有谁在监听 7788，就结束它（只认 node 进程，绝不误伤其它程序）
Start-Sleep -Milliseconds 700
$left = Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $left) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
        Write-Host ('  结束监听进程 PID ' + $p.Id)
        Stop-ProcessTree $p.Id
    }
}

Start-Sleep -Milliseconds 600
$still = Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue

Write-Host ''
if ($still) {
    Write-Host '  [未完全停止] 端口 7788 仍被占用：' -ForegroundColor Yellow
    $still | ForEach-Object { Write-Host ('    PID ' + $_.OwningProcess) }
    Write-Host '  可在任务管理器里手动结束对应进程。' -ForegroundColor Yellow
} else {
    Write-Host '  [已停止] 端口 7788 已释放。' -ForegroundColor Green
}
$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($t) {
    $en = if ($t.Settings.Enabled) { '已启用' } else { '已禁用' }
    Write-Host ('  计划任务状态：' + $t.State + '（' + $en + '，开机' + $(if ($t.Settings.Enabled) { '自动运行' } else { '不再自启' }) + '）')
}
Write-Host ''
Write-Host '  要恢复：双击「恢复自启动.bat」。' -ForegroundColor Cyan
Write-Host ''
