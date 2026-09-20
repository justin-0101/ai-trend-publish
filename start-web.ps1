<#
.SYNOPSIS
  TrendPublish Web 控制台一键启动脚本

.DESCRIPTION
  自动完成：定位 Deno -> 解析端口 -> 检查端口占用 -> 启动服务 -> 等待就绪 -> 打开浏览器。
  双击启动请用同目录的 start-web.bat。

.PARAMETER Port
  指定端口。默认顺序：-Port 参数 > 环境变量 UI_PORT > .env 里的 UI_PORT > 8002

.PARAMETER Dev
  开发模式，文件变更自动重启（deno --watch）

.PARAMETER NoBrowser
  启动后不自动打开浏览器

.PARAMETER Stop
  停止占用该端口的服务（结束进程树）后退出

.PARAMETER InstallDeno
  未检测到 Deno 时，用 winget 自动安装

.EXAMPLE
  .\start-web.ps1
.EXAMPLE
  .\start-web.ps1 -Port 8010 -Dev
.EXAMPLE
  .\start-web.ps1 -Stop
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$Dev,
  [switch]$NoBrowser,
  [switch]$Stop,
  [switch]$InstallDeno
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Ok($msg)   { Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# ---------- 端口工具 ----------

function Get-PortOwnerPid([int]$p) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop |
            Select-Object -First 1
    if ($conn -and $conn.OwningProcess) { return [int]$conn.OwningProcess }
  } catch { }
  $hits = netstat -ano | Select-String -Pattern ":$p\s+.*LISTENING"
  foreach ($h in $hits) {
    $parts = ($h.ToString().Trim() -split '\s+')
    $last = $parts[$parts.Length - 1]
    if ($last -match '^\d+$') { return [int]$last }
  }
  return 0
}

function Test-PortListening([int]$p) {
  return ((Get-PortOwnerPid $p) -gt 0)
}

function Get-LocalHttpBody([string]$url, [int]$timeoutMs = 2500) {
  # 本机探测必须绕过系统代理，否则有代理环境会超时（实测 HTTP_PROXY 会拖死 localhost 请求）
  $req = [System.Net.WebRequest]::Create($url)
  $req.Proxy = $null
  $req.Timeout = $timeoutMs
  $resp = $req.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    try { return $reader.ReadToEnd() } finally { $reader.Close() }
  } finally { $resp.Close() }
}

function Test-ServiceUp([int]$p) {
  try {
    $body = [string](Get-LocalHttpBody "http://127.0.0.1:$p/api/overview" 2500)
    # 只有返回 TrendPublish 概览结构才算“本服务已就绪”，避免把别的 Web 服务误判
    return ($body -match '"kpi"' -and $body -match '"timeline"')
  } catch {
    return $false
  }
}

function Find-FreePort([int]$start) {
  for ($i = 1; $i -le 20; $i++) {
    $candidate = $start + $i
    if (-not (Test-PortListening $candidate)) { return $candidate }
  }
  return 0
}

# ---------- 解析端口 ----------

function Get-PortFromEnvFile {
  $envFile = Join-Path $PSScriptRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return 0 }
  foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
    if ($line -match '^\s*UI_PORT\s*=\s*"?(\d+)"?\s*$') { return [int]$Matches[1] }
  }
  return 0
}

# 注意：PowerShell 变量名大小写不敏感，$Port 与 $port 是同一个变量，
# 这里统一用 $listenPort，避免覆盖 -Port 参数。
$listenPort = 0
if ($Port -gt 0) {
  $listenPort = $Port
} elseif ($env:UI_PORT -and "$env:UI_PORT" -match '^\d+$') {
  $listenPort = [int]$env:UI_PORT
} else {
  $fromEnv = Get-PortFromEnvFile
  if ($fromEnv -gt 0) { $listenPort = $fromEnv } else { $listenPort = 8002 }
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "  TrendPublish Web 控制台" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host ""

# ---------- 停止模式 ----------

if ($Stop) {
  Info "停止模式：检查端口 $listenPort ..."
  $owner = Get-PortOwnerPid $listenPort
  if ($owner -le 0) {
    Ok "端口 $listenPort 上没有正在运行的服务，无需停止"
    exit 0
  }
  $procName = "PID $owner"
  try {
    $proc = Get-Process -Id $owner -ErrorAction Stop
    $procName = "$($proc.ProcessName) (PID $owner)"
  } catch { }
  Info "发现进程 $procName，正在停止 ..."
  & taskkill /PID $owner /T /F | Out-Null
  Start-Sleep -Milliseconds 900
  if (Test-PortListening $listenPort) {
    Fail "停止失败。请手动执行：taskkill /PID $owner /T /F"
    exit 1
  }
  Ok "已停止，端口 $listenPort 已释放"
  exit 0
}

# ---------- 端口占用处理 ----------

if (Test-PortListening $listenPort) {
  if (Test-ServiceUp $listenPort) {
    Ok "服务已经在运行：http://localhost:$listenPort"
    if (-not $NoBrowser) { Start-Process "http://localhost:$listenPort" }
    Write-Host ""
    Info "需要停止请执行：.\start-web.ps1 -Stop"
    exit 0
  }
  $busyPid = Get-PortOwnerPid $listenPort
  Warn "端口 $listenPort 被其他程序占用（PID $busyPid），尝试换一个空闲端口"
  $free = Find-FreePort $listenPort
  if ($free -le 0) {
    Fail "$listenPort-$($listenPort + 20) 范围内没有空闲端口，请用 -Port 指定其他端口"
    exit 1
  }
  Info "改用端口 $free"
  $listenPort = $free
}

# ---------- 定位 Deno ----------

function Resolve-Deno {
  $candidates = @(
    (Join-Path $PSScriptRoot ".deno\bin\deno.exe"),
    (Join-Path $env:USERPROFILE ".deno\bin\deno.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\deno.exe")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  $cmd = Get-Command deno -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetRoot) {
    $hit = Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter "DenoLand.Deno*" -ErrorAction SilentlyContinue |
           ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Filter "deno.exe" -ErrorAction SilentlyContinue } |
           Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$deno = Resolve-Deno
if (-not $deno -and $InstallDeno) {
  Info "未检测到 Deno，尝试用 winget 安装（DenoLand.Deno）..."
  & winget install --id DenoLand.Deno -e --accept-source-agreements --accept-package-agreements
  $deno = Resolve-Deno
}

if (-not $deno) {
  Fail "未检测到 Deno 运行时。"
  Write-Host ""
  Write-Host "  三种解决方式（任选其一）：" -ForegroundColor White
  Write-Host "   1) 自动安装：  .\start-web.ps1 -InstallDeno"
  Write-Host "   2) 手动安装：  winget install -e --id DenoLand.Deno   （装完重开终端）"
  Write-Host "   3) 便携版本：  把 deno.exe 放到  $PSScriptRoot\.deno\bin\deno.exe"
  Write-Host ""
  exit 1
}

$denoVersion = ""
try { $denoVersion = (& $deno --version 2>$null | Select-Object -First 1) } catch { }
if (-not $denoVersion) {
  Fail "Deno 无法执行：$deno"
  exit 1
}
Ok "Deno $denoVersion"
Ok "运行文件 $deno"

# ---------- 配置检查 ----------

$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $envFile) {
  Ok ".env 已找到"
} else {
  Warn "未找到 .env（首次使用请复制 .env.example 为 .env 并填写密钥）"
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "src\index.ts"))) {
  Fail "找不到 src\index.ts，请在项目根目录运行本脚本"
  exit 1
}

# ---------- 启动 ----------

$env:UI_PORT = "$listenPort"
$url = "http://localhost:$listenPort"
$mode = if ($Dev) { "开发模式（文件变更自动重启）" } else { "生产模式" }

$denoArgs = @("run")
if ($Dev) { $denoArgs += "--watch" }
$denoArgs += @(
  "--allow-env", "--allow-ffi", "--allow-read", "--allow-write",
  "--allow-sys", "--allow-net", "--allow-run", "--env", "src/index.ts", "--no-check"
)

Write-Host ""
Write-Host "  访问地址 : $url" -ForegroundColor Green
Write-Host "  运行模式 : $mode" -ForegroundColor Gray
Write-Host "  停止服务 : 本窗口按 Ctrl+C，或另开窗口执行  .\start-web.ps1 -Stop" -ForegroundColor Gray
if (-not $NoBrowser) { Write-Host "  浏览器   : 服务就绪后自动打开" -ForegroundColor Gray }
Write-Host ""
Info "正在启动服务 ..."
Write-Host ""

$browserJob = $null
if (-not $NoBrowser) {
  # 探测走 127.0.0.1 并绕过代理；浏览器里打开 localhost，与手工访问的习惯一致
  $browserJob = Start-Job -ScriptBlock {
    param($probe, $open)
    for ($i = 0; $i -lt 120; $i++) {
      try {
        $req = [System.Net.WebRequest]::Create("$probe/api/overview")
        $req.Proxy = $null
        $req.Timeout = 2000
        $resp = $req.GetResponse()
        $resp.Close()
        Start-Process $open
        return
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
  } -ArgumentList "http://127.0.0.1:$listenPort", $url
}

$exitCode = 0
try {
  & $deno @denoArgs
  $exitCode = $LASTEXITCODE
} finally {
  if ($browserJob) {
    Stop-Job $browserJob -ErrorAction SilentlyContinue
    Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
if ($exitCode -eq 0) {
  Ok "服务已退出"
} else {
  Warn "服务已退出（退出码 $exitCode），日志见 logs\ 目录"
}
exit $exitCode
