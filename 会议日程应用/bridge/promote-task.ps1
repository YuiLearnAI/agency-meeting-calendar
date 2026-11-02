# ============================================================
#  Turn scheduled task "MeetingSyncBridge" into a windowless launcher
#
#  Why: the task used to run run-daemon.cmd, and that script keeps
#  node running in the foreground -> an empty black CMD window stays
#  on the desktop. Pointing the task at wscript + run-daemon.vbs
#  makes the whole chain completely invisible.
#
#  Idempotent: exits quietly when the task is already converted.
#  Needs admin rights (the task itself runs with RunLevel=Highest,
#  so when this script is started from that task it can edit itself).
#  Output is plain ASCII on purpose: it gets appended to a UTF-8 log.
# ============================================================
$ErrorActionPreference = 'Stop'
$taskName = 'MeetingSyncBridge'

try {
    $app = Split-Path -Parent $PSScriptRoot
    $vbs = Join-Path $app 'run-daemon.vbs'
    if (-not (Test-Path $vbs)) { "skip: run-daemon.vbs not found"; exit 0 }

    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $cur = ''
    if ($t.Actions.Count -gt 0) { $cur = [string]$t.Actions[0].Arguments }
    if ($cur -like '*run-daemon.vbs*') { "already windowless, nothing to do"; exit 0 }

    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $vbs + '"') -WorkingDirectory $app
    Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
    "task converted to windowless launcher: $wscript"
} catch {
    "cannot update scheduled task (startup itself is fine): " + $_.Exception.Message
}
exit 0
