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
$PatchContract = Get-PrismKernelPatch $KernelLock "027-direct-domrect-identity.patch"
$ExpectedPatchHash = $PatchContract.sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$DocumentPath = Join-Path $SourcePath "third_party\blink\renderer\core\dom\document.cc"
$PatchPath = Join-Path $PSScriptRoot "patches\027-direct-domrect-identity.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism direct DOMRect identity patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism direct DOMRect identity patch hash: $patchHash"
}
if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git")) -or
    -not (Test-Path $DocumentPath)) {
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
    throw "The Chromium build is still running. Wait for it to finish before applying direct DOMRect identity."
}
if (-not (Select-String -Path $DocumentPath -Pattern "kNoiseMask = 0xffffu" -SimpleMatch -Quiet)) {
    throw "DOMRect seed mixing is missing. Apply patches 023 and 024 before patch 027."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "027-direct-domrect-identity.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$markers = @(
    "coherent_render_identity ||",
    "not need Chromium's unsupported --enable-blink-features warning flag"
)
$markerCount = @($markers | Where-Object {
    Select-String -Path $DocumentPath -Pattern $_ -SimpleMatch -Quiet
}).Count
if ($markerCount -ne 0 -and $markerCount -ne $markers.Count) {
    throw "Direct DOMRect identity is only partially applied. Preserve the source and send it back for inspection."
}
if ($markerCount -eq 0) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The direct DOMRect identity patch does not apply cleanly to the current Chromium source."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply direct DOMRect identity."
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) {
    throw "The Prism build lock is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismDirectDomRectIdentityPatchSha256 -NotePropertyValue $patchHash -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism direct DOMRect identity patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
