[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PatchContract = Get-PrismKernelPatch $KernelLock "042-native-canvas-audio-calibration.patch"
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\042-native-canvas-audio-calibration.patch"
$CanvasSource = Join-Path $SourcePath "third_party\blink\renderer\modules\canvas\canvas2d\base_rendering_context_2d.cc"
$AudioSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_context.cc"

if (-not (Test-Path $PatchPath)) { throw "Patch 042 is missing: $PatchPath" }
$ActualHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($ActualHash -ne $PatchContract.sha256) { throw "Unexpected patch 042 hash: $ActualHash" }
if (-not (Test-Path $CanvasSource) -or -not (Test-Path $AudioSource)) {
    throw "Prepared Chromium source was not found under $BuildRoot."
}
$ActiveNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($ActiveNinja.Count -gt 0) { throw "The Chromium build is still running." }

$FingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
Copy-Item $PatchPath (Join-Path $FingerprintPatchDirectory "042-native-canvas-audio-calibration.patch") -Force
$SeriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $SeriesPath
Assert-PrismKernelPatchSeries $KernelLock $SeriesPath

$CanvasMarker = Select-String -Path $CanvasSource -Pattern "NormalizePrismCanvasLowEntropyCalibration" -SimpleMatch -Quiet
$AudioMarker = Select-String -Path $AudioSource -Pattern "permutation_length" -SimpleMatch -Quiet
if ($CanvasMarker -and $AudioMarker) {
    Write-Host "Patch 042 is already applied."
} elseif (-not $CanvasMarker -and -not $AudioMarker) {
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Patch 042 does not apply cleanly to the current Chromium source." }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "Could not apply patch 042." }
} else {
    throw "Patch 042 is only partially applied. Preserve the source and send diagnostics back."
}

$BuildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $BuildLockPath)) { throw "The Prism build lock is missing." }
$BuildLock = Get-Content $BuildLockPath -Raw | ConvertFrom-Json
$BuildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ExpectedContractHash -Force
$BuildLock | Add-Member -NotePropertyName prismNativeCanvasAudioCalibrationPatchSha256 -NotePropertyValue $PatchContract.sha256 -Force
$BuildLock | Add-Member -NotePropertyName patches -NotePropertyValue @($KernelLock.patches | ForEach-Object {
    [ordered]@{ id = $_.id; file = $_.file; sha256 = $_.sha256 }
}) -Force
$BuildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $BuildLockPath -Encoding utf8

Write-Host ""
Write-Host "Prism native Canvas and Audio calibration patch is ready."
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
