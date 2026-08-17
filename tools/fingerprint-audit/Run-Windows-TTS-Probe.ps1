[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Browser,

    [Parameter()]
    [string]$Output = (Join-Path (Get-Location) "tts-probe-v17.json")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Browser = (Resolve-Path -LiteralPath $Browser).Path
$Output = [System.IO.Path]::GetFullPath($Output)
$runner = Join-Path $PSScriptRoot "run.mjs"

& node.exe $runner `
    --browser $Browser `
    --platform windows `
    --platform-version 10.0.0 `
    --version 144.0.7559.132 `
    --surface-mode fixed-template `
    --render-identity v4 `
    --expected-gpu "NVIDIA GeForce RTX 3060" `
    --language en-US `
    --accept-languages en-US,en `
    --timezone America/Los_Angeles `
    --debug-transport websocket `
    --output $Output

$probeExitCode = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $Output)) {
    throw "The fingerprint probe did not create its JSON report."
}

$report = Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
$voiceCount = @($report.samples[0].speechVoices.voices).Count
Write-Host "TTS probe voice count: $voiceCount"
Write-Host "TTS probe report: $Output"
if ($probeExitCode -ne 0) {
    Write-Warning "The fingerprint gate did not pass; the JSON report is still valid diagnostic evidence."
}

