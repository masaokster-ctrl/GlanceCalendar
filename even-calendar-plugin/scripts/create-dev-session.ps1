<#
.SYNOPSIS
    Local hardware development only: issues a development session token for
    even-calendar-agent (scope=audio:analyze, calendar:create, calendar:status,
    calendar:read, max 24 hours) and saves it to even-calendar-plugin .env.local.

.DESCRIPTION
    This script is not a production distribution mechanism. It exists only to
    issue a single limited session for local G2 hardware testing via QR sideload.

    - installId is generated once per machine and persisted to .even-install-id
      (in this same scripts folder) for reuse on subsequent runs.
    - The setup admin token is obtained from, in order: the EVEN_SETUP_ADMIN_TOKEN
      environment variable, then $env:USERPROFILE\.even-calendar-agent\setup-admin-token.txt
      (only if it already exists), then an interactive masked prompt.
      The admin token is never accepted as a command-line argument (it would remain
      in process listings and shell history).
    - The issued plaintext session token is never displayed on screen; it is only
      written to .env.local.
    - Neither the admin token nor the session token is ever written to any log.

.PARAMETER BackendBaseUrl
    Base URL of even-calendar-agent. Defaults to the production Cloud Run endpoint.

.PARAMETER ExpiresInSeconds
    Session lifetime in seconds. Maximum 86400 (24 hours). Defaults to 86400.

.EXAMPLE
    ./scripts/create-dev-session.ps1
#>

[CmdletBinding()]
param(
    [string]$BackendBaseUrl = 'https://even-calendar-agent-probe-1082947954310.asia-northeast1.run.app',
    [int]$ExpiresInSeconds = 86400
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$pluginRoot = Split-Path -Parent $scriptDir
$installIdFile = Join-Path $scriptDir '.even-install-id'
$envLocalFile = Join-Path $pluginRoot '.env.local'
$adminTokenFile = Join-Path $env:USERPROFILE '.even-calendar-agent\setup-admin-token.txt'

function Get-OrCreateInstallId {
    if (Test-Path $installIdFile) {
        $existing = (Get-Content -Path $installIdFile -Raw).Trim()
        if ($existing) {
            return $existing
        }
    }
    $newId = [guid]::NewGuid().ToString()
    Set-Content -Path $installIdFile -Value $newId -NoNewline -Encoding utf8
    Write-Host "installId generated and saved to: $installIdFile" -ForegroundColor DarkGray
    return $newId
}

function Get-AdminTokenPlainText {
    if ($env:EVEN_SETUP_ADMIN_TOKEN) {
        Write-Host 'setup admin token obtained from EVEN_SETUP_ADMIN_TOKEN environment variable.' -ForegroundColor DarkGray
        return $env:EVEN_SETUP_ADMIN_TOKEN
    }

    if (Test-Path $adminTokenFile) {
        $fromFile = (Get-Content -Path $adminTokenFile -Raw).Trim()
        if ($fromFile) {
            Write-Host "setup admin token obtained from $adminTokenFile" -ForegroundColor DarkGray
            return $fromFile
        }
    }

    $secure = Read-Host -Prompt 'Enter setup admin token (input is hidden)' -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

if ($ExpiresInSeconds -le 0 -or $ExpiresInSeconds -gt 86400) {
    throw 'ExpiresInSeconds must be between 1 and 86400 (24 hours).'
}

$installId = Get-OrCreateInstallId
$adminToken = Get-AdminTokenPlainText

if (-not $adminToken) {
    throw 'Could not obtain setup admin token.'
}

$body = @{
    installId        = $installId
    scope            = @('audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read')
    expiresInSeconds = $ExpiresInSeconds
} | ConvertTo-Json -Compress

$headers = @{
    Authorization  = "Bearer $adminToken"
    'Content-Type' = 'application/json'
}

Write-Host "Creating development session... ($BackendBaseUrl/plugin/dev-sessions)" -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Method Post -Uri "$BackendBaseUrl/plugin/dev-sessions" -Headers $headers -Body $body
}
finally {
    # Discard the plaintext admin token from scope as soon as possible.
    $adminToken = $null
    $headers = $null
}

if (-not $response.token) {
    throw 'Response did not include a token.'
}

$envLines = @(
    "VITE_PLUGIN_SESSION_TOKEN=$($response.token)"
    "VITE_PLUGIN_INSTALL_ID=$($response.installId)"
)
Set-Content -Path $envLocalFile -Value $envLines -Encoding utf8

# The session token is never displayed on screen.
$response.token = $null

Write-Host ''
Write-Host 'Development session created and saved to .env.local.' -ForegroundColor Green
Write-Host "  installId : $installId"
Write-Host "  scope     : audio:analyze, calendar:create, calendar:status, calendar:read"
Write-Host "  expiresAt : $($response.expiresAt)"
Write-Host "  saved to  : $envLocalFile"
Write-Host ''
Write-Host 'Restart (or reload) the Vite dev server to pick up the new environment variables.' -ForegroundColor Yellow
Write-Host 'This token is for development only. Do not use it for production distribution (Developer Portal publishing).' -ForegroundColor Yellow
