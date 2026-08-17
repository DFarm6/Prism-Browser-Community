[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PatchContract = Get-PrismKernelPatch $KernelLock "040-domrect-calibration-authenticity.patch"
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\040-domrect-calibration-authenticity.patch"
$ElementSource = Join-Path $SourcePath "third_party\blink\renderer\core\dom\element.cc"
$RangeSource = Join-Path $SourcePath "third_party\blink\renderer\core\dom\range.cc"

if (-not (Test-Path $PatchPath)) { throw "Patch 040 is missing: $PatchPath" }
$actualHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($actualHash -ne $PatchContract.sha256) { throw "Unexpected patch 040 hash: $actualHash" }
if (-not (Test-Path $ElementSource) -or -not (Test-Path $RangeSource)) {
    throw "Prepared Chromium source was not found under $BuildRoot."
}
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
Copy-Item $PatchPath (Join-Path $fingerprintPatchDirectory "040-domrect-calibration-authenticity.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$elementMarker = Select-String -Path $ElementSource -Pattern "has_transformed_geometry" -SimpleMatch -Quiet
$rangeMarker = Select-String -Path $RangeSource -Pattern "quad.IsRectilinear()" -SimpleMatch -Quiet
if ($elementMarker -and $rangeMarker) {
    Write-Host "Patch 040 is already applied."
} elseif (-not $elementMarker -and -not $rangeMarker) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Patch 040 does not apply cleanly to the current Chromium source." }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Could not apply patch 040." }
} else {
    throw "Patch 040 is only partially applied. Preserve the source and send diagnostics back."
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) { throw "The Prism build lock is missing." }
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismDomRectCalibrationAuthenticityPatchSha256 -NotePropertyValue $PatchContract.sha256 -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism DOMRect calibration authenticity patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
