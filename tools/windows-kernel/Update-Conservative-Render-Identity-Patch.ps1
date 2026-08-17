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
$ExpectedPatchHash = (Get-PrismKernelPatch $KernelLock "021-conservative-render-identity-v2.patch").sha256
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$BuildNinja = Join-Path $SourcePath "out\Default\build.ninja"
$PatchPath = Join-Path $PSScriptRoot "patches\021-conservative-render-identity-v2.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism conservative render identity patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism conservative render identity patch hash: $patchHash"
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
    throw "The Chromium build is still running. Wait for it to finish before applying conservative render identity v2."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$seriesPath = Join-Path $FingerprintPath "patches\series"
$renderIdentitySeriesEntry = "extra/fingerprint/020-render-identity-v1.patch"
if ((Get-Content $seriesPath) -notcontains $renderIdentitySeriesEntry) {
    throw "The existing source does not include render identity v1. Run Update-Render-Identity-Patch.ps1 first."
}
Copy-Item -Path $PatchPath `
    -Destination (Join-Path $fingerprintPatchDirectory "021-conservative-render-identity-v2.patch") `
    -Force
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$speechSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"
$fontSource = Join-Path $SourcePath "third_party\blink\renderer\platform\fonts\font_cache.cc"
$audioSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_context.cc"
$webglSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
$marker = 'render_identity != "v1" && render_identity != "v2"'
$alreadyApplied = (Test-Path $speechSource) -and
    (Test-Path $fontSource) -and
    (Select-String -Path $speechSource -Pattern $marker -SimpleMatch -Quiet) -and
    (Select-String -Path $fontSource -Pattern $marker -SimpleMatch -Quiet)
if (-not $alreadyApplied) {
    Push-Location $SourcePath
    try {
        & git.exe apply --check --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "The conservative render identity v2 patch does not apply cleanly to the current Chromium source."
        }
        & git.exe apply --whitespace=nowarn $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not apply conservative render identity v2."
        }
    } finally {
        Pop-Location
    }
}

foreach ($source in @($speechSource, $fontSource)) {
    if (-not (Test-Path $source) -or
        -not (Select-String -Path $source -Pattern $marker -SimpleMatch -Quiet)) {
        throw "Conservative render identity v2 verification failed at $source."
    }
}
foreach ($source in @($audioSource, $webglSource)) {
    if (-not (Test-Path $source) -or
        -not (Select-String -Path $source -Pattern 'switches::kFingerprintRenderIdentity) != "v1"' -SimpleMatch -Quiet)) {
        throw "Native WebGL/Audio protection verification failed at $source."
    }
}

$lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $lockPath)) {
    throw "The Prism build lock is missing. Do not rebuild until the prepared source has been inspected."
}
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$lock | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 5 -Force
$lock | Add-Member -NotePropertyName contractSha256 `
    -NotePropertyValue ((Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()) `
    -Force
$lock | Add-Member -NotePropertyName prismConservativeRenderIdentityPatchSha256 `
    -NotePropertyValue $patchHash `
    -Force
$lock | Add-Member -NotePropertyName conservativeRenderIdentityPatchUpdatedAtUtc `
    -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) `
    -Force
$lock | ConvertTo-Json -Depth 6 | Set-Content -Path $lockPath -Encoding utf8

Write-Host "Prism conservative render identity v2 patch is ready." -ForegroundColor Green
if (Test-Path $BuildNinja) {
    Write-Host "Run Build-Kernel.ps1 again; Ninja will perform an incremental rebuild."
} else {
    Write-Host "Run Build-Kernel.ps1; the patch will be included in the first full build."
}
