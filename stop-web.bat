@echo off
REM ============================================================
REM  TrendPublish Web Console - 一键停止（双击我）
REM  等价于：start-web.bat -Stop
REM  逻辑：定位 UI_PORT（默认 8002，从 .env 读）-> taskkill 进程树 -> 释放端口
REM  想停其他端口：stop-web.bat 8010
REM  完成后会暂停，按任意键关窗——这样你能看清执行结果，不会一闪而过。
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title TrendPublish Web Console - Stop

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" -Stop %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo [ OK  ] TrendPublish 服务已停止。
) else (
    echo [FAIL ] TrendPublish 服务停止失败，退出码 %EXITCODE%。
    echo         请查看 logs\server.log，或手动执行：
    echo         taskkill /IM deno.exe /F
)
echo.
echo 按任意键关闭窗口...
pause >nul
exit /b %EXITCODE%
