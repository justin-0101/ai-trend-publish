@echo off
REM ============================================================
REM  TrendPublish Web Console - one-click start (double-click me)
REM  Arguments are passed through to start-web.ps1, e.g.
REM    start-web.bat -Port 8010
REM    start-web.bat -Dev
REM    start-web.bat -Stop
REM  想隐藏窗口启动请双击 start-web-hidden.vbs（输出仍写 logs\server.log）
REM  启动失败会通过系统通知框提示，正常成功无感退出。
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title TrendPublish Web Console

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if "%EXITCODE%"=="0" exit /b 0
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('TrendPublish 服务启动失败（退出码 %EXITCODE%）。请查看 logs\server.log', 'TrendPublish 启动失败', 'OK', 'Error')" >nul 2>&1
exit /b %EXITCODE%
