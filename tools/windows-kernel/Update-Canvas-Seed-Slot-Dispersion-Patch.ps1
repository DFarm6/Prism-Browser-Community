[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PatchContract = Get-PrismKernelPatch $KernelLock "037-canvas-seed-slot-dispersion.patch"
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\037-canvas-seed-slot-dispersion.patch"
$CanvasSource = Join-Path $SourcePath "third_party\blink\renderer\modules\canvas\canvas2d\base_rendering_context_2d.cc"

if (-not (Test-Path $PatchPath)) { throw "Patch 037 is missing: $PatchPath" }
$actualHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($actualHash -ne $PatchContract.sha256) { throw "Unexpected patch 037 hash: $actualHash" }
if (-not (Test-Path $CanvasSource)) { throw "Prepared Chromium source was not found under $BuildRoot." }
if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    throw "The prepared Chromium repositories were not found under $BuildRoot."
}
$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) { throw "The Chromium build is still running." }

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) { throw "The fingerprint patch directory is missing." }
Copy-Item $PatchPath (Join-Path $fingerprintPatchDirectory "037-canvas-seed-slot-dispersion.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$oldSlot = Select-String -Path $CanvasSource -Pattern "kCanvasOffsetMask = 0x3fu" -SimpleMatch -Quiet
$newBits = Select-String -Path $CanvasSource -Pattern "kCanvasOffsetBits = 6u" -SimpleMatch -Quiet
$newShift = Select-String -Path $CanvasSource -Pattern "state >> (32u - kCanvasOffsetBits)" -SimpleMatch -Quiet
if (-not $oldSlot -and $newBits -and $newShift) {
    Write-Host "Patch 037 is already applied."
} elseif ($oldSlot -and -not $newBits -and -not $newShift) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Patch 037 does not apply cleanly to the current Chromium source." }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Could not apply patch 037." }
} else {
    throw "Patch 037 is only partially applied. Preserve the source and send diagnostics back."
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) { throw "The Prism build lock is missing." }
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismCanvasSeedSlotDispersionPatchSha256 -NotePropertyValue $PatchContract.sha256 -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism Canvas seed slot dispersion patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
