[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$ExpectedPlatformCommit = $KernelLock.platforms.'windows-x64'.commit
$ExpectedFingerprintCommit = $KernelLock.fingerprint.commit
$ExpectedPatchHash = (Get-PrismKernelPatch $KernelLock "019-proxy-geolocation.patch").sha256
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$BuildNinja = Join-Path $SourcePath "out\Default\build.ninja"
$PatchPath = Join-Path $PSScriptRoot "patches\019-proxy-geolocation.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism proxy geolocation patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism proxy geolocation patch hash: $patchHash"
}

if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    throw "The prepared Chromium repositories were not found under $BuildRoot."
}
$platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
$fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($LASTEXITCODE -ne 0 -or
    $platformCommit -ne $ExpectedPlatformCommit -or
    $fingerprintCommit -ne $ExpectedFingerprintCommit) {
    throw "The prepared source does not match the pinned Prism Chromium 144 build."
}

$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) {
    throw "The Chromium build is still running. Wait for it to finish before applying the proxy geolocation patch."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$fingerprintPatchDestination = Join-Path $fingerprintPatchDirectory "019-proxy-geolocation.patch"
Copy-Item -Path $PatchPath -Destination $fingerprintPatchDestination -Force

$seriesPath = Join-Path $FingerprintPath "patches\series"
$screenSeriesEntry = "extra/fingerprint/004-screen-size.patch"
if ((Get-Content $seriesPath) -notcontains $screenSeriesEntry) {
    throw "The existing source does not include the Prism screen patch. Run Update-Screen-Patch.ps1 first."
}
Set-PrismKernelPatchSeries $KernelLock $seriesPath

$geolocationSource = Join-Path $SourcePath "third_party\blink\renderer\core\geolocation\geolocation.cc"
if (-not (Test-Path $geolocationSource)) {
    throw "The Chromium source tree is incomplete: $geolocationSource"
}
$alreadyApplied = Select-String -Path $geolocationSource -Pattern "GetFingerprintLocation" -Quiet
if (-not $alreadyApplied) {
    Push-Location $SourcePath
    try {
        & git.exe apply --check --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "The proxy geolocation patch does not apply cleanly to the current Chromium source."
        }
        & git.exe apply --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not apply the proxy geolocation patch."
        }
    } finally {
        Pop-Location
    }
}

if (-not (Select-String -Path $geolocationSource -Pattern "GetFingerprintLocation" -Quiet) -or
    -not (Select-String -Path $geolocationSource -Pattern "updating_ = false;" -Quiet)) {
    throw "The proxy geolocation patch verification failed."
}

$lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $lockPath)) {
    throw "The Prism build lock is missing. Do not rebuild until the prepared source has been inspected."
}
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$lockSchemaVersion = if ([int]$lock.schemaVersion -ge 5) {
    5
} elseif ($lock.PSObject.Properties.Name -contains "prismScreenConsistencyPatchSha256") {
    4
} else {
    3
}
$lock | Add-Member -NotePropertyName schemaVersion -NotePropertyValue $lockSchemaVersion -Force
$lock | Add-Member -NotePropertyName prismGeolocationPatchSha256 -NotePropertyValue $patchHash -Force
$lock | Add-Member -NotePropertyName geolocationPatchUpdatedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
$lock | ConvertTo-Json -Depth 6 | Set-Content -Path $lockPath -Encoding utf8

Write-Host "Prism proxy geolocation patch is ready." -ForegroundColor Green
if (Test-Path $BuildNinja) {
    Write-Host "Run Build-Kernel.ps1 again; Ninja will perform an incremental rebuild."
} else {
    Write-Host "Run Build-Kernel.ps1; the patch will be included in the first full build."
}
