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
$ExpectedPatchHash = (Get-PrismKernelPatch $KernelLock "005-screen-consistency.patch").sha256
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$BuildNinja = Join-Path $SourcePath "out\Default\build.ninja"
$PatchPath = Join-Path $PSScriptRoot "patches\005-screen-consistency.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism screen consistency patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism screen consistency patch hash: $patchHash"
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
    throw "The Chromium build is still running. Wait for it to finish before applying the screen consistency patch."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path (Join-Path $fingerprintPatchDirectory "004-screen-size.patch"))) {
    throw "The original Prism screen patch is missing. Do not apply the consistency patch to an unknown source."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "005-screen-consistency.patch") -Force

$seriesPath = Join-Path $FingerprintPath "patches\series"
$screenEntry = "extra/fingerprint/004-screen-size.patch"
if ((Get-Content $seriesPath) -notcontains $screenEntry) {
    throw "The existing patch series does not include the original Prism screen patch."
}
Set-PrismKernelPatchSeries $KernelLock $seriesPath

$screenSource = Join-Path $SourcePath "third_party\blink\renderer\core\frame\screen.cc"
$mediaValuesSource = Join-Path $SourcePath "third_party\blink\renderer\core\css\media_values.cc"
if (-not (Test-Path $screenSource) -or -not (Test-Path $mediaValuesSource)) {
    throw "The Chromium source tree is incomplete."
}
$screenApplied = Select-String -Path $screenSource -Pattern 'fingerprint_height - 48' -Quiet
$mediaApplied = Select-String -Path $mediaValuesSource -Pattern 'FingerprintScreenDimension' -Quiet
if ($screenApplied -ne $mediaApplied) {
    throw "The screen consistency patch is only partially applied. Preserve the source and send it back for inspection."
}
if (-not $screenApplied) {
    Push-Location $SourcePath
    try {
        & git.exe apply --check --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "The screen consistency patch does not apply cleanly to the current Chromium source."
        }
        & git.exe apply --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not apply the screen consistency patch."
        }
    } finally {
        Pop-Location
    }
}

if (-not (Select-String -Path $screenSource -Pattern 'fingerprint_height - 48' -Quiet) -or
    -not (Select-String -Path $mediaValuesSource -Pattern 'FingerprintScreenDimension' -Quiet)) {
    throw "The screen consistency patch verification failed."
}

$lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $lockPath)) {
    throw "The Prism build lock is missing."
}
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$lock | Add-Member -NotePropertyName schemaVersion -NotePropertyValue ([Math]::Max([int]$lock.schemaVersion, 4)) -Force
$lock | Add-Member -NotePropertyName prismScreenConsistencyPatchSha256 -NotePropertyValue $patchHash -Force
$lock | Add-Member -NotePropertyName screenConsistencyPatchUpdatedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
$lock | ConvertTo-Json -Depth 6 | Set-Content -Path $lockPath -Encoding utf8

Write-Host "Prism screen and CSS media-query consistency patch is ready." -ForegroundColor Green
if (Test-Path $BuildNinja) {
    Write-Host "Run Build-Kernel.ps1 again; Ninja will perform an incremental rebuild."
} else {
    Write-Host "Run Build-Kernel.ps1; the patch will be included in the first full build."
}
