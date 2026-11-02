' ============================================================
'  会议日程 · 同步服务 无窗口启动器
'  由计划任务 MeetingSyncBridge 调用（Execute = wscript.exe）
'
'  为什么需要它：
'    run-daemon.cmd 的最后一行是前台运行 node，CMD 窗口会一直挂在桌面上。
'    改成由 wscript 启动后，Run 的窗口样式用 0（完全隐藏），
'    整条启动链不会出现任何可见窗口。
'
'  Run 的第三个参数用 True（等它退出）：这样计划任务的状态始终是
'  「正在运行」，每分钟一次的重复触发会被 IgnoreNew 挡掉，不会堆出
'  好几个守护进程。
'
'  本文件必须保存为 GBK(ANSI) + CRLF：wscript 不认 UTF-8 BOM。
' ============================================================
Option Explicit

Dim fso, sh, appDir, logDir, logFile, pidFile
Dim oldPid, nodeExe, q, cmdLine, daemonJs

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

appDir  = fso.GetParentFolderName(WScript.ScriptFullName)
logDir  = fso.BuildPath(appDir, "logs")
logFile = fso.BuildPath(logDir, "launcher.log")
pidFile = fso.BuildPath(logDir, "daemon.pid")
daemonJs = fso.BuildPath(appDir, "bridge\daemon.mjs")

If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

On Error Resume Next
LogLine "===== 无窗口启动器 start ====="

If Not fso.FileExists(daemonJs) Then
  LogLine "找不到 bridge\daemon.mjs，放弃启动"
  WScript.Quit 2
End If

' ============================================================
'  清理重启：logs\.restart 存在时，先把上一轮的 node 进程杀掉再启。
'  为什么要在这里做：本脚本由计划任务以最高权限启动，只有它才清得掉
'  上一任遗留的高权限 node 进程（网页、普通窗口去 Stop-Process 都会
'  「拒绝访问」，于是新代码永远加载不上）。
' ============================================================
If fso.FileExists(fso.BuildPath(logDir, ".restart")) Then
  LogLine "发现 .restart 标记：清理旧的守护 / 服务进程"
  KillBridgeNodes
  WScript.Sleep 1500
  fso.DeleteFile fso.BuildPath(logDir, ".restart"), True
  fso.DeleteFile pidFile, True
End If

' 已经有一个守护进程在跑，就不再起第二个
oldPid = ReadPid(pidFile)
If oldPid > 0 Then
  If IsNodePid(oldPid) Then
    LogLine "守护进程已在运行（pid " & oldPid & "），本次不重复启动"
    WScript.Quit 0
  End If
End If

nodeExe = FindNode()
If nodeExe = "" Then
  LogLine "找不到 node.exe，无法启动同步服务"
  WScript.Quit 2
End If

LogLine "使用 node: " & nodeExe
LogLine "启动脚本: " & daemonJs

' 用 Chr(34) 拼引号，避免 """ 这种写法在 VBS 里被解析成意外的空串拼接
q = Chr(34)
cmdLine = q & nodeExe & q & " " & q & daemonJs & q

sh.CurrentDirectory = appDir

Err.Clear
LogLine "隐藏启动守护进程（无窗口）"
sh.Run cmdLine, 0, True
If Err.Number <> 0 Then
  LogLine "启动失败：" & Err.Number & " " & Err.Description
  WScript.Quit 3
End If

LogLine "守护进程已退出，交给计划任务在一分钟内重新拉起"
WScript.Quit 0


' ============================================================
'  下面都是工具过程
' ============================================================

' 结束所有属于本应用的 node 进程（守护进程 + 同步服务）
Sub KillBridgeNodes()
  Dim wmi, col, o, cl, n
  On Error Resume Next
  n = 0
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set col = wmi.ExecQuery("Select ProcessId, Name, CommandLine From Win32_Process Where Name='node.exe'")
  For Each o In col
    cl = LCase("" & o.CommandLine)
    If InStr(cl, "daemon.mjs") > 0 Or InStr(cl, "server.mjs") > 0 Then
      o.Terminate 0
      n = n + 1
    End If
  Next
  LogLine "清理进程数：" & n
End Sub

Sub LogLine(msg)
  Dim f
  On Error Resume Next
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine "[" & Now & "] " & msg
  f.Close
End Sub

Function ReadPid(p)
  Dim f, s
  ReadPid = 0
  On Error Resume Next
  If Not fso.FileExists(p) Then Exit Function
  Set f = fso.OpenTextFile(p, 1)
  s = Trim(f.ReadLine)
  f.Close
  If IsNumeric(s) Then ReadPid = CLng(s)
End Function

' pid 还活着、而且确实是个 node 进程（防止 pid 被系统复用造成误判）
Function IsNodePid(p)
  Dim wmi, col, o
  IsNodePid = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set col = wmi.ExecQuery("Select ProcessId, Name From Win32_Process Where ProcessId=" & p)
  For Each o In col
    If InStr(LCase(o.Name), "node") > 0 Then IsNodePid = True
  Next
End Function

Function FindNode()
  Dim p
  ' 1) WorkBuddy 自带 node：取修改时间最新的那个版本
  FindNode = NewestNode(fso.BuildPath(sh.ExpandEnvironmentStrings("%USERPROFILE%"), ".workbuddy\binaries\node\versions"))
  If FindNode <> "" Then Exit Function
  ' 2) 官方安装目录
  p = fso.BuildPath(sh.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If
  ' 3) PATH 里任意一个
  FindNode = PathNode()
End Function

Function NewestNode(verDir)
  Dim f, sf, cand, best, bestTime
  NewestNode = ""
  On Error Resume Next
  If Not fso.FolderExists(verDir) Then Exit Function
  Set f = fso.GetFolder(verDir)
  best = ""
  For Each sf In f.SubFolders
    cand = fso.BuildPath(sf.Path, "node.exe")
    If fso.FileExists(cand) Then
      If best = "" Then
        best = cand
        bestTime = sf.DateLastModified
      ElseIf sf.DateLastModified > bestTime Then
        best = cand
        bestTime = sf.DateLastModified
      End If
    End If
  Next
  NewestNode = best
End Function

Function PathNode()
  Dim parts, i, p, cand
  PathNode = ""
  On Error Resume Next
  parts = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For i = 0 To UBound(parts)
    p = Trim(parts(i))
    If Len(p) > 0 Then
      cand = fso.BuildPath(p, "node.exe")
      If fso.FileExists(cand) Then
        PathNode = cand
        Exit Function
      End If
    End If
  Next
End Function
