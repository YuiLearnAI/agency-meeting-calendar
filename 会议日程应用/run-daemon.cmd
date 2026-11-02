@echo off
rem ============================================================
rem  会议日程 · 同步服务启动脚本（计划任务 MeetingSyncBridge 用）
rem
rem  历史包袱：这个文件原来在前台运行 node，导致桌面上常驻一个
rem  什么都没有的黑色 CMD 窗口。现在它只做两件事：
rem    1. 把计划任务改造成「无窗口启动」（交给 run-daemon.vbs）
rem    2. 立刻用无窗口方式把服务拉起来，然后自己退出
rem  改造只需要成功一次，之后计划任务会直接调用 wscript，
rem  这个 CMD 不会再被调起。
rem
rem  注意：本文件必须是 GBK + CRLF，否则 cmd 认错中文。
rem ============================================================
setlocal
set "APP=%~dp0"
if not exist "%APP%logs" mkdir "%APP%logs" 2>nul

if not exist "%APP%run-daemon.vbs" goto fallback

rem ---- 让下次启动直接走无窗口启动器（改不动也不影响本次启动）----
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP%bridge\promote-task.ps1" >>"%APP%logs\launcher.log" 2>&1

rem ---- 用隐藏方式把服务拉起来：start 不等待，本窗口随即关闭 ----
start "MeetingSyncBridge" wscript //nologo "%APP%run-daemon.vbs"
if errorlevel 1 echo [%date% %time%] wscript start failed>>"%APP%logs\launcher.log"
exit /b 0


:fallback
rem ---- 兜底：没有 vbs 时退回原来的前台方式（排障用，会有窗口）----
set "NODE_EXE="

for /f "delims=" %%I in ('where node 2^>nul') do (
  set "NODE_EXE=%%I"
  goto :got
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  goto :got
)

for /f "delims=" %%D in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe"
    goto :got
  )
)

:got
if not defined NODE_EXE (
  echo [%date% %time%] cannot find node.exe>>"%APP%logs\launcher.log"
  exit /b 2
)

echo [%date% %time%] fallback node: %NODE_EXE%>>"%APP%logs\launcher.log"
cd /d "%APP%"
"%NODE_EXE%" "%APP%bridge\daemon.mjs"
exit /b %errorlevel%
