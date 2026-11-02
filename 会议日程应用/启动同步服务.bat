@echo off
setlocal
chcp 936 >nul
title 领导会议日程 - 本地同步服务
cd /d "%~dp0"

if not exist "%~dp0bridge\server.mjs" goto :noserver

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo.
echo   正在启动本地同步服务，请稍候……
echo.

rem 服务起来后自动打开页面（延迟 2 秒，避开启动瞬间）
chcp 65001 >nul
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:7788/"
node "%~dp0bridge\server.mjs"
set "RC=%errorlevel%"
chcp 936 >nul

echo.
if "%RC%"=="0" echo   服务已停止。
if not "%RC%"=="0" echo   [错误] 服务异常退出，错误码 %RC%，请查看上方提示。
echo.
pause
exit /b %RC%

:nonode
echo.
echo   [错误] 没有找到 Node.js。
echo   请先安装 Node.js 18 或更高版本： https://nodejs.org
echo   安装完成后重新双击本文件。
echo.
pause
exit /b 1

:noserver
echo.
echo   [错误] 找不到 bridge\server.mjs。
echo   请确认本文件与 bridge 文件夹在同一个目录下。
echo.
pause
exit /b 1
