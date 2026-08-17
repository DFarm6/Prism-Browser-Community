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
$PatchContract = Get-PrismKernelPatch $KernelLock "023-coherent-render-identity-v3.patch"
$ExpectedPatchHash = $PatchContract.sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\023-coherent-render-identity-v3.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism coherent render identity v3 patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism coherent render identity v3 patch hash: $patchHash"
}
if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git")) -or
    -not (Test-Path $SourcePath)) {
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
    throw "The Chromium build is still running. Wait for it to finish before applying coherent render identity v3."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "023-coherent-render-identity-v3.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$markers = @(
    @((Join-Path $SourcePath "third_party\blink\renderer\core\dom\document.cc"), "PrismRenderIdentityNoise"),
    @((Join-Path $SourcePath "third_party\blink\renderer\modules\canvas\canvas2d\base_rendering_context_2d.cc"), "PrismCanvasTextOffset"),
    @((Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"), 'render_identity != "v3"'),
    @((Join-Path $SourcePath "third_party\blink\renderer\platform\fonts\font_cache.cc"), 'render_identity != "v3"'),
    @((Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_context.cc"), 'render_identity != "v1" && render_identity != "v3"'),
    @((Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"), 'render_identity != "v1" && render_identity != "v3"')
)
$markerCount = @($markers | Where-Object {
    (Test-Path $_[0]) -and (Select-String -Path $_[0] -Pattern $_[1] -SimpleMatch -Quiet)
}).Count
if ($markerCount -ne 0 -and $markerCount -ne $markers.Count) {
    throw "Coherent render identity v3 is only partially applied. Restore the affected source files before retrying."
}
if ($markerCount -eq 0) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The coherent render identity v3 patch does not apply cleanly to the current Chromium source."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply coherent render identity v3."
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) {
    throw "The Prism build lock is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismCoherentRenderIdentityPatchSha256 -NotePropertyValue $patchHash -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism coherent render identity v3 patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
