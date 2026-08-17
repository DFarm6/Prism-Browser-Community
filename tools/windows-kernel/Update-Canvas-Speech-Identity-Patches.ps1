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
$CanvasPatchContract = Get-PrismKernelPatch $KernelLock "034-canvas-serialization-identity.patch"
$SpeechPatchContract = Get-PrismKernelPatch $KernelLock "035-locale-speech-catalog.patch"
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$CanvasPatchPath = Join-Path $PSScriptRoot "patches\034-canvas-serialization-identity.patch"
$SpeechPatchPath = Join-Path $PSScriptRoot "patches\035-locale-speech-catalog.patch"
$ImageBufferSource = Join-Path $SourcePath "third_party\blink\renderer\platform\graphics\image_data_buffer.cc"
$CanvasSource = Join-Path $SourcePath "third_party\blink\renderer\core\html\canvas\html_canvas_element.cc"
$SpeechSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"
$SpeechVoiceSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis_voice.h"
$SpeechUtteranceSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis_utterance.cc"
$PredecessorSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
$SourceMarkers = @(
    @{ Path = $ImageBufferSource; Value = "ApplyPrismCanvasSerializationIdentity" },
    @{ Path = $CanvasSource; Value = "data_buffer->ApplyPrismCanvasSerializationIdentity()" },
    @{ Path = $SpeechSource; Value = "UsesPrismLocaleVoiceCatalog" },
    @{ Path = $SpeechSource; Value = "Microsoft Haruka" },
    @{ Path = $SpeechVoiceSource; Value = "platformName()" },
    @{ Path = $SpeechUtteranceSource; Value = "voice_->platformName()" }
)

foreach ($patch in @(
    @{ Path = $CanvasPatchPath; Expected = $CanvasPatchContract.sha256 },
    @{ Path = $SpeechPatchPath; Expected = $SpeechPatchContract.sha256 }
)) {
    if (-not (Test-Path $patch.Path)) { throw "Required final fingerprint patch is missing: $($patch.Path)" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $patch.Path).Hash.ToLowerInvariant()
    if ($actual -ne $patch.Expected) { throw "Unexpected final fingerprint patch hash: $actual" }
}
if (-not (Test-Path $PredecessorSource) -or
    -not (Select-String -Path $PredecessorSource -Pattern "ApplyRenderIdentityToWebGLSnapshot" -SimpleMatch -Quiet)) {
    throw "Patch 033 is missing. Apply the v19 patch set before patches 034 and 035."
}
if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    throw "The prepared Chromium repositories were not found under $BuildRoot."
}
$platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
$fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($LASTEXITCODE -ne 0 -or $platformCommit -ne $ExpectedPlatformCommit -or
    $fingerprintCommit -ne $ExpectedFingerprintCommit) {
    throw "The prepared source does not match the pinned Prism Chromium 144 build."
}
$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) { throw "The Chromium build is still running." }

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest kit."
}
Copy-Item $CanvasPatchPath (Join-Path $fingerprintPatchDirectory "034-canvas-serialization-identity.patch") -Force
Copy-Item $SpeechPatchPath (Join-Path $fingerprintPatchDirectory "035-locale-speech-catalog.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$appliedMarkerCount = @($SourceMarkers | Where-Object {
    Select-String -Path $_.Path -Pattern $_.Value -SimpleMatch -Quiet
}).Count
if ($appliedMarkerCount -ne 0 -and $appliedMarkerCount -ne $SourceMarkers.Count) {
    throw "Patches 034/035 are only partially applied. Preserve the source and send diagnostics back."
}
if ($appliedMarkerCount -eq 0) {
    foreach ($patchPath in @($CanvasPatchPath, $SpeechPatchPath)) {
        & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $patchPath
        if ($LASTEXITCODE -ne 0) { throw "A final fingerprint patch does not apply cleanly: $patchPath" }
        & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $patchPath
        if ($LASTEXITCODE -ne 0) { throw "Could not apply final fingerprint patch: $patchPath" }
    }
}

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) { throw "The Prism build lock is missing." }
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$buildLock | Add-Member -NotePropertyName prismCanvasSerializationIdentityPatchSha256 -NotePropertyValue $CanvasPatchContract.sha256 -Force
$buildLock | Add-Member -NotePropertyName prismLocaleSpeechCatalogPatchSha256 -NotePropertyValue $SpeechPatchContract.sha256 -Force
$buildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism Canvas serialization and locale Speech catalog patches are ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
