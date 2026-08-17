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
$PatchContract = Get-PrismKernelPatch $KernelLock "028-direct-domrect-consumption.patch"
$ExpectedPatchHash = $PatchContract.sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$DocumentPath = Join-Path $SourcePath "third_party\blink\renderer\core\dom\document.cc"
$ElementPath = Join-Path $SourcePath "third_party\blink\renderer\core\dom\element.cc"
$RangePath = Join-Path $SourcePath "third_party\blink\renderer\core\dom\range.cc"
$PatchPath = Join-Path $PSScriptRoot "patches\028-direct-domrect-consumption.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism direct DOMRect consumption patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism direct DOMRect consumption patch hash: $patchHash"
}
foreach ($path in @($DocumentPath, $ElementPath, $RangePath)) {
    if (-not (Test-Path $path)) {
        throw "The prepared Chromium source is incomplete: $path"
    }
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
    throw "The Chromium build is still running. Wait for it to finish before applying direct DOMRect consumption."
}
if (-not (Select-String -Path $DocumentPath -Pattern "coherent_render_identity ||" -SimpleMatch -Quiet)) {
    throw "Direct DOMRect identity is missing. Apply patch 027 before patch 028."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "028-direct-domrect-consumption.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$markers = @(
    @{ Path = $ElementPath; Value = "GetDocument().GetNoiseFactorX() != 1.0" },
    @{ Path = $RangePath; Value = "owner_document_->GetNoiseFactorX() != 1.0" }
)
$markerCount = @($markers | Where-Object {
    Select-String -Path $_.Path -Pattern $_.Value -SimpleMatch -Quiet
}).Count
if ($markerCount -ne 0 -and $markerCount -ne $markers.Count) {
    throw "Direct DOMRect consumption is only partially applied. Preserve the source and send it back for inspection."
}
if ($markerCount -eq 0) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The direct DOMRect consumption patch does not apply cleanly to the current Chromium source."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply direct DOMRect consumption."
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) {
    throw "The Prism build lock is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismDirectDomRectConsumptionPatchSha256 -NotePropertyValue $patchHash -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism direct DOMRect consumption patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
