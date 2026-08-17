[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PlatformContract = $KernelLock.platforms.'windows-x64'
$PlatformRepository = $PlatformContract.repository
$PlatformTag = $PlatformContract.tag
$PlatformCommit = $PlatformContract.commit
$FingerprintRepository = $KernelLock.fingerprint.repository
$FingerprintTag = $KernelLock.fingerprint.tag
$FingerprintCommit = $KernelLock.fingerprint.commit
$ChromiumVersion = $KernelLock.chromiumVersion
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$PrismScreenPatchPath = Join-Path $PSScriptRoot "patches\004-screen-size.patch"
$PrismScreenConsistencyPatchPath = Join-Path $PSScriptRoot "patches\005-screen-consistency.patch"
$PrismGeolocationPatchPath = Join-Path $PSScriptRoot "patches\019-proxy-geolocation.patch"
$PrismRenderIdentityPatchPath = Join-Path $PSScriptRoot "patches\020-render-identity-v1.patch"
$PrismConservativeRenderIdentityPatchPath = Join-Path $PSScriptRoot "patches\021-conservative-render-identity-v2.patch"
$PrismProfileWindowIdentityPatchPath = Join-Path $PSScriptRoot "patches\022-profile-window-identity.patch"
$PrismCoherentRenderIdentityPatchPath = Join-Path $PSScriptRoot "patches\023-coherent-render-identity-v3.patch"
$PrismDomRectSeedMixingPatchPath = Join-Path $PSScriptRoot "patches\024-domrect-seed-mixing.patch"
$PrismNativeSurfaceConsistencyPatchPath = Join-Path $PSScriptRoot "patches\025-native-surface-consistency.patch"
$PrismCanvasSeedDispersionPatchPath = Join-Path $PSScriptRoot "patches\026-canvas-seed-dispersion.patch"
$PrismDirectDomRectIdentityPatchPath = Join-Path $PSScriptRoot "patches\027-direct-domrect-identity.patch"
$PrismDirectDomRectConsumptionPatchPath = Join-Path $PSScriptRoot "patches\028-direct-domrect-consumption.patch"
$PrismNativeLocaleSurfacesV4PatchPath = Join-Path $PSScriptRoot "patches\029-native-locale-surfaces-v4.patch"
$PrismWindowsNativeTtsVoicesPatchPath = Join-Path $PSScriptRoot "patches\030-windows-native-tts-voices.patch"
$PrismWindowsTtsRuntimePatchPath = Join-Path $PSScriptRoot "patches\031-windows-tts-runtime.patch"
$PrismWebGpuTemplateIdentityPatchPath = Join-Path $PSScriptRoot "patches\032-webgpu-template-identity.patch"
$PrismWebGlSnapshotSpeechCoherencePatchPath = Join-Path $PSScriptRoot "patches\033-webgl-snapshot-speech-coherence.patch"
$PrismCanvasSerializationIdentityPatchPath = Join-Path $PSScriptRoot "patches\034-canvas-serialization-identity.patch"
$PrismLocaleSpeechCatalogPatchPath = Join-Path $PSScriptRoot "patches\035-locale-speech-catalog.patch"
$PrismCoherentCanvasReadbackPatchPath = Join-Path $PSScriptRoot "patches\036-coherent-canvas-readback.patch"
$PrismCanvasSeedSlotDispersionPatchPath = Join-Path $PSScriptRoot "patches\037-canvas-seed-slot-dispersion.patch"
$PrismWebGlCalibrationAuthenticityPatchPath = Join-Path $PSScriptRoot "patches\038-webgl-calibration-authenticity.patch"
$PrismNativeFontInventoryAuthenticityPatchPath = Join-Path $PSScriptRoot "patches\039-native-font-inventory-authenticity.patch"
$PrismDomRectCalibrationAuthenticityPatchPath = Join-Path $PSScriptRoot "patches\040-domrect-calibration-authenticity.patch"
$PrismMacOsIntlLocalePatchPath = Join-Path $PSScriptRoot "patches\041-macos-intl-locale.patch"
$PrismNativeCanvasAudioCalibrationPatchPath = Join-Path $PSScriptRoot "patches\042-native-canvas-audio-calibration.patch"
$PrismAudioNoiseTrapAuthenticityPatchPath = Join-Path $PSScriptRoot "patches\043-audio-noise-trap-authenticity.patch"
$PrismWindowsTaskbarBadgeReadinessPatchPath = Join-Path $PSScriptRoot "patches\044-windows-taskbar-badge-readiness.patch"

function Invoke-Git {
    param(
        [string]$WorkingDirectory,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    if ($WorkingDirectory) {
        & git.exe -C $WorkingDirectory @Arguments
    } else {
        & git.exe @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git $($Arguments -join ' ')"
    }
}

if ($BuildRoot.Contains(" ") -or $BuildRoot.Length -gt 40) {
    throw "Use a short build path without spaces, for example D:\prism-chromium."
}

$driveLetter = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$volume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
if ($volume.FileSystem -ne "NTFS") {
    throw "The build drive must use NTFS. Current filesystem: $($volume.FileSystem)."
}

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
git.exe config --global core.longpaths true
if ($LASTEXITCODE -ne 0) {
    throw "Could not enable Git long-path support."
}

$repositoryWasCloned = $false
if (-not (Test-Path $RepositoryPath)) {
    Write-Host "Cloning the pinned Windows platform repository..."
    Invoke-Git "" clone --filter=blob:none --depth 1 --branch $PlatformTag $PlatformRepository $RepositoryPath
    $repositoryWasCloned = $true
} elseif (-not (Test-Path (Join-Path $RepositoryPath ".git"))) {
    throw "$RepositoryPath exists but is not a Git repository. Choose an empty BuildRoot."
}

if (-not $repositoryWasCloned) {
    $platformDirty = @(& git.exe -C $RepositoryPath status --porcelain --untracked-files=no)
    $unexpectedPlatformChanges = @($platformDirty | Where-Object {
        $_ -notmatch "^[ MADRCU?!]{2} ungoogled-chromium$" `
            -and $_ -ne " M build.py"
    })
    if ($unexpectedPlatformChanges.Count -gt 0) {
        throw "The Windows platform repository has local changes. Refusing to overwrite them."
    }
}

Write-Host "Checking out Windows platform tag $PlatformTag..."
Invoke-Git $RepositoryPath fetch --depth 1 origin "refs/tags/$PlatformTag`:refs/tags/$PlatformTag"
Invoke-Git $RepositoryPath checkout --detach "refs/tags/$PlatformTag"
$actualPlatformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
if ($actualPlatformCommit -ne $PlatformCommit) {
    throw "Unexpected platform commit: $actualPlatformCommit"
}

if ((Test-Path $FingerprintPath) -and -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    $submoduleEntry = (& git.exe -C $RepositoryPath ls-files --stage -- "ungoogled-chromium") -join ""
    $placeholderFiles = @(Get-ChildItem -LiteralPath $FingerprintPath -Force -ErrorAction SilentlyContinue)
    if ($submoduleEntry -match "^160000 " -or $placeholderFiles.Count -eq 0) {
        Write-Host "Removing the platform repository fingerprint submodule placeholder..."
        Remove-Item -LiteralPath $FingerprintPath -Recurse -Force
    } else {
        throw "$FingerprintPath exists, is not a Git repository, and contains unrecognized files."
    }
}

if (-not (Test-Path $FingerprintPath)) {
    Write-Host "Cloning the pinned fingerprint patch repository..."
    Invoke-Git "" clone --filter=blob:none --depth 1 --branch $FingerprintTag $FingerprintRepository $FingerprintPath
} else {
    $fingerprintDirty = @(& git.exe -C $FingerprintPath status --porcelain)
    $unexpectedFingerprintChanges = @($fingerprintDirty | Where-Object {
            $_ -ne " M patches/series" `
            -and $_ -ne "?? patches/extra/fingerprint/004-screen-size.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/005-screen-consistency.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/019-proxy-geolocation.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/020-render-identity-v1.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/021-conservative-render-identity-v2.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/022-profile-window-identity.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/023-coherent-render-identity-v3.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/024-domrect-seed-mixing.patch"
            -and $_ -ne "?? patches/extra/fingerprint/025-native-surface-consistency.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/026-canvas-seed-dispersion.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/027-direct-domrect-identity.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/028-direct-domrect-consumption.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/029-native-locale-surfaces-v4.patch"
            -and $_ -ne "?? patches/extra/fingerprint/030-windows-native-tts-voices.patch"
            -and $_ -ne "?? patches/extra/fingerprint/031-windows-tts-runtime.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/032-webgpu-template-identity.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/033-webgl-snapshot-speech-coherence.patch"
            -and $_ -ne "?? patches/extra/fingerprint/034-canvas-serialization-identity.patch" `
            -and $_ -ne "?? patches/extra/fingerprint/035-locale-speech-catalog.patch"
            -and $_ -ne "?? patches/extra/fingerprint/036-coherent-canvas-readback.patch"
            -and $_ -ne "?? patches/extra/fingerprint/037-canvas-seed-slot-dispersion.patch"
            -and $_ -ne "?? patches/extra/fingerprint/038-webgl-calibration-authenticity.patch"
            -and $_ -ne "?? patches/extra/fingerprint/039-native-font-inventory-authenticity.patch"
            -and $_ -ne "?? patches/extra/fingerprint/040-domrect-calibration-authenticity.patch"
            -and $_ -ne "?? patches/extra/fingerprint/041-macos-intl-locale.patch"
            -and $_ -ne "?? patches/extra/fingerprint/042-native-canvas-audio-calibration.patch"
            -and $_ -ne "?? patches/extra/fingerprint/043-audio-noise-trap-authenticity.patch"
            -and $_ -ne "?? patches/extra/fingerprint/044-windows-taskbar-badge-readiness.patch"
    })
    if ($unexpectedFingerprintChanges.Count -gt 0) {
        throw "The fingerprint repository has local changes. Refusing to overwrite them."
    }
    Write-Host "Checking out fingerprint tag $FingerprintTag..."
    Invoke-Git $FingerprintPath fetch --depth 1 origin "refs/tags/$FingerprintTag`:refs/tags/$FingerprintTag"
    Invoke-Git $FingerprintPath checkout --detach "refs/tags/$FingerprintTag"
}

$actualFingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($actualFingerprintCommit -ne $FingerprintCommit) {
    throw "Unexpected fingerprint commit: $actualFingerprintCommit"
}

$chromiumVersion = (Get-Content (Join-Path $FingerprintPath "chromium_version.txt") -Raw).Trim()
if ($chromiumVersion -ne $ChromiumVersion) {
    throw "Unexpected Chromium version: $chromiumVersion"
}

if (-not (Test-Path $PrismScreenPatchPath)) {
    throw "Prism screen fingerprint patch is missing: $PrismScreenPatchPath"
}
if (-not (Test-Path $PrismScreenConsistencyPatchPath)) {
    throw "Prism screen consistency patch is missing: $PrismScreenConsistencyPatchPath"
}
if (-not (Test-Path $PrismGeolocationPatchPath)) {
    throw "Prism proxy geolocation patch is missing: $PrismGeolocationPatchPath"
}
if (-not (Test-Path $PrismRenderIdentityPatchPath)) {
    throw "Prism render identity patch is missing: $PrismRenderIdentityPatchPath"
}
if (-not (Test-Path $PrismConservativeRenderIdentityPatchPath)) {
    throw "Prism conservative render identity patch is missing: $PrismConservativeRenderIdentityPatchPath"
}
if (-not (Test-Path $PrismProfileWindowIdentityPatchPath)) {
    throw "Prism profile window identity patch is missing: $PrismProfileWindowIdentityPatchPath"
}
if (-not (Test-Path $PrismCoherentRenderIdentityPatchPath)) {
    throw "Prism coherent render identity v3 patch is missing: $PrismCoherentRenderIdentityPatchPath"
}
if (-not (Test-Path $PrismDomRectSeedMixingPatchPath)) {
    throw "Prism DOMRect seed mixing patch is missing: $PrismDomRectSeedMixingPatchPath"
}
if (-not (Test-Path $PrismNativeSurfaceConsistencyPatchPath)) {
    throw "Prism native surface consistency patch is missing: $PrismNativeSurfaceConsistencyPatchPath"
}
if (-not (Test-Path $PrismCanvasSeedDispersionPatchPath)) {
    throw "Prism Canvas seed dispersion patch is missing: $PrismCanvasSeedDispersionPatchPath"
}
if (-not (Test-Path $PrismDirectDomRectIdentityPatchPath)) {
    throw "Prism direct DOMRect identity patch is missing: $PrismDirectDomRectIdentityPatchPath"
}
if (-not (Test-Path $PrismDirectDomRectConsumptionPatchPath)) {
    throw "Prism direct DOMRect consumption patch is missing: $PrismDirectDomRectConsumptionPatchPath"
}
if (-not (Test-Path $PrismNativeLocaleSurfacesV4PatchPath)) {
    throw "Prism native locale surfaces v4 patch is missing: $PrismNativeLocaleSurfacesV4PatchPath"
}
if (-not (Test-Path $PrismWindowsNativeTtsVoicesPatchPath)) {
    throw "Prism Windows native TTS voices patch is missing: $PrismWindowsNativeTtsVoicesPatchPath"
}
if (-not (Test-Path $PrismWindowsTtsRuntimePatchPath)) {
    throw "Prism Windows TTS runtime patch is missing: $PrismWindowsTtsRuntimePatchPath"
}
if (-not (Test-Path $PrismWebGpuTemplateIdentityPatchPath)) {
    throw "Prism WebGPU template identity patch is missing: $PrismWebGpuTemplateIdentityPatchPath"
}
if (-not (Test-Path $PrismWebGlSnapshotSpeechCoherencePatchPath)) {
    throw "Prism WebGL snapshot and speech coherence patch is missing: $PrismWebGlSnapshotSpeechCoherencePatchPath"
}
if (-not (Test-Path $PrismCanvasSerializationIdentityPatchPath) -or
    -not (Test-Path $PrismLocaleSpeechCatalogPatchPath)) {
    throw "Prism Canvas/Speech final patches are missing."
}
if (-not (Test-Path $PrismCoherentCanvasReadbackPatchPath)) {
    throw "Prism coherent Canvas readback patch is missing: $PrismCoherentCanvasReadbackPatchPath"
}
if (-not (Test-Path $PrismCanvasSeedSlotDispersionPatchPath)) {
    throw "Prism Canvas seed slot dispersion patch is missing: $PrismCanvasSeedSlotDispersionPatchPath"
}
if (-not (Test-Path $PrismWebGlCalibrationAuthenticityPatchPath)) {
    throw "Prism WebGL calibration authenticity patch is missing: $PrismWebGlCalibrationAuthenticityPatchPath"
}
$expectedPrismScreenPatchHash = (Get-PrismKernelPatch $KernelLock "004-screen-size.patch").sha256
$expectedPrismScreenConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "005-screen-consistency.patch").sha256
$expectedPrismGeolocationPatchHash = (Get-PrismKernelPatch $KernelLock "019-proxy-geolocation.patch").sha256
$expectedPrismRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "020-render-identity-v1.patch").sha256
$expectedPrismConservativeRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "021-conservative-render-identity-v2.patch").sha256
$expectedPrismProfileWindowIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "022-profile-window-identity.patch").sha256
$expectedPrismCoherentRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "023-coherent-render-identity-v3.patch").sha256
$expectedPrismDomRectSeedMixingPatchHash = (Get-PrismKernelPatch $KernelLock "024-domrect-seed-mixing.patch").sha256
$expectedPrismNativeSurfaceConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "025-native-surface-consistency.patch").sha256
$expectedPrismCanvasSeedDispersionPatchHash = (Get-PrismKernelPatch $KernelLock "026-canvas-seed-dispersion.patch").sha256
$expectedPrismDirectDomRectIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "027-direct-domrect-identity.patch").sha256
$expectedPrismDirectDomRectConsumptionPatchHash = (Get-PrismKernelPatch $KernelLock "028-direct-domrect-consumption.patch").sha256
$expectedPrismNativeLocaleSurfacesV4PatchHash = (Get-PrismKernelPatch $KernelLock "029-native-locale-surfaces-v4.patch").sha256
$expectedPrismWindowsNativeTtsVoicesPatchHash = (Get-PrismKernelPatch $KernelLock "030-windows-native-tts-voices.patch").sha256
$expectedPrismWindowsTtsRuntimePatchHash = (Get-PrismKernelPatch $KernelLock "031-windows-tts-runtime.patch").sha256
$expectedPrismWebGpuTemplateIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "032-webgpu-template-identity.patch").sha256
$expectedPrismWebGlSnapshotSpeechCoherencePatchHash = (Get-PrismKernelPatch $KernelLock "033-webgl-snapshot-speech-coherence.patch").sha256
$expectedPrismCanvasSerializationIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "034-canvas-serialization-identity.patch").sha256
$expectedPrismLocaleSpeechCatalogPatchHash = (Get-PrismKernelPatch $KernelLock "035-locale-speech-catalog.patch").sha256
$expectedPrismCoherentCanvasReadbackPatchHash = (Get-PrismKernelPatch $KernelLock "036-coherent-canvas-readback.patch").sha256
$expectedPrismCanvasSeedSlotDispersionPatchHash = (Get-PrismKernelPatch $KernelLock "037-canvas-seed-slot-dispersion.patch").sha256
$expectedPrismWebGlCalibrationAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "038-webgl-calibration-authenticity.patch").sha256
$expectedPrismNativeFontInventoryAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "039-native-font-inventory-authenticity.patch").sha256
$expectedPrismDomRectCalibrationAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "040-domrect-calibration-authenticity.patch").sha256
$expectedPrismMacOsIntlLocalePatchHash = (Get-PrismKernelPatch $KernelLock "041-macos-intl-locale.patch").sha256
$expectedPrismNativeCanvasAudioCalibrationPatchHash = (Get-PrismKernelPatch $KernelLock "042-native-canvas-audio-calibration.patch").sha256
$expectedPrismAudioNoiseTrapAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "043-audio-noise-trap-authenticity.patch").sha256
$expectedPrismWindowsTaskbarBadgeReadinessPatchHash = (Get-PrismKernelPatch $KernelLock "044-windows-taskbar-badge-readiness.patch").sha256
$prismScreenPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismScreenPatchPath).Hash.ToLowerInvariant()
$prismScreenConsistencyPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismScreenConsistencyPatchPath).Hash.ToLowerInvariant()
$prismGeolocationPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismGeolocationPatchPath).Hash.ToLowerInvariant()
$prismRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismRenderIdentityPatchPath).Hash.ToLowerInvariant()
$prismConservativeRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismConservativeRenderIdentityPatchPath).Hash.ToLowerInvariant()
$prismProfileWindowIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismProfileWindowIdentityPatchPath).Hash.ToLowerInvariant()
$prismCoherentRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismCoherentRenderIdentityPatchPath).Hash.ToLowerInvariant()
$prismDomRectSeedMixingPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismDomRectSeedMixingPatchPath).Hash.ToLowerInvariant()
$prismNativeSurfaceConsistencyPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismNativeSurfaceConsistencyPatchPath).Hash.ToLowerInvariant()
$prismCanvasSeedDispersionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismCanvasSeedDispersionPatchPath).Hash.ToLowerInvariant()
$prismDirectDomRectIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismDirectDomRectIdentityPatchPath).Hash.ToLowerInvariant()
$prismDirectDomRectConsumptionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismDirectDomRectConsumptionPatchPath).Hash.ToLowerInvariant()
$prismNativeLocaleSurfacesV4PatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismNativeLocaleSurfacesV4PatchPath).Hash.ToLowerInvariant()
$prismWindowsNativeTtsVoicesPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWindowsNativeTtsVoicesPatchPath).Hash.ToLowerInvariant()
$prismWindowsTtsRuntimePatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWindowsTtsRuntimePatchPath).Hash.ToLowerInvariant()
$prismWebGpuTemplateIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWebGpuTemplateIdentityPatchPath).Hash.ToLowerInvariant()
$prismWebGlSnapshotSpeechCoherencePatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWebGlSnapshotSpeechCoherencePatchPath).Hash.ToLowerInvariant()
$prismCanvasSerializationIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismCanvasSerializationIdentityPatchPath).Hash.ToLowerInvariant()
$prismLocaleSpeechCatalogPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismLocaleSpeechCatalogPatchPath).Hash.ToLowerInvariant()
$prismCoherentCanvasReadbackPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismCoherentCanvasReadbackPatchPath).Hash.ToLowerInvariant()
$prismCanvasSeedSlotDispersionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismCanvasSeedSlotDispersionPatchPath).Hash.ToLowerInvariant()
$prismWebGlCalibrationAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWebGlCalibrationAuthenticityPatchPath).Hash.ToLowerInvariant()
$prismNativeFontInventoryAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismNativeFontInventoryAuthenticityPatchPath).Hash.ToLowerInvariant()
$prismDomRectCalibrationAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismDomRectCalibrationAuthenticityPatchPath).Hash.ToLowerInvariant()
$prismMacOsIntlLocalePatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismMacOsIntlLocalePatchPath).Hash.ToLowerInvariant()
$prismNativeCanvasAudioCalibrationPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismNativeCanvasAudioCalibrationPatchPath).Hash.ToLowerInvariant()
$prismAudioNoiseTrapAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismAudioNoiseTrapAuthenticityPatchPath).Hash.ToLowerInvariant()
$prismWindowsTaskbarBadgeReadinessPatchHash = (Get-FileHash -Algorithm SHA256 -Path $PrismWindowsTaskbarBadgeReadinessPatchPath).Hash.ToLowerInvariant()
if ($prismScreenPatchHash -ne $expectedPrismScreenPatchHash) {
    throw "Unexpected Prism screen patch hash: $prismScreenPatchHash"
}
if ($prismScreenConsistencyPatchHash -ne $expectedPrismScreenConsistencyPatchHash) {
    throw "Unexpected Prism screen consistency patch hash: $prismScreenConsistencyPatchHash"
}
if ($prismGeolocationPatchHash -ne $expectedPrismGeolocationPatchHash) {
    throw "Unexpected Prism proxy geolocation patch hash: $prismGeolocationPatchHash"
}
if ($prismRenderIdentityPatchHash -ne $expectedPrismRenderIdentityPatchHash) {
    throw "Unexpected Prism render identity patch hash: $prismRenderIdentityPatchHash"
}
if ($prismConservativeRenderIdentityPatchHash -ne $expectedPrismConservativeRenderIdentityPatchHash) {
    throw "Unexpected Prism conservative render identity patch hash: $prismConservativeRenderIdentityPatchHash"
}
if ($prismProfileWindowIdentityPatchHash -ne $expectedPrismProfileWindowIdentityPatchHash) {
    throw "Unexpected Prism profile window identity patch hash: $prismProfileWindowIdentityPatchHash"
}
if ($prismCoherentRenderIdentityPatchHash -ne $expectedPrismCoherentRenderIdentityPatchHash) {
    throw "Unexpected Prism coherent render identity v3 patch hash: $prismCoherentRenderIdentityPatchHash"
}
if ($prismDomRectSeedMixingPatchHash -ne $expectedPrismDomRectSeedMixingPatchHash) {
    throw "Unexpected Prism DOMRect seed mixing patch hash: $prismDomRectSeedMixingPatchHash"
}
if ($prismNativeSurfaceConsistencyPatchHash -ne $expectedPrismNativeSurfaceConsistencyPatchHash) {
    throw "Unexpected Prism native surface consistency patch hash: $prismNativeSurfaceConsistencyPatchHash"
}
if ($prismCanvasSeedDispersionPatchHash -ne $expectedPrismCanvasSeedDispersionPatchHash) {
    throw "Unexpected Prism Canvas seed dispersion patch hash: $prismCanvasSeedDispersionPatchHash"
}
if ($prismDirectDomRectIdentityPatchHash -ne $expectedPrismDirectDomRectIdentityPatchHash) {
    throw "Unexpected Prism direct DOMRect identity patch hash: $prismDirectDomRectIdentityPatchHash"
}
if ($prismDirectDomRectConsumptionPatchHash -ne $expectedPrismDirectDomRectConsumptionPatchHash) {
    throw "Unexpected Prism direct DOMRect consumption patch hash: $prismDirectDomRectConsumptionPatchHash"
}
if ($prismNativeLocaleSurfacesV4PatchHash -ne $expectedPrismNativeLocaleSurfacesV4PatchHash) {
    throw "Unexpected Prism native locale surfaces v4 patch hash: $prismNativeLocaleSurfacesV4PatchHash"
}
if ($prismWindowsNativeTtsVoicesPatchHash -ne $expectedPrismWindowsNativeTtsVoicesPatchHash) {
    throw "Unexpected Prism Windows native TTS voices patch hash: $prismWindowsNativeTtsVoicesPatchHash"
}
if ($prismWindowsTtsRuntimePatchHash -ne $expectedPrismWindowsTtsRuntimePatchHash) {
    throw "Unexpected Prism Windows TTS runtime patch hash: $prismWindowsTtsRuntimePatchHash"
}
if ($prismWebGpuTemplateIdentityPatchHash -ne $expectedPrismWebGpuTemplateIdentityPatchHash) {
    throw "Unexpected Prism WebGPU template identity patch hash: $prismWebGpuTemplateIdentityPatchHash"
}
if ($prismWebGlSnapshotSpeechCoherencePatchHash -ne $expectedPrismWebGlSnapshotSpeechCoherencePatchHash) {
    throw "Unexpected Prism WebGL snapshot and speech coherence patch hash: $prismWebGlSnapshotSpeechCoherencePatchHash"
}
if ($prismCanvasSerializationIdentityPatchHash -ne $expectedPrismCanvasSerializationIdentityPatchHash -or
    $prismLocaleSpeechCatalogPatchHash -ne $expectedPrismLocaleSpeechCatalogPatchHash) {
    throw "Unexpected Prism Canvas/Speech final patch hash."
}
if ($prismCoherentCanvasReadbackPatchHash -ne $expectedPrismCoherentCanvasReadbackPatchHash) {
    throw "Unexpected Prism coherent Canvas readback patch hash: $prismCoherentCanvasReadbackPatchHash"
}
if ($prismCanvasSeedSlotDispersionPatchHash -ne $expectedPrismCanvasSeedSlotDispersionPatchHash) {
    throw "Unexpected Prism Canvas seed slot dispersion patch hash: $prismCanvasSeedSlotDispersionPatchHash"
}
if ($prismWebGlCalibrationAuthenticityPatchHash -ne $expectedPrismWebGlCalibrationAuthenticityPatchHash) {
    throw "Unexpected Prism WebGL calibration authenticity patch hash: $prismWebGlCalibrationAuthenticityPatchHash"
}
if ($prismNativeFontInventoryAuthenticityPatchHash -ne $expectedPrismNativeFontInventoryAuthenticityPatchHash) {
    throw "Unexpected Prism native font inventory authenticity patch hash: $prismNativeFontInventoryAuthenticityPatchHash"
}
if ($prismDomRectCalibrationAuthenticityPatchHash -ne $expectedPrismDomRectCalibrationAuthenticityPatchHash) {
    throw "Unexpected Prism DOMRect calibration authenticity patch hash: $prismDomRectCalibrationAuthenticityPatchHash"
}
if ($prismMacOsIntlLocalePatchHash -ne $expectedPrismMacOsIntlLocalePatchHash) {
    throw "Unexpected Prism macOS Intl locale patch hash: $prismMacOsIntlLocalePatchHash"
}
if ($prismNativeCanvasAudioCalibrationPatchHash -ne $expectedPrismNativeCanvasAudioCalibrationPatchHash) {
    throw "Unexpected Prism native Canvas/Audio calibration patch hash: $prismNativeCanvasAudioCalibrationPatchHash"
}
if ($prismAudioNoiseTrapAuthenticityPatchHash -ne $expectedPrismAudioNoiseTrapAuthenticityPatchHash) {
    throw "Unexpected Prism Audio noise-trap authenticity patch hash: $prismAudioNoiseTrapAuthenticityPatchHash"
}
if ($prismWindowsTaskbarBadgeReadinessPatchHash -ne $expectedPrismWindowsTaskbarBadgeReadinessPatchHash) {
    throw "Unexpected Prism Windows taskbar badge readiness patch hash: $prismWindowsTaskbarBadgeReadinessPatchHash"
}
$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
Copy-Item -Path $PrismScreenPatchPath -Destination (Join-Path $fingerprintPatchDirectory "004-screen-size.patch") -Force
Copy-Item -Path $PrismScreenConsistencyPatchPath -Destination (Join-Path $fingerprintPatchDirectory "005-screen-consistency.patch") -Force
Copy-Item -Path $PrismGeolocationPatchPath -Destination (Join-Path $fingerprintPatchDirectory "019-proxy-geolocation.patch") -Force
Copy-Item -Path $PrismRenderIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "020-render-identity-v1.patch") -Force
Copy-Item -Path $PrismConservativeRenderIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "021-conservative-render-identity-v2.patch") -Force
Copy-Item -Path $PrismProfileWindowIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "022-profile-window-identity.patch") -Force
Copy-Item -Path $PrismCoherentRenderIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "023-coherent-render-identity-v3.patch") -Force
Copy-Item -Path $PrismDomRectSeedMixingPatchPath -Destination (Join-Path $fingerprintPatchDirectory "024-domrect-seed-mixing.patch") -Force
Copy-Item -Path $PrismNativeSurfaceConsistencyPatchPath -Destination (Join-Path $fingerprintPatchDirectory "025-native-surface-consistency.patch") -Force
Copy-Item -Path $PrismCanvasSeedDispersionPatchPath -Destination (Join-Path $fingerprintPatchDirectory "026-canvas-seed-dispersion.patch") -Force
Copy-Item -Path $PrismDirectDomRectIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "027-direct-domrect-identity.patch") -Force
Copy-Item -Path $PrismDirectDomRectConsumptionPatchPath -Destination (Join-Path $fingerprintPatchDirectory "028-direct-domrect-consumption.patch") -Force
Copy-Item -Path $PrismNativeLocaleSurfacesV4PatchPath -Destination (Join-Path $fingerprintPatchDirectory "029-native-locale-surfaces-v4.patch") -Force
Copy-Item -Path $PrismWindowsNativeTtsVoicesPatchPath -Destination (Join-Path $fingerprintPatchDirectory "030-windows-native-tts-voices.patch") -Force
Copy-Item -Path $PrismWindowsTtsRuntimePatchPath -Destination (Join-Path $fingerprintPatchDirectory "031-windows-tts-runtime.patch") -Force
Copy-Item -Path $PrismWebGpuTemplateIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "032-webgpu-template-identity.patch") -Force
Copy-Item -Path $PrismWebGlSnapshotSpeechCoherencePatchPath -Destination (Join-Path $fingerprintPatchDirectory "033-webgl-snapshot-speech-coherence.patch") -Force
Copy-Item -Path $PrismCanvasSerializationIdentityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "034-canvas-serialization-identity.patch") -Force
Copy-Item -Path $PrismLocaleSpeechCatalogPatchPath -Destination (Join-Path $fingerprintPatchDirectory "035-locale-speech-catalog.patch") -Force
Copy-Item -Path $PrismCoherentCanvasReadbackPatchPath -Destination (Join-Path $fingerprintPatchDirectory "036-coherent-canvas-readback.patch") -Force
Copy-Item -Path $PrismCanvasSeedSlotDispersionPatchPath -Destination (Join-Path $fingerprintPatchDirectory "037-canvas-seed-slot-dispersion.patch") -Force
Copy-Item -Path $PrismWebGlCalibrationAuthenticityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "038-webgl-calibration-authenticity.patch") -Force
Copy-Item -Path $PrismNativeFontInventoryAuthenticityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "039-native-font-inventory-authenticity.patch") -Force
Copy-Item -Path $PrismDomRectCalibrationAuthenticityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "040-domrect-calibration-authenticity.patch") -Force
Copy-Item -Path $PrismMacOsIntlLocalePatchPath -Destination (Join-Path $fingerprintPatchDirectory "041-macos-intl-locale.patch") -Force
Copy-Item -Path $PrismNativeCanvasAudioCalibrationPatchPath -Destination (Join-Path $fingerprintPatchDirectory "042-native-canvas-audio-calibration.patch") -Force
Copy-Item -Path $PrismAudioNoiseTrapAuthenticityPatchPath -Destination (Join-Path $fingerprintPatchDirectory "043-audio-noise-trap-authenticity.patch") -Force
Copy-Item -Path $PrismWindowsTaskbarBadgeReadinessPatchPath -Destination (Join-Path $fingerprintPatchDirectory "044-windows-taskbar-badge-readiness.patch") -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

& git.exe -C $RepositoryPath config submodule.ungoogled-chromium.url $FingerprintRepository
if ($LASTEXITCODE -ne 0) {
    throw "Could not record the fingerprint submodule URL."
}

$lock = [ordered]@{
    schemaVersion = 5
    contractSchemaVersion = $KernelLock.schemaVersion
    contractSha256 = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
    chromiumVersion = $chromiumVersion
    target = "windows-x64"
    platformRepository = $PlatformRepository
    platformTag = $PlatformTag
    platformCommit = $PlatformCommit
    fingerprintRepository = $FingerprintRepository
    fingerprintTag = $FingerprintTag
    fingerprintCommit = $FingerprintCommit
    prismScreenPatchSha256 = $prismScreenPatchHash
    prismScreenConsistencyPatchSha256 = $prismScreenConsistencyPatchHash
    prismGeolocationPatchSha256 = $prismGeolocationPatchHash
    prismRenderIdentityPatchSha256 = $prismRenderIdentityPatchHash
    prismConservativeRenderIdentityPatchSha256 = $prismConservativeRenderIdentityPatchHash
    prismProfileWindowIdentityPatchSha256 = $prismProfileWindowIdentityPatchHash
    prismCoherentRenderIdentityPatchSha256 = $prismCoherentRenderIdentityPatchHash
    prismDomRectSeedMixingPatchSha256 = $prismDomRectSeedMixingPatchHash
    prismNativeSurfaceConsistencyPatchSha256 = $prismNativeSurfaceConsistencyPatchHash
    prismCanvasSeedDispersionPatchSha256 = $prismCanvasSeedDispersionPatchHash
    prismDirectDomRectIdentityPatchSha256 = $prismDirectDomRectIdentityPatchHash
    prismDirectDomRectConsumptionPatchSha256 = $prismDirectDomRectConsumptionPatchHash
    prismNativeLocaleSurfacesV4PatchSha256 = $prismNativeLocaleSurfacesV4PatchHash
    prismWindowsNativeTtsVoicesPatchSha256 = $prismWindowsNativeTtsVoicesPatchHash
    prismWindowsTtsRuntimePatchSha256 = $prismWindowsTtsRuntimePatchHash
    prismWebGpuTemplateIdentityPatchSha256 = $prismWebGpuTemplateIdentityPatchHash
    prismWebGlSnapshotSpeechCoherencePatchSha256 = $prismWebGlSnapshotSpeechCoherencePatchHash
    prismCanvasSerializationIdentityPatchSha256 = $prismCanvasSerializationIdentityPatchHash
    prismLocaleSpeechCatalogPatchSha256 = $prismLocaleSpeechCatalogPatchHash
    prismCoherentCanvasReadbackPatchSha256 = $prismCoherentCanvasReadbackPatchHash
    prismCanvasSeedSlotDispersionPatchSha256 = $prismCanvasSeedSlotDispersionPatchHash
    prismWebGlCalibrationAuthenticityPatchSha256 = $prismWebGlCalibrationAuthenticityPatchHash
    prismNativeFontInventoryAuthenticityPatchSha256 = $prismNativeFontInventoryAuthenticityPatchHash
    prismDomRectCalibrationAuthenticityPatchSha256 = $prismDomRectCalibrationAuthenticityPatchHash
    prismAudioNoiseTrapAuthenticityPatchSha256 = $prismAudioNoiseTrapAuthenticityPatchHash
    prismWindowsTaskbarBadgeReadinessPatchSha256 = $prismWindowsTaskbarBadgeReadinessPatchHash
    preparedAtUtc = [DateTime]::UtcNow.ToString("o")
}
$lock | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $RepositoryPath "prism-build-lock.json") -Encoding utf8

$tmpPath = Join-Path $BuildRoot "tmp"
New-Item -ItemType Directory -Path $tmpPath -Force | Out-Null

Write-Host ""
Write-Host "Pinned source is ready:" -ForegroundColor Green
Write-Host "  $RepositoryPath"
Write-Host ""
Write-Host "Next command:"
Write-Host ".\Build-Kernel.ps1 -BuildRoot `"$BuildRoot`" -Jobs 4"
