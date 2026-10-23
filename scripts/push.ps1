# Push this fork to GitHub from inside the DSH sandbox.
#
# Why plain `git push` fails here: git launches its credential helper through
# MSYS `sh`, and the sandbox denies the named pipes that shell needs, so the
# helper never runs and git falls back to a terminal prompt ("could not read
# Username"). Schannel reports SEC_E_NO_CREDENTIALS for the same reason. The
# stored GitHub account is fine -- re-signing in does not help.
#
# Fix: skip both moving parts.
#   * TLS backend = OpenSSL  -> no Schannel credential handle
#   * Authorization header from `gh auth token` -> no helper process
# The token stays in this process' memory / the child environment; it is never
# written to disk or printed.
#
# Usage:
#   pwsh -File scripts/push.ps1              # push origin main
#   pwsh -File scripts/push.ps1 -Check       # report only, push nothing
#   pwsh -File scripts/push.ps1 -Branch dev  # push another branch

[CmdletBinding()]
param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [switch]$Check
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$remoteUrl = (& git remote get-url $Remote 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Write-Error "没有远端 $Remote：$remoteUrl"
  exit 1
}

$token = (& gh auth token 2>&1) -join ''
$token = $token.Trim()
$hasToken = $token.Length -ge 20
if (-not $hasToken) {
  Write-Host 'gh token unavailable (run: gh auth login)'
}

$host_ = ([uri]$remoteUrl).Host
$gitArgs = @('-c', 'http.sslBackend=openssl', '-c', 'credential.helper=')
if ($hasToken) {
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
  $gitArgs += @('-c', "http.https://$host_/.extraheader=AUTHORIZATION: basic $basic")
}

Write-Host "repository : $(Get-Location)"
Write-Host "remote     : $Remote -> $remoteUrl"
Write-Host "gh token   : $(if ($hasToken) { 'available' } else { 'unavailable' })"

if ($Check) {
  $probe = (& git @gitArgs ls-remote --heads $Remote 2>&1) -join "`n"
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'reachable  : yes'
    ($probe -split "`n" | Select-Object -First 3) | ForEach-Object { Write-Host "  $_" }
    exit 0
  }
  Write-Host 'reachable  : no'
  Write-Host $probe
  exit 1
}

$pushOut = (& git @gitArgs push $Remote $Branch 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0) {
  Write-Host "推送成功：$Remote/$Branch"
  if ($pushOut -and $pushOut -notmatch 'Everything up-to-date') { Write-Host $pushOut }
  exit 0
}

Write-Host "header 通道失败，回退普通 git push"
$plainOut = (& git push $Remote $Branch 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0) {
  Write-Host "推送成功（plain）：$Remote/$Branch"
  if ($plainOut) { Write-Host $plainOut }
  exit 0
}

Write-Host '推送失败。'
Write-Host $pushOut
Write-Host $plainOut
Write-Host '手动排查：gh auth status；或在沙箱外 git push'
exit 1
