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
$PatchContract = Get-PrismKernelPatch $KernelLock "026-canvas-seed-dispersion.patch"
$ExpectedPatchHash = $PatchContract.sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$CanvasRenderingPath = Join-Path $SourcePath "third_party\blink\renderer\modules\canvas\canvas2d\base_rendering_context_2d.cc"
$PatchPath = Join-Path $PSScriptRoot "patches\026-canvas-seed-dispersion.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism Canvas seed dispersion patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism Canvas seed dispersion patch hash: $patchHash"
}
if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git")) -or
    -not (Test-Path $CanvasRenderingPath)) {
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
    throw "The Chromium build is still running. Wait for it to finish before applying Canvas seed dispersion."
}
if (-not (Select-String -Path $CanvasRenderingPath -Pattern "state *= 0x846ca68bu" -SimpleMatch -Quiet)) {
    throw "Native surface consistency is missing. Apply patch 025 before patch 026."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "026-canvas-seed-dispersion.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$markers = @(
    "kCanvasOffsetMask = 0x0fu",
    "PrismCanvasTextOffset(0x27d4eb2du)",
    "PrismCanvasTextOffset(0x165667b1u)"
)
$markerCount = @($markers | Where-Object {
    Select-String -Path $CanvasRenderingPath -Pattern $_ -SimpleMatch -Quiet
}).Count
if ($markerCount -ne 0 -and $markerCount -ne $markers.Count) {
    throw "Canvas seed dispersion is only partially applied. Preserve the source and send it back for inspection."
}
if ($markerCount -eq 0) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The Canvas seed dispersion patch does not apply cleanly to the current Chromium source."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply Canvas seed dispersion."
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) {
    throw "The Prism build lock is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismCanvasSeedDispersionPatchSha256 -NotePropertyValue $patchHash -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism Canvas seed dispersion patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
