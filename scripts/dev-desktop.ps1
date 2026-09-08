# 本地启动 TokensCowork（staging 版）做发版前验证，不打安装包。
#
# 用法（在仓库根目录）：
#   powershell -File scripts\dev-desktop.ps1              # 自动判断是否需要装配/构建，然后启动
#   powershell -File scripts\dev-desktop.ps1 -Watch       # 热加载：改代码自动重编，窗口内 Ctrl+R 生效
#   powershell -File scripts\dev-desktop.ps1 -Build       # 改了代码、没开 -Watch 时，强制重建再启动
#   powershell -File scripts\dev-desktop.ps1 -Sandbox     # 用隔离沙箱数据（不碰 ~/.dsh，可与已装应用同时跑）
#   powershell -File scripts\dev-desktop.ps1 -Prepare     # 改过 build/overlays/** 后先重新装配
#
# 热加载范围：
# - 市场客户端 / 桌面渲染层（.build/desktop/*/src 下的 client、native-ui 代码）：
#   保存后 watcher 自动重编，回应用窗口按 Ctrl+R 即见效果。
# - Electron 主进程代码：watcher 会自动重编，但要关掉应用重新跑本脚本（默认即秒起）。
# - overlay（build/overlays/**）：必须 -Prepare 重新装配才会进 staging。
#   在 staging 里直接改源码迭代最快，但最终务必落回 overlay，否则下次装配即丢失。
#
# 数据模式：
# - 真实数据（默认）：与已装应用共用 %APPDATA%\TokensCowork 和 ~/.dsh，验证的是真实
#   Profile 与真实配置，因此必须先完全退出已装应用（含托盘）。
# - -Sandbox：数据在 .build/dev-sandbox/，首启使用产品默认 Profile，删目录即重置；
#   与已装应用数据隔离，两者可同时运行。
#
# 注意：.build/desktop 是共享工作区，别在另一会话装配/打包时同时跑本脚本。

param(
  [switch]$Prepare,
  [switch]$Sandbox,
  [switch]$Build,
  [switch]$Watch,
  # 真实数据已是默认行为，保留本开关只为兼容旧用法，传了不报错。
  [switch]$RealData
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.build\desktop'
$desktop = Join-Path $stage 'dsh-plugin-desktop'

if ($Sandbox -and $RealData) {
  Write-Host 'dev-desktop: -Sandbox 与 -RealData 互斥。' -ForegroundColor Red
  exit 1
}

function Test-InstalledAppRunning {
  return $null -ne (Get-Process TokensCowork -ErrorAction SilentlyContinue)
}

# 默认的真实数据模式与已装应用共用数据目录，必须独占运行。这里先拦一道，
# 避免等装配/构建跑完数分钟后才发现需要退出应用；启动前还会再查一次。
if (-not $Sandbox -and (Test-InstalledAppRunning)) {
  Write-Host 'dev-desktop: 请先完全退出已安装的 TokensCowork（含托盘）—— 默认的真实数据模式与它共用数据目录。' -ForegroundColor Red
  Write-Host '            若只想验证功能、不碰真实数据，改用：-Sandbox' -ForegroundColor Yellow
  exit 1
}

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

function Get-NewestWriteTimeUtc {
  param([System.IO.FileInfo[]]$Files)
  $latest = [DateTime]::MinValue
  foreach ($file in $Files) {
    if ($file.LastWriteTimeUtc -gt $latest) { $latest = $file.LastWriteTimeUtc }
  }
  return $latest
}

# 产品装配输入只要比 staging 主进程源码新，就需要重新生成 staging。
# README 等说明文件不参与装配，避免纯文档修改触发数分钟的依赖安装。
$prepareProbe = Join-Path $desktop 'src\main.ts'
$prepareInputs = @(
  Get-Item (Join-Path $root 'product.json')
  Get-Item (Join-Path $root 'build\product.yarn.lock')
  Get-Item (Join-Path $root 'market\source.json')
  Get-Item (Join-Path $root 'market\source.config.json')
  Get-ChildItem (Join-Path $root 'build\steps'), (Join-Path $root 'build\overlays'), (Join-Path $root 'build\assets'), (Join-Path $root 'build\hooks') -Recurse -File |
    Where-Object { $_.Extension -ne '.md' }
)
$autoPrepare = -not (Test-Path $prepareProbe)
if (-not $autoPrepare) {
  $autoPrepare = (Get-NewestWriteTimeUtc $prepareInputs) -gt
    (Get-Item $prepareProbe).LastWriteTimeUtc
}
if (-not $Prepare -and $autoPrepare) {
  Write-Host '==> 检测到产品装配输入已变化，自动重新装配' -ForegroundColor Cyan
  $Prepare = $true
}

if ($Prepare) {
  Invoke-Step '拉取插件产物' $root 'node build\steps\fetch-plugin-artifacts.mjs'
  Invoke-Step '装配 staging（应用 overlay）' $root 'node build\steps\prepare-staging.mjs'
  Invoke-Step '安装依赖（约 5 分钟）' $stage 'corepack yarn install --immutable'
}

if (-not (Test-Path (Join-Path $stage 'node_modules'))) {
  Invoke-Step '安装依赖（首次，约 5 分钟）' $stage 'corepack yarn install --immutable'
}

# prepare 只负责源码覆盖和插件装配；正式品牌与 Logo 需要在依赖安装后注入。
# 仅在刚完成 prepare 或 staging 仍是上游品牌时执行，避免每次启动重复改写。
# Windows PowerShell 5.1 默认按系统 ANSI 编码读取无 BOM 文件，JSON 必须显式使用 UTF-8。
$productName = (Get-Content -LiteralPath (Join-Path $root 'product.json') -Raw -Encoding UTF8 |
  ConvertFrom-Json).product.name
$desktopPackagePath = Join-Path $desktop 'package.json'
$configureNeeded = $Prepare
if (-not $configureNeeded) {
  if (-not (Test-Path $desktopPackagePath)) {
    $configureNeeded = $true
  } else {
    $stagedProductName = (Get-Content -LiteralPath $desktopPackagePath -Raw -Encoding UTF8 |
      ConvertFrom-Json).build.productName
    $configureNeeded = $stagedProductName -ne $productName
  }
}
if ($configureNeeded) {
  Invoke-Step '注入产品品牌与 Logo' $root 'node build\steps\configure-product.mjs'
  $Build = $true
}

# 默认直接启动；产物缺失、源码较新、刚 prepare 过或显式 -Build 时才构建。
# 开发构建只做运行时产物（tsdown/vite），跳过发布用的 tsc 类型声明导出。
$requiredOutputs = @(
  (Join-Path $stage 'dsh-community-market\lib\client.js')
  (Join-Path $stage 'dsh-community-market\lib\index.js')
  (Join-Path $desktop 'lib\bin.js')
  (Join-Path $desktop 'lib\main.js')
  (Join-Path $desktop 'lib\client.js')
  (Join-Path $desktop 'lib\native-ui\profile-selector.html')
  (Join-Path $desktop 'build\app-icon.ico')
  (Join-Path $desktop 'build\app-icon-mac.png')
  (Join-Path $desktop 'build\tray-icon-blue.png')
)
$outputsMissing = $requiredOutputs.Where({ -not (Test-Path $_) }).Count -gt 0
$buildInputsChanged = $false
if (-not $outputsMissing) {
  $buildInputs = @(
    Get-ChildItem (Join-Path $stage 'dsh-community-market\src') -Recurse -File
    Get-ChildItem (Join-Path $desktop 'src') -Recurse -File
    Get-ChildItem (Join-Path $desktop 'product-plugins') -Recurse -File
    Get-ChildItem (Join-Path $desktop 'scripts') -File
    Get-Item (Join-Path $stage 'dsh-community-market\package.json')
    Get-Item (Join-Path $stage 'dsh-community-market\tsdown.config.ts')
    Get-Item (Join-Path $desktop 'package.json')
    Get-Item (Join-Path $desktop 'tsdown.config.ts')
    Get-Item (Join-Path $desktop 'vite.native-ui.config.ts')
  )
  $oldestOutput = $requiredOutputs |
    ForEach-Object { Get-Item $_ } |
    Sort-Object LastWriteTimeUtc |
    Select-Object -First 1
  $buildInputsChanged = (Get-NewestWriteTimeUtc $buildInputs) -gt $oldestOutput.LastWriteTimeUtc
}
if (-not $Build -and -not $Prepare -and $buildInputsChanged) {
  Write-Host '==> 检测到 staging 源码已变化，自动重新构建' -ForegroundColor Cyan
  $Build = $true
}
if ($Build -or $Prepare -or $outputsMissing) {
  Invoke-Step '生成市场契约类型' $stage 'corepack yarn workspace dsh-community-market run generate:types'
  Invoke-Step '构建市场插件（宿主+客户端）' $stage 'corepack yarn workspace dsh-community-market run build'
  Invoke-Step '生成 Windows 应用图标' $stage 'corepack yarn workspace dsh-plugin-desktop exec node scripts/generate-windows-app-icon.mjs'
  Invoke-Step '生成 macOS 应用图标' $stage 'corepack yarn workspace dsh-plugin-desktop exec node scripts/generate-mac-app-icon.mjs'
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

if (-not $Sandbox) {
  # 沙箱分支会设三个变量；真实数据模式必须把它们全部显式复位，不能假设"没人设过"。
  # 若当前 shell 残留了上一次沙箱运行的值（例如在同一会话里直接调用过本脚本），
  # 只清其中一个就会出现 userData 走真实目录、DSH home 却仍在沙箱的错配。
  # APPDATA 直接问系统要真值，而不是信任可能已被改写的同名环境变量。
  Remove-Item Env:TOKENS_COWORK_DEV_APP_DATA -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  # 构建期间用户可能又打开了已装应用；此时两者 userData 相同，Electron 单实例锁会让
  # 本次启动静默退出并把旧窗口拉到前台，看起来像“新代码没生效”。故启动前再查一次。
  if (Test-InstalledAppRunning) {
    Write-Host 'dev-desktop: 请先完全退出已安装的 TokensCowork（含托盘）—— 真实数据模式与它共用数据目录。' -ForegroundColor Red
    foreach ($w in $watchers) { try { Stop-Process -Id $w.Id -Force -ErrorAction Stop } catch {} }
    exit 1
  }
  Write-Host '==> 真实数据模式' -ForegroundColor Yellow
  Write-Host "    APPDATA  = $env:APPDATA" -ForegroundColor DarkGray
  Write-Host "    DSH home = $(Join-Path $HOME '.dsh')" -ForegroundColor DarkGray
} else {
  $sandbox = Join-Path $root '.build\dev-sandbox'
  $sandboxAppData = Join-Path $sandbox 'AppData'
  $sandboxHome = Join-Path $sandbox 'home\.dsh'
  New-Item -ItemType Directory -Force $sandboxAppData | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $sandboxAppData $productName) | Out-Null
  New-Item -ItemType Directory -Force $sandboxHome | Out-Null
  $env:APPDATA = $sandboxAppData
  $env:TOKENS_COWORK_DEV_APP_DATA = $sandboxAppData
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
