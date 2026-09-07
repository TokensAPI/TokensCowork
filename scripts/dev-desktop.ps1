# 本地启动 TokensCowork（staging 版）做发版前验证，不打安装包。
#
# 用法（在仓库根目录）：
#   powershell -File scripts\dev-desktop.ps1              # 直接启动（产物缺失才自动构建一次）
#   powershell -File scripts\dev-desktop.ps1 -Watch       # 热加载：改代码自动重编，窗口内 Ctrl+R 生效
#   powershell -File scripts\dev-desktop.ps1 -Build       # 改了代码、没开 -Watch 时，强制重建再启动
#   powershell -File scripts\dev-desktop.ps1 -RealData    # 用真实数据（~/.dsh，需先退出已装应用）
#   powershell -File scripts\dev-desktop.ps1 -Prepare     # 改过 build/assembly/overlays/** 后先重新装配
#
# 热加载范围：
# - 市场客户端 / 桌面渲染层（.build/desktop/*/src 下的 client、native-ui 代码）：
#   保存后 watcher 自动重编，回应用窗口按 Ctrl+R 即见效果。
# - Electron 主进程代码：watcher 会自动重编，但要关掉应用重新跑本脚本（默认即秒起）。
# - overlay（build/assembly/overlays/**）：必须 -Prepare 重新装配才会进 staging。
#   在 staging 里直接改源码迭代最快，但最终务必落回 overlay，否则下次装配即丢失。
#
# 数据模式：
# - 沙箱（默认）：数据在 .build/dev-sandbox/，首启走初始化向导，删目录即重置。
# - -RealData：与已装应用共用 %APPDATA%\TokensCowork 和 ~/.dsh，必须先退出它。
#
# 注意：.build/desktop 是共享工作区，别在另一会话装配/打包时同时跑本脚本。

param(
  [switch]$Prepare,
  [switch]$RealData,
  [switch]$Build,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.build\desktop'
$desktop = Join-Path $stage 'dsh-plugin-desktop'

function Invoke-Step {
  param([string]$Label, [string]$Dir, [string]$Cmd)
  Write-Host "==> $Label" -ForegroundColor Cyan
  Push-Location $Dir
  cmd /d /s /c $Cmd
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    Write-Host "dev-desktop: '$Label' 失败（退出码 $code）" -ForegroundColor Red
    exit 1
  }
}

if ($Prepare) {
  Invoke-Step '拉取插件产物' $root 'node build\plugins\fetch-artifacts.mjs'
  Invoke-Step '装配 staging（应用 overlay）' $root 'node build\assembly\prepare.mjs'
  Invoke-Step '安装依赖（约 5 分钟）' $stage 'corepack yarn install --immutable'
}

if (-not (Test-Path (Join-Path $stage 'node_modules'))) {
  Invoke-Step '安装依赖（首次，约 5 分钟）' $stage 'corepack yarn install --immutable'
}

# 默认直接启动；只有产物缺失（首次/刚 prepare 过）或显式 -Build 才构建。
# 开发构建只做运行时产物（tsdown/vite），跳过发布用的 tsc 类型声明导出。
$outputsMissing = -not ((Test-Path (Join-Path $desktop 'lib\bin.js')) -and
  (Test-Path (Join-Path $stage 'dsh-community-market\lib\client.js')))
if ($Build -or $Prepare -or $outputsMissing) {
  Invoke-Step '生成市场契约类型' $stage 'corepack yarn workspace dsh-community-market run generate:types'
  Invoke-Step '构建市场客户端' $stage 'corepack yarn workspace dsh-community-market exec tsdown'
  Invoke-Step '生成应用图标' $stage 'corepack yarn workspace dsh-plugin-desktop exec node scripts/generate-windows-app-icon.mjs'
  Invoke-Step '生成托盘图标' $stage 'corepack yarn workspace dsh-plugin-desktop exec node scripts/generate-tray-icons.mjs'
  Invoke-Step '构建桌面主进程' $stage 'corepack yarn workspace dsh-plugin-desktop exec tsdown'
  Invoke-Step '构建桌面界面' $stage 'corepack yarn workspace dsh-plugin-desktop exec vite build --config vite.native-ui.config.ts'
}

$watchers = @()
if ($Watch) {
  Write-Host '==> 启动热加载 watcher（三个最小化窗口，改代码自动重编，应用内 Ctrl+R 生效）' -ForegroundColor Cyan
  $watchSpecs = @(
    @{ Label = 'market-client'; Cmd = 'corepack yarn workspace dsh-community-market exec tsdown --watch' },
    @{ Label = 'desktop-main';  Cmd = 'corepack yarn workspace dsh-plugin-desktop exec tsdown --watch' },
    @{ Label = 'desktop-ui';    Cmd = 'corepack yarn workspace dsh-plugin-desktop exec vite build --watch --config vite.native-ui.config.ts' }
  )
  foreach ($spec in $watchSpecs) {
    $watchers += Start-Process cmd -ArgumentList '/d', '/s', '/k', "title dev-watch:$($spec.Label) & $($spec.Cmd)" `
      -WorkingDirectory $stage -WindowStyle Minimized -PassThru
  }
}

if ($RealData) {
  $running = Get-Process TokensCowork -ErrorAction SilentlyContinue
  if ($null -ne $running) {
    Write-Host 'dev-desktop: 请先完全退出已安装的 TokensCowork —— 真实数据模式与它共用数据目录。' -ForegroundColor Red
    foreach ($w in $watchers) { try { Stop-Process -Id $w.Id -Force -ErrorAction Stop } catch {} }
    exit 1
  }
  Write-Host '==> 真实数据模式：使用 ~/.dsh 与 %APPDATA%\TokensCowork' -ForegroundColor Yellow
} else {
  $sandbox = Join-Path $root '.build\dev-sandbox'
  $sandboxAppData = Join-Path $sandbox 'AppData'
  $sandboxHome = Join-Path $sandbox 'home\.dsh'
  New-Item -ItemType Directory -Force $sandboxAppData | Out-Null
  New-Item -ItemType Directory -Force $sandboxHome | Out-Null
  $env:APPDATA = $sandboxAppData
  $env:DSH_HOME = $sandboxHome
  Write-Host "==> 沙箱模式：数据在 $sandbox（删掉该目录即彻底重置）" -ForegroundColor Cyan
}

Write-Host '==> 启动 TokensCowork（关闭应用即退出脚本）' -ForegroundColor Cyan
Push-Location $desktop
node lib\bin.js
Pop-Location

if ($watchers.Count -gt 0) {
  Write-Host '==> 停止热加载 watcher' -ForegroundColor Cyan
  foreach ($w in $watchers) {
    try { Stop-Process -Id $w.Id -Force -ErrorAction Stop } catch {}
  }
}
