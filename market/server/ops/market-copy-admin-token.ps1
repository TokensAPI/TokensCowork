$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '../../../.build/market-admin.credential.xml'
if (-not (Test-Path -LiteralPath $path)) { throw 'No local encrypted administrator credential found' }
$credential = Import-Clixml -LiteralPath $path
Set-Clipboard -Value $credential.GetNetworkCredential().Password
Write-Output '管理员凭证已复制到剪贴板，请粘贴到插件授权后台。'
