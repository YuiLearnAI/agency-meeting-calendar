# ============================================================
#  恢复「会议日程 · 同步服务」的开机自启，并立即启动
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch {}

$app      = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $app 'logs'
$taskName = 'MeetingSyncBridge'

Write-Host ''
Write-Host '  正在恢复「会议日程 · 同步服务」……' -ForegroundColor Cyan
Write-Host ''

# 1) 删掉停止标记
$flag = Join-Path $logDir '.stopped'
if (Test-Path $flag) { Remove-Item $flag -Force }

# 2) 重新启用计划任务
Enable-ScheduledTask -TaskName $taskName | Out-Null

# 3) 立刻启动一次
Start-ScheduledTask -TaskName $taskName

# 4) 等它起来，做一次探活
$ok = $false
$r  = $null
for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/ping' -TimeoutSec 2
        if ($r.ok) { $ok = $true; break }
    } catch {}
}

Write-Host ''
if ($ok) {
    Write-Host '  [已启动] 服务在线：http://127.0.0.1:7788/' -ForegroundColor Green
    $st = '未登录'
    if ($r.authed) { $st = '已登录金山文档' }
    Write-Host ('  服务版本：' + $r.version + '，登录状态：' + $st)
} else {
    Write-Host '  [启动较慢或失败] 服务暂未响应。' -ForegroundColor Yellow
    Write-Host '  请查看日志：logs\bridge.log、logs\launcher.log'
}
$t = Get-ScheduledTask -TaskName $taskName
if ($t) { Write-Host ('  计划任务状态：' + $t.State + '（已启用，开机自动运行）') }
Write-Host ''
