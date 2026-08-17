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
$PatchContract = Get-PrismKernelPatch $KernelLock "033-webgl-snapshot-speech-coherence.patch"
$ExpectedPatchHash = $PatchContract.sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\033-webgl-snapshot-speech-coherence.patch"
$WebGlSourceFile = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
$SpeechSourceFile = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"
$PredecessorFile = Join-Path $SourcePath "third_party\blink\renderer\modules\webgpu\gpu_adapter.cc"
$SourceMarkers = @(
    @{ Path = $WebGlSourceFile; Value = "ApplyRenderIdentityToWebGLSnapshot" },
    @{ Path = $WebGlSourceFile; Value = "top_left_rows" },
    @{ Path = $SpeechSourceFile; Value = 'render_identity != "v3" && render_identity != "v4"' }
)

if (-not (Test-Path $PatchPath)) {
    throw "Prism WebGL snapshot and speech coherence patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism WebGL snapshot and speech coherence patch hash: $patchHash"
}
if (-not (Test-Path $WebGlSourceFile) -or -not (Test-Path $SpeechSourceFile)) {
    throw "The prepared Chromium source is incomplete."
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
    throw "The Chromium build is still running. Wait for it to finish before applying patch 033."
}
if (-not (Test-Path $PredecessorFile) -or
    -not (Select-String -Path $PredecessorFile -Pattern "ApplyPrismWebGpuTemplateIdentity" -SimpleMatch -Quiet)) {
    throw "Patch 032 is missing. Apply the WebGPU template identity patch before patch 033."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
Copy-Item -Path $PatchPath -Destination (Join-Path $fingerprintPatchDirectory "033-webgl-snapshot-speech-coherence.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$appliedMarkerCount = @($SourceMarkers | Where-Object {
    Select-String -Path $_.Path -Pattern $_.Value -SimpleMatch -Quiet
}).Count
if ($appliedMarkerCount -ne 0 -and $appliedMarkerCount -ne $SourceMarkers.Count) {
    throw "The WebGL snapshot and speech coherence patch is only partially applied. Preserve the source and send the diagnostics back."
}
if ($appliedMarkerCount -eq 0) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The WebGL snapshot and speech coherence patch does not apply cleanly to the current Chromium source."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply the WebGL snapshot and speech coherence patch."
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) {
    throw "The Prism build lock is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismWebGlSnapshotSpeechCoherencePatchSha256 -NotePropertyValue $patchHash -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism WebGL snapshot and speech coherence patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
