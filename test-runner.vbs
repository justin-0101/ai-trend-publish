' ============================================================
'  TrendPublish Web Console - 隐藏窗口启动（带启动反馈弹窗）
'
'  流程：
'    1. 双击后立即弹「正在启动 TrendPublish...」3 秒后自动关闭
'       ——给用户即时反馈，确认双击动作已生效
'    2. 异步隐藏窗口启动 start-web.bat（不阻塞 VBS）
'       ——BAT 内 PS1 同步跑 Deno（不返回），服务一直在前台
'    3. 启动成功的标志：浏览器自动打开 http://localhost:8002/
'    4. 启动失败的兜底：BAT 末尾的 MessageBox 会弹到屏幕上
'
'  使用方法：双击 test-runner.vbs
'  等价命令行：wscript test-runner.vbs
' ============================================================
Option Explicit

Dim shell, batPath
Set shell = CreateObject("WScript.Shell")

batPath = Replace(WScript.ScriptFullName, "test-runner.vbs", "start-web.bat")

' 1. 启动前提示（3 秒后自动关闭）
'    Popup 第二参数 = 秒数；非 0 时 Popup 会阻塞 VBS 直到超时或用户点击
'    注意：VBS 默认 ANSI 编码，中文文案会导致 Popup 构造失败立即返回 -1，
'    所以这里用纯英文。运行时输出仍可看 logs\server.log。
shell.Popup "Starting TrendPublish Web Console...", 3, "TrendPublish", 64

' 2. 异步隐藏窗口启动 BAT（不阻塞 VBS，BAT 会一直跑直到 Deno 退出）
'    第二参数 0 = SW_HIDE
'    第三参数 False = 不等待返回
'    batPath 来自 WScript.ScriptFullName，项目路径固定无空格，直接传。
'    如果以后项目路径含空格，再改为：shell.Run "cmd /c ""batPath""", 0, False
shell.Run batPath, 0, False

Set shell = Nothing