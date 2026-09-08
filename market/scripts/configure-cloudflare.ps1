$ErrorActionPreference = 'Stop'
$account = 'd91498139b9b628efa58b42bb2b3dad0'
$project = 'tokenscowork-market'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$credentialFile = Join-Path $root '.build/market-admin.credential.xml'
$config = Get-Content "$env:APPDATA\xdg.config\.wrangler\config\default.toml" -Raw
$oauth = [regex]::Match($config, '(?m)^oauth_token\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $oauth) { throw 'Wrangler OAuth login required' }
function Cf($method, $path, $body = $null) {
  $params = @{ Uri="https://api.cloudflare.com/client/v4/accounts/$account/$path"; Method=$method; Headers=@{Authorization="Bearer $oauth"}; TimeoutSec=45 }
  if ($null -ne $body) { $params.Body = ConvertTo-Json -InputObject $body -Depth 30 -Compress; $params.ContentType='application/json' }
  try { $response = Invoke-RestMethod @params } catch { throw "Cloudflare request failed: $method $path" }
  if (-not $response.success) { throw "Cloudflare operation failed: $method $path" }
  return $response.result
}
$current = Cf GET "pages/projects/$project"
$production = $current.deployment_configs.production
if ($production.d1_databases.MARKET_DB.id) {
  $null = Cf POST "d1/database/$($production.d1_databases.MARKET_DB.id)/query" @{ sql=(Get-Content (Join-Path $PSScriptRoot 'organization-schema.sql') -Raw) }
}
if ($production.env_vars.MARKET_ADMIN_TOKEN -and $production.env_vars.MARKET_HMAC_SECRET -and $production.d1_databases.MARKET_DB) {
  Write-Output 'Authorization configuration already exists; secrets were not changed.'
  return
}
if ($production.env_vars.MARKET_ADMIN_TOKEN -or $production.env_vars.MARKET_HMAC_SECRET) {
  throw 'Partial secret configuration exists; complete bindings in Cloudflare without replacing secrets'
}
$db = @(Cf GET 'd1/database?per_page=100') | Where-Object name -EQ 'tokenscowork-market-access'
if ($db.Count -gt 1) { throw 'Ambiguous database name' }
if (-not $db) { $db = Cf POST 'd1/database' @{name='tokenscowork-market-access'} }
$null = Cf POST "d1/database/$($db.uuid)/query" @{ sql=(Get-Content (Join-Path $PSScriptRoot 'schema.sql') -Raw) }
$null = Cf POST "d1/database/$($db.uuid)/query" @{ sql=(Get-Content (Join-Path $PSScriptRoot 'organization-schema.sql') -Raw) }
$vars = @{}
if ($production.env_vars) { foreach ($p in $production.env_vars.PSObject.Properties) { $vars[$p.Name]=$p.Value } }
if ($vars.ContainsKey('MARKET_ADMIN_TOKEN') -and -not (Test-Path $credentialFile)) { throw 'Existing admin secret found: recover it instead of rotating automatically' }
if (-not $vars.ContainsKey('MARKET_ADMIN_TOKEN')) {
  if (Test-Path $credentialFile) { $admin = (Import-Clixml $credentialFile).GetNetworkCredential().Password }
  else {
    $admin = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    New-Item (Split-Path $credentialFile) -ItemType Directory -Force | Out-Null
    [PSCredential]::new('market-admin', (ConvertTo-SecureString $admin -AsPlainText -Force)) | Export-Clixml -LiteralPath $credentialFile
  }
  $vars.MARKET_ADMIN_TOKEN = @{type='secret_text';value=$admin}
}
if (-not $vars.ContainsKey('MARKET_HMAC_SECRET')) {
  $vars.MARKET_HMAC_SECRET = @{type='secret_text';value=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))}
}
$vars.MARKET_ACCESS_REQUIRED = @{type='plain_text';value='true'}
$bindings = @{}
if ($production.d1_databases) { foreach ($p in $production.d1_databases.PSObject.Properties) { $bindings[$p.Name]=$p.Value } }
$bindings.MARKET_DB = @{id=$db.uuid}
$null = Cf PATCH "pages/projects/$project" @{deployment_configs=@{production=@{env_vars=$vars;d1_databases=$bindings}}}
Write-Output "Configured production D1: $($db.uuid)"
Write-Output "Encrypted admin credential: $credentialFile"
