# ============================================================
#  查看「会议日程 · 同步服务」运行状态
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch {}

$taskName = 'MeetingSyncBridge'

Write-Host ''
Write-Host '  —— 会议日程 · 同步服务 状态 ——' -ForegroundColor Cyan
Write-Host ''

$t = Get-ScheduledTask -TaskName $taskName
if ($t) {
    Write-Host ('  计划任务  ：' + $t.State)
} else {
    Write-Host '  计划任务  ：未安装' -ForegroundColor Yellow
}

$i = Get-ScheduledTaskInfo -TaskName $taskName
if ($i) {
    Write-Host ('  上次运行  ：' + $i.LastRunTime)
    $code = '（' + $i.LastTaskResult + '）'
    if ($i.LastTaskResult -eq 0 -or $i.LastTaskResult -eq 267009) { $code = $code + ' 正常' }
    Write-Host ('  上次结果  ：' + $code)
    Write-Host ('  下次检查  ：' + $i.NextRunTime)
}

$ok = $false
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/ping' -TimeoutSec 3
    if ($r.ok) { $ok = $true }
} catch {}

Write-Host ''
if ($ok) {
    Write-Host '  服务状态  ：在线' -ForegroundColor Green
    Write-Host ('  服务版本  ：' + $r.version)
    $st = '未登录金山文档'
    if ($r.authed) { $st = '已登录金山文档（有效至 ' + $r.tokenExpiresAt + '）' }
    Write-Host ('  登录状态  ：' + $st)
    Write-Host ('  云文档    ：' + $r.doc.name)
    Write-Host '  访问地址  ：http://127.0.0.1:7788/'
} else {
    Write-Host '  服务状态  ：离线' -ForegroundColor Yellow
    Write-Host '  双击「恢复自启动.bat」可以把它拉起来。'
}

# 进程层面
$conns = Get-NetTCPConnection -LocalPort 7788 -State Listen
if ($conns) {
    $ids = ($conns | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Write-Host ('  监听进程  ：PID ' + $ids)
}

$pidFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\daemon.pid'
if (Test-Path $pidFile) {
    $dpid = (Get-Content $pidFile | Select-Object -First 1)
    Write-Host ('  守护进程  ：PID ' + $dpid + '（被结束后会自动重启）')
} else {
    Write-Host '  守护进程  ：无 pid 记录'
}

Write-Host ''
