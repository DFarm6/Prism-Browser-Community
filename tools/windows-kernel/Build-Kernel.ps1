[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium",

    [Parameter()]
    [ValidateRange(1, 64)]
    [int]$Jobs = 4
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PlatformContract = $KernelLock.platforms.'windows-x64'
$ChromiumVersion = $KernelLock.chromiumVersion
$ExpectedPlatformCommit = $PlatformContract.commit
$ExpectedFingerprintCommit = $KernelLock.fingerprint.commit
$ExpectedPrismScreenPatchHash = (Get-PrismKernelPatch $KernelLock "004-screen-size.patch").sha256
$ExpectedPrismScreenConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "005-screen-consistency.patch").sha256
$ExpectedPrismGeolocationPatchHash = (Get-PrismKernelPatch $KernelLock "019-proxy-geolocation.patch").sha256
$ExpectedPrismRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "020-render-identity-v1.patch").sha256
$ExpectedPrismConservativeRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "021-conservative-render-identity-v2.patch").sha256
$ExpectedPrismProfileWindowIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "022-profile-window-identity.patch").sha256
$ExpectedPrismCoherentRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "023-coherent-render-identity-v3.patch").sha256
$ExpectedPrismDomRectSeedMixingPatchHash = (Get-PrismKernelPatch $KernelLock "024-domrect-seed-mixing.patch").sha256
$ExpectedPrismNativeSurfaceConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "025-native-surface-consistency.patch").sha256
$ExpectedPrismCanvasSeedDispersionPatchHash = (Get-PrismKernelPatch $KernelLock "026-canvas-seed-dispersion.patch").sha256
$ExpectedPrismDirectDomRectIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "027-direct-domrect-identity.patch").sha256
$ExpectedPrismDirectDomRectConsumptionPatchHash = (Get-PrismKernelPatch $KernelLock "028-direct-domrect-consumption.patch").sha256
$ExpectedPrismNativeLocaleSurfacesV4PatchHash = (Get-PrismKernelPatch $KernelLock "029-native-locale-surfaces-v4.patch").sha256
$ExpectedPrismWindowsNativeTtsVoicesPatchHash = (Get-PrismKernelPatch $KernelLock "030-windows-native-tts-voices.patch").sha256
$ExpectedPrismWindowsTtsRuntimePatchHash = (Get-PrismKernelPatch $KernelLock "031-windows-tts-runtime.patch").sha256
$ExpectedPrismWebGpuTemplateIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "032-webgpu-template-identity.patch").sha256
$ExpectedPrismWebGlSnapshotSpeechCoherencePatchHash = (Get-PrismKernelPatch $KernelLock "033-webgl-snapshot-speech-coherence.patch").sha256
$ExpectedPrismCanvasSerializationIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "034-canvas-serialization-identity.patch").sha256
$ExpectedPrismLocaleSpeechCatalogPatchHash = (Get-PrismKernelPatch $KernelLock "035-locale-speech-catalog.patch").sha256
$ExpectedPrismCoherentCanvasReadbackPatchHash = (Get-PrismKernelPatch $KernelLock "036-coherent-canvas-readback.patch").sha256
$ExpectedPrismCanvasSeedSlotDispersionPatchHash = (Get-PrismKernelPatch $KernelLock "037-canvas-seed-slot-dispersion.patch").sha256
$ExpectedPrismWebGlCalibrationAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "038-webgl-calibration-authenticity.patch").sha256
$ExpectedPrismNativeFontInventoryAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "039-native-font-inventory-authenticity.patch").sha256
$ExpectedPrismDomRectCalibrationAuthenticityPatchHash = (Get-PrismKernelPatch $KernelLock "040-domrect-calibration-authenticity.patch").sha256
$ExpectedPrismWindowsTaskbarBadgeReadinessPatchHash = (Get-PrismKernelPatch $KernelLock "044-windows-taskbar-badge-readiness.patch").sha256
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$OutputPath = Join-Path $SourcePath "out\Default"
$BuildNinja = Join-Path $OutputPath "build.ninja"
$LogDirectory = Join-Path $BuildRoot "logs"
$ArtifactDirectory = Join-Path $BuildRoot "artifacts\$ChromiumVersion-windows-x64"
$TmpPath = Join-Path $BuildRoot "tmp"

if ($null -eq ("PrismPowerState" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PrismPowerState {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
"@
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Get-PythonExecutable {
    foreach ($candidate in @("python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $command -and $command.CommandType -eq "Application") {
            return $command.Source
        }
    }
    throw "Python 3.11 or newer was not found."
}

function Enable-Python3Shim {
    param([string]$PythonExecutable)
    $shimRoot = Join-Path $BuildRoot "python-shim"
    New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null
    $shimPath = Join-Path $shimRoot "python3.cmd"
    "@`"$PythonExecutable`" %*" | Set-Content -LiteralPath $shimPath -Encoding ascii
    $env:PATH = "$shimRoot;$env:PATH"
    & python3.cmd -c "import sys; print(sys.executable)"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the python3 compatibility shim required by gclient.bat."
    }
}

function Assert-CleanPythonEnvironment {
    param([string]$PythonExecutable)
    $environmentKind = (& $PythonExecutable -c "import os,sys; print('clean' if sys.prefix != sys.base_prefix and not os.environ.get('CONDA_PREFIX') else 'shared')") -join ""
    if ($LASTEXITCODE -ne 0 -or $environmentKind -ne "clean") {
        throw "Activate a clean Python venv before building (for example C:\prism-venv). Anaconda and global environments can shadow Chromium build.py."
    }
}

function Enable-Vs2026SourceCompatibility {
    $setenvPath = Join-Path $SourcePath "tools\win\setenv.py"
    if (Test-Path $setenvPath) {
        $setenv = [System.IO.File]::ReadAllText($setenvPath)
        if ($setenv -notmatch "2026") {
            $updatedSetenv = $setenv.Replace("['2022']", "['2026', '2022']")
            if ($updatedSetenv -eq $setenv) {
                throw "Could not extend tools\win\setenv.py for Visual Studio 2026."
            }
            [System.IO.File]::WriteAllText(
                $setenvPath,
                $updatedSetenv,
                (New-Object System.Text.UTF8Encoding($false))
            )
        }
    }

    $buildDriverPath = Join-Path $RepositoryPath "build.py"
    $buildDriver = [System.IO.File]::ReadAllText($buildDriverPath)
    $marker = "# PRISM_VS2026_SETENV_COMPAT"
    if ($buildDriver -notmatch [regex]::Escape($marker)) {
        $cloneLine = "        subprocess.run([sys.executable, str(Path('ungoogled-chromium', 'utils', 'clone.py')), '-o', 'build\\src', '-p', 'win32' if args.x86 else 'win-arm64' if args.arm else 'win64'], check=True)"
        $injection = @"
$cloneLine
        $marker
        setenv_path = source_tree / 'tools' / 'win' / 'setenv.py'
        setenv_text = setenv_path.read_text(encoding='utf-8')
        if '2026' not in setenv_text:
            updated_setenv = setenv_text.replace("['2022']", "['2026', '2022']")
            if updated_setenv == setenv_text:
                raise RuntimeError('Could not extend tools/win/setenv.py for Visual Studio 2026')
            setenv_path.write_text(updated_setenv, encoding='utf-8')
"@
        if (-not $buildDriver.Contains($cloneLine)) {
            throw "Pinned build.py no longer contains the expected Chromium clone command."
        }
        $buildDriver = $buildDriver.Replace($cloneLine, $injection.TrimEnd())
        [System.IO.File]::WriteAllText(
            $buildDriverPath,
            $buildDriver,
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
}

function Write-BuildState {
    param(
        [string]$Status,
        [string]$Message,
        [string]$StatePath,
        [string]$StartedAtUtc,
        [string]$BuildLog
    )
    $state = [ordered]@{
        schemaVersion = 1
        status = $Status
        message = $Message
        startedAtUtc = $StartedAtUtc
        updatedAtUtc = [DateTime]::UtcNow.ToString("o")
        log = $BuildLog
        artifacts = $ArtifactDirectory
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding utf8
}

function Assert-PinnedSource {
    $lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
    if (-not (Test-Path $lockPath)) {
        throw "Pinned source is not prepared. Run Prepare-Source.ps1 first."
    }

    $platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
    $fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
    if ($platformCommit -ne $ExpectedPlatformCommit) {
        throw "Unexpected Windows platform commit: $platformCommit"
    }
    if ($fingerprintCommit -ne $ExpectedFingerprintCommit) {
        throw "Unexpected fingerprint commit: $fingerprintCommit"
    }
    Assert-PrismKernelPatchSeries $KernelLock (Join-Path $FingerprintPath "patches\series")
    $prismScreenPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\004-screen-size.patch"
    $prismScreenConsistencyPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\005-screen-consistency.patch"
    $prismGeolocationPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\019-proxy-geolocation.patch"
    $prismRenderIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\020-render-identity-v1.patch"
    $prismConservativeRenderIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\021-conservative-render-identity-v2.patch"
    $prismProfileWindowIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\022-profile-window-identity.patch"
    $prismCoherentRenderIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\023-coherent-render-identity-v3.patch"
    $prismDomRectSeedMixingPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\024-domrect-seed-mixing.patch"
    $prismNativeSurfaceConsistencyPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\025-native-surface-consistency.patch"
    $prismCanvasSeedDispersionPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\026-canvas-seed-dispersion.patch"
    $prismDirectDomRectIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\027-direct-domrect-identity.patch"
    $prismDirectDomRectConsumptionPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\028-direct-domrect-consumption.patch"
    $prismNativeLocaleSurfacesV4Patch = Join-Path $FingerprintPath "patches\extra\fingerprint\029-native-locale-surfaces-v4.patch"
    $prismWindowsNativeTtsVoicesPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\030-windows-native-tts-voices.patch"
    $prismWindowsTtsRuntimePatch = Join-Path $FingerprintPath "patches\extra\fingerprint\031-windows-tts-runtime.patch"
    $prismWebGpuTemplateIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\032-webgpu-template-identity.patch"
    $prismWebGlSnapshotSpeechCoherencePatch = Join-Path $FingerprintPath "patches\extra\fingerprint\033-webgl-snapshot-speech-coherence.patch"
    $prismCanvasSerializationIdentityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\034-canvas-serialization-identity.patch"
    $prismLocaleSpeechCatalogPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\035-locale-speech-catalog.patch"
    $prismCoherentCanvasReadbackPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\036-coherent-canvas-readback.patch"
    $prismCanvasSeedSlotDispersionPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\037-canvas-seed-slot-dispersion.patch"
    $prismWebGlCalibrationAuthenticityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\038-webgl-calibration-authenticity.patch"
    $prismNativeFontInventoryAuthenticityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\039-native-font-inventory-authenticity.patch"
    $prismDomRectCalibrationAuthenticityPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\040-domrect-calibration-authenticity.patch"
    $prismWindowsTaskbarBadgeReadinessPatch = Join-Path $FingerprintPath "patches\extra\fingerprint\044-windows-taskbar-badge-readiness.patch"
    if (-not (Test-Path $prismScreenPatch)) {
        throw "Prism screen patch is missing. Run Prepare-Source.ps1 or Update-Screen-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismGeolocationPatch)) {
        throw "Prism proxy geolocation patch is missing. Run Update-Network-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismScreenConsistencyPatch)) {
        throw "Prism screen consistency patch is missing. Run Update-Screen-Consistency-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismRenderIdentityPatch)) {
        throw "Prism render identity patch is missing. Run Update-Render-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismConservativeRenderIdentityPatch)) {
        throw "Prism conservative render identity patch is missing. Run Update-Conservative-Render-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismProfileWindowIdentityPatch)) {
        throw "Prism profile window identity patch is missing. Run Update-Window-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismCoherentRenderIdentityPatch)) {
        throw "Prism coherent render identity v3 patch is missing. Run Update-Coherent-Render-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismDomRectSeedMixingPatch)) {
        throw "Prism DOMRect seed mixing patch is missing. Run Update-DOMRect-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismNativeSurfaceConsistencyPatch)) {
        throw "Prism native surface consistency patch is missing. Run Update-Native-Surface-Consistency-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismCanvasSeedDispersionPatch)) {
        throw "Prism Canvas seed dispersion patch is missing. Run Update-Canvas-Seed-Dispersion-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismDirectDomRectIdentityPatch)) {
        throw "Prism direct DOMRect identity patch is missing. Run Update-Direct-DOMRect-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismDirectDomRectConsumptionPatch)) {
        throw "Prism direct DOMRect consumption patch is missing. Run Update-Direct-DOMRect-Consumption-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismNativeLocaleSurfacesV4Patch)) {
        throw "Prism native locale surfaces v4 patch is missing. Run Update-Native-Locale-Surfaces-V4-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismWindowsNativeTtsVoicesPatch)) {
        throw "Prism Windows native TTS voices patch is missing. Run Update-Windows-Native-TTS-Voices-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismWindowsTtsRuntimePatch)) {
        throw "Prism Windows TTS runtime patch is missing. Run Update-Windows-TTS-Runtime-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismWebGpuTemplateIdentityPatch)) {
        throw "Prism WebGPU template identity patch is missing. Run Update-WebGPU-Template-Identity-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismWebGlSnapshotSpeechCoherencePatch)) {
        throw "Prism WebGL snapshot and speech coherence patch is missing. Run Update-WebGL-Snapshot-Speech-Coherence-Patch.ps1 from the latest build kit."
    }
    if (-not (Test-Path $prismCanvasSerializationIdentityPatch) -or
        -not (Test-Path $prismLocaleSpeechCatalogPatch)) {
        throw "Prism Canvas/Speech final patches are missing. Run Update-Canvas-Speech-Identity-Patches.ps1 first."
    }
    if (-not (Test-Path $prismCoherentCanvasReadbackPatch)) {
        throw "Prism coherent Canvas readback patch is missing. Run Update-Coherent-Canvas-Readback-Patch.ps1 first."
    }
    if (-not (Test-Path $prismCanvasSeedSlotDispersionPatch)) {
        throw "Prism Canvas seed slot dispersion patch is missing. Run Update-Canvas-Seed-Slot-Dispersion-Patch.ps1 first."
    }
    if (-not (Test-Path $prismWebGlCalibrationAuthenticityPatch)) {
        throw "Prism WebGL calibration authenticity patch is missing. Run Update-WebGL-Calibration-Authenticity-Patch.ps1 first."
    }
    if (-not (Test-Path $prismNativeFontInventoryAuthenticityPatch)) {
        throw "Prism native font inventory authenticity patch is missing. Run Update-Native-Font-Inventory-Authenticity-Patch.ps1 first."
    }
    if (-not (Test-Path $prismDomRectCalibrationAuthenticityPatch)) {
        throw "Prism DOMRect calibration authenticity patch is missing. Run Update-DOMRect-Calibration-Authenticity-Patch.ps1 first."
    }
    if (-not (Test-Path $prismWindowsTaskbarBadgeReadinessPatch)) {
        throw "Prism Windows taskbar badge readiness patch is missing. Run Update-Windows-Taskbar-Badge-Readiness-Patch.ps1 first."
    }
    $prismScreenPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismScreenPatch).Hash.ToLowerInvariant()
    $prismScreenConsistencyPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismScreenConsistencyPatch).Hash.ToLowerInvariant()
    $prismGeolocationPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismGeolocationPatch).Hash.ToLowerInvariant()
    $prismRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismRenderIdentityPatch).Hash.ToLowerInvariant()
    $prismConservativeRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismConservativeRenderIdentityPatch).Hash.ToLowerInvariant()
    $prismProfileWindowIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismProfileWindowIdentityPatch).Hash.ToLowerInvariant()
    $prismCoherentRenderIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismCoherentRenderIdentityPatch).Hash.ToLowerInvariant()
    $prismDomRectSeedMixingPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismDomRectSeedMixingPatch).Hash.ToLowerInvariant()
    $prismNativeSurfaceConsistencyPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismNativeSurfaceConsistencyPatch).Hash.ToLowerInvariant()
    $prismCanvasSeedDispersionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismCanvasSeedDispersionPatch).Hash.ToLowerInvariant()
    $prismDirectDomRectIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismDirectDomRectIdentityPatch).Hash.ToLowerInvariant()
    $prismDirectDomRectConsumptionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismDirectDomRectConsumptionPatch).Hash.ToLowerInvariant()
    $prismNativeLocaleSurfacesV4PatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismNativeLocaleSurfacesV4Patch).Hash.ToLowerInvariant()
    $prismWindowsNativeTtsVoicesPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWindowsNativeTtsVoicesPatch).Hash.ToLowerInvariant()
    $prismWindowsTtsRuntimePatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWindowsTtsRuntimePatch).Hash.ToLowerInvariant()
    $prismWebGpuTemplateIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWebGpuTemplateIdentityPatch).Hash.ToLowerInvariant()
    $prismWebGlSnapshotSpeechCoherencePatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWebGlSnapshotSpeechCoherencePatch).Hash.ToLowerInvariant()
    $prismCanvasSerializationIdentityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismCanvasSerializationIdentityPatch).Hash.ToLowerInvariant()
    $prismLocaleSpeechCatalogPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismLocaleSpeechCatalogPatch).Hash.ToLowerInvariant()
    $prismCoherentCanvasReadbackPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismCoherentCanvasReadbackPatch).Hash.ToLowerInvariant()
    $prismCanvasSeedSlotDispersionPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismCanvasSeedSlotDispersionPatch).Hash.ToLowerInvariant()
    $prismWebGlCalibrationAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWebGlCalibrationAuthenticityPatch).Hash.ToLowerInvariant()
    $prismNativeFontInventoryAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismNativeFontInventoryAuthenticityPatch).Hash.ToLowerInvariant()
    $prismDomRectCalibrationAuthenticityPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismDomRectCalibrationAuthenticityPatch).Hash.ToLowerInvariant()
    $prismWindowsTaskbarBadgeReadinessPatchHash = (Get-FileHash -Algorithm SHA256 -Path $prismWindowsTaskbarBadgeReadinessPatch).Hash.ToLowerInvariant()
    if ($prismScreenPatchHash -ne $ExpectedPrismScreenPatchHash) {
        throw "Unexpected Prism screen patch hash: $prismScreenPatchHash"
    }
    if ($prismGeolocationPatchHash -ne $ExpectedPrismGeolocationPatchHash) {
        throw "Unexpected Prism proxy geolocation patch hash: $prismGeolocationPatchHash"
    }
    if ($prismScreenConsistencyPatchHash -ne $ExpectedPrismScreenConsistencyPatchHash) {
        throw "Unexpected Prism screen consistency patch hash: $prismScreenConsistencyPatchHash"
    }
    if ($prismRenderIdentityPatchHash -ne $ExpectedPrismRenderIdentityPatchHash) {
        throw "Unexpected Prism render identity patch hash: $prismRenderIdentityPatchHash"
    }
    if ($prismConservativeRenderIdentityPatchHash -ne $ExpectedPrismConservativeRenderIdentityPatchHash) {
        throw "Unexpected Prism conservative render identity patch hash: $prismConservativeRenderIdentityPatchHash"
    }
    if ($prismProfileWindowIdentityPatchHash -ne $ExpectedPrismProfileWindowIdentityPatchHash) {
        throw "Unexpected Prism profile window identity patch hash: $prismProfileWindowIdentityPatchHash"
    }
    if ($prismCoherentRenderIdentityPatchHash -ne $ExpectedPrismCoherentRenderIdentityPatchHash) {
        throw "Unexpected Prism coherent render identity v3 patch hash: $prismCoherentRenderIdentityPatchHash"
    }
    if ($prismDomRectSeedMixingPatchHash -ne $ExpectedPrismDomRectSeedMixingPatchHash) {
        throw "Unexpected Prism DOMRect seed mixing patch hash: $prismDomRectSeedMixingPatchHash"
    }
    if ($prismNativeSurfaceConsistencyPatchHash -ne $ExpectedPrismNativeSurfaceConsistencyPatchHash) {
        throw "Unexpected Prism native surface consistency patch hash: $prismNativeSurfaceConsistencyPatchHash"
    }
    if ($prismCanvasSeedDispersionPatchHash -ne $ExpectedPrismCanvasSeedDispersionPatchHash) {
        throw "Unexpected Prism Canvas seed dispersion patch hash: $prismCanvasSeedDispersionPatchHash"
    }
    if ($prismDirectDomRectIdentityPatchHash -ne $ExpectedPrismDirectDomRectIdentityPatchHash) {
        throw "Unexpected Prism direct DOMRect identity patch hash: $prismDirectDomRectIdentityPatchHash"
    }
    if ($prismDirectDomRectConsumptionPatchHash -ne $ExpectedPrismDirectDomRectConsumptionPatchHash) {
        throw "Unexpected Prism direct DOMRect consumption patch hash: $prismDirectDomRectConsumptionPatchHash"
    }
    if ($prismNativeLocaleSurfacesV4PatchHash -ne $ExpectedPrismNativeLocaleSurfacesV4PatchHash) {
        throw "Unexpected Prism native locale surfaces v4 patch hash: $prismNativeLocaleSurfacesV4PatchHash"
    }
    if ($prismWindowsNativeTtsVoicesPatchHash -ne $ExpectedPrismWindowsNativeTtsVoicesPatchHash) {
        throw "Unexpected Prism Windows native TTS voices patch hash: $prismWindowsNativeTtsVoicesPatchHash"
    }
    if ($prismWindowsTtsRuntimePatchHash -ne $ExpectedPrismWindowsTtsRuntimePatchHash) {
        throw "Unexpected Prism Windows TTS runtime patch hash: $prismWindowsTtsRuntimePatchHash"
    }
    if ($prismWebGpuTemplateIdentityPatchHash -ne $ExpectedPrismWebGpuTemplateIdentityPatchHash) {
        throw "Unexpected Prism WebGPU template identity patch hash: $prismWebGpuTemplateIdentityPatchHash"
    }
    if ($prismWebGlSnapshotSpeechCoherencePatchHash -ne $ExpectedPrismWebGlSnapshotSpeechCoherencePatchHash) {
        throw "Unexpected Prism WebGL snapshot and speech coherence patch hash: $prismWebGlSnapshotSpeechCoherencePatchHash"
    }
    if ($prismCanvasSerializationIdentityPatchHash -ne $ExpectedPrismCanvasSerializationIdentityPatchHash -or
        $prismLocaleSpeechCatalogPatchHash -ne $ExpectedPrismLocaleSpeechCatalogPatchHash) {
        throw "Unexpected Prism Canvas/Speech final patch hash."
    }
    if ($prismCoherentCanvasReadbackPatchHash -ne $ExpectedPrismCoherentCanvasReadbackPatchHash) {
        throw "Unexpected Prism coherent Canvas readback patch hash: $prismCoherentCanvasReadbackPatchHash"
    }
    if ($prismCanvasSeedSlotDispersionPatchHash -ne $ExpectedPrismCanvasSeedSlotDispersionPatchHash) {
        throw "Unexpected Prism Canvas seed slot dispersion patch hash: $prismCanvasSeedSlotDispersionPatchHash"
    }
    if ($prismWebGlCalibrationAuthenticityPatchHash -ne $ExpectedPrismWebGlCalibrationAuthenticityPatchHash) {
        throw "Unexpected Prism WebGL calibration authenticity patch hash: $prismWebGlCalibrationAuthenticityPatchHash"
    }
    if ($prismNativeFontInventoryAuthenticityPatchHash -ne $ExpectedPrismNativeFontInventoryAuthenticityPatchHash) {
        throw "Unexpected Prism native font inventory authenticity patch hash: $prismNativeFontInventoryAuthenticityPatchHash"
    }
    if ($prismDomRectCalibrationAuthenticityPatchHash -ne $ExpectedPrismDomRectCalibrationAuthenticityPatchHash) {
        throw "Unexpected Prism DOMRect calibration authenticity patch hash: $prismDomRectCalibrationAuthenticityPatchHash"
    }
    if ($prismWindowsTaskbarBadgeReadinessPatchHash -ne $ExpectedPrismWindowsTaskbarBadgeReadinessPatchHash) {
        throw "Unexpected Prism Windows taskbar badge readiness patch hash: $prismWindowsTaskbarBadgeReadinessPatchHash"
    }
    $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
    if (-not ($lock.PSObject.Properties.Name -contains "contractSha256") -or
        $lock.contractSha256 -ne $ExpectedContractHash) {
        throw "The prepared source uses a different kernel-lock.json. Run Prepare-Source.ps1 from this kit."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismGeolocationPatchSha256") -or
        $lock.prismGeolocationPatchSha256 -ne $ExpectedPrismGeolocationPatchHash) {
        throw "The build lock predates the proxy geolocation patch. Run Update-Network-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismScreenConsistencyPatchSha256") -or
        $lock.prismScreenConsistencyPatchSha256 -ne $ExpectedPrismScreenConsistencyPatchHash) {
        throw "The build lock predates the screen consistency patch. Run Update-Screen-Consistency-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismRenderIdentityPatchSha256") -or
        $lock.prismRenderIdentityPatchSha256 -ne $ExpectedPrismRenderIdentityPatchHash) {
        throw "The build lock predates the render identity patch. Run Update-Render-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismConservativeRenderIdentityPatchSha256") -or
        $lock.prismConservativeRenderIdentityPatchSha256 -ne $ExpectedPrismConservativeRenderIdentityPatchHash) {
        throw "The build lock predates conservative render identity v2. Run Update-Conservative-Render-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismProfileWindowIdentityPatchSha256") -or
        $lock.prismProfileWindowIdentityPatchSha256 -ne $ExpectedPrismProfileWindowIdentityPatchHash) {
        throw "The build lock predates profile window identity. Run Update-Window-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismCoherentRenderIdentityPatchSha256") -or
        $lock.prismCoherentRenderIdentityPatchSha256 -ne $ExpectedPrismCoherentRenderIdentityPatchHash) {
        throw "The build lock predates coherent render identity v3. Run Update-Coherent-Render-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismDomRectSeedMixingPatchSha256") -or
        $lock.prismDomRectSeedMixingPatchSha256 -ne $ExpectedPrismDomRectSeedMixingPatchHash) {
        throw "The build lock predates DOMRect seed mixing. Run Update-DOMRect-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismNativeSurfaceConsistencyPatchSha256") -or
        $lock.prismNativeSurfaceConsistencyPatchSha256 -ne $ExpectedPrismNativeSurfaceConsistencyPatchHash) {
        throw "The build lock predates native surface consistency. Run Update-Native-Surface-Consistency-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismCanvasSeedDispersionPatchSha256") -or
        $lock.prismCanvasSeedDispersionPatchSha256 -ne $ExpectedPrismCanvasSeedDispersionPatchHash) {
        throw "The build lock predates Canvas seed dispersion. Run Update-Canvas-Seed-Dispersion-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismDirectDomRectIdentityPatchSha256") -or
        $lock.prismDirectDomRectIdentityPatchSha256 -ne $ExpectedPrismDirectDomRectIdentityPatchHash) {
        throw "The build lock predates direct DOMRect identity. Run Update-Direct-DOMRect-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismDirectDomRectConsumptionPatchSha256") -or
        $lock.prismDirectDomRectConsumptionPatchSha256 -ne $ExpectedPrismDirectDomRectConsumptionPatchHash) {
        throw "The build lock predates direct DOMRect consumption. Run Update-Direct-DOMRect-Consumption-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismNativeLocaleSurfacesV4PatchSha256") -or
        $lock.prismNativeLocaleSurfacesV4PatchSha256 -ne $ExpectedPrismNativeLocaleSurfacesV4PatchHash) {
        throw "The build lock predates native locale surfaces v4. Run Update-Native-Locale-Surfaces-V4-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWindowsNativeTtsVoicesPatchSha256") -or
        $lock.prismWindowsNativeTtsVoicesPatchSha256 -ne $ExpectedPrismWindowsNativeTtsVoicesPatchHash) {
        throw "The build lock predates Windows native TTS voices. Run Update-Windows-Native-TTS-Voices-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWindowsTtsRuntimePatchSha256") -or
        $lock.prismWindowsTtsRuntimePatchSha256 -ne $ExpectedPrismWindowsTtsRuntimePatchHash) {
        throw "The build lock predates the Windows TTS runtime patch. Run Update-Windows-TTS-Runtime-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWebGpuTemplateIdentityPatchSha256") -or
        $lock.prismWebGpuTemplateIdentityPatchSha256 -ne $ExpectedPrismWebGpuTemplateIdentityPatchHash) {
        throw "The build lock predates WebGPU template identity. Run Update-WebGPU-Template-Identity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWebGlSnapshotSpeechCoherencePatchSha256") -or
        $lock.prismWebGlSnapshotSpeechCoherencePatchSha256 -ne $ExpectedPrismWebGlSnapshotSpeechCoherencePatchHash) {
        throw "The build lock predates WebGL snapshot and speech coherence. Run Update-WebGL-Snapshot-Speech-Coherence-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismCanvasSerializationIdentityPatchSha256") -or
        $lock.prismCanvasSerializationIdentityPatchSha256 -ne $ExpectedPrismCanvasSerializationIdentityPatchHash -or
        -not ($lock.PSObject.Properties.Name -contains "prismLocaleSpeechCatalogPatchSha256") -or
        $lock.prismLocaleSpeechCatalogPatchSha256 -ne $ExpectedPrismLocaleSpeechCatalogPatchHash) {
        throw "The build lock predates the final Canvas/Speech identity patches. Run Update-Canvas-Speech-Identity-Patches.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismCoherentCanvasReadbackPatchSha256") -or
        $lock.prismCoherentCanvasReadbackPatchSha256 -ne $ExpectedPrismCoherentCanvasReadbackPatchHash) {
        throw "The build lock predates coherent Canvas readback. Run Update-Coherent-Canvas-Readback-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismCanvasSeedSlotDispersionPatchSha256") -or
        $lock.prismCanvasSeedSlotDispersionPatchSha256 -ne $ExpectedPrismCanvasSeedSlotDispersionPatchHash) {
        throw "The build lock predates Canvas seed slot dispersion. Run Update-Canvas-Seed-Slot-Dispersion-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWebGlCalibrationAuthenticityPatchSha256") -or
        $lock.prismWebGlCalibrationAuthenticityPatchSha256 -ne $ExpectedPrismWebGlCalibrationAuthenticityPatchHash) {
        throw "The build lock predates WebGL calibration authenticity. Run Update-WebGL-Calibration-Authenticity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismNativeFontInventoryAuthenticityPatchSha256") -or
        $lock.prismNativeFontInventoryAuthenticityPatchSha256 -ne $ExpectedPrismNativeFontInventoryAuthenticityPatchHash) {
        throw "The build lock predates native font inventory authenticity. Run Update-Native-Font-Inventory-Authenticity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismDomRectCalibrationAuthenticityPatchSha256") -or
        $lock.prismDomRectCalibrationAuthenticityPatchSha256 -ne $ExpectedPrismDomRectCalibrationAuthenticityPatchHash) {
        throw "The build lock predates DOMRect calibration authenticity. Run Update-DOMRect-Calibration-Authenticity-Patch.ps1 first."
    }
    if (-not ($lock.PSObject.Properties.Name -contains "prismWindowsTaskbarBadgeReadinessPatchSha256") -or
        $lock.prismWindowsTaskbarBadgeReadinessPatchSha256 -ne $ExpectedPrismWindowsTaskbarBadgeReadinessPatchHash) {
        throw "The build lock predates Windows taskbar badge readiness. Run Update-Windows-Taskbar-Badge-Readiness-Patch.ps1 first."
    }
    if (Test-Path $BuildNinja) {
        $screenSource = Join-Path $SourcePath "third_party\blink\renderer\core\frame\screen.cc"
        if (-not (Test-Path $screenSource) -or -not (Select-String -Path $screenSource -Pattern "has_fingerprint_size" -Quiet)) {
            throw "Existing Chromium source does not include the Prism screen patch. Run Update-Screen-Patch.ps1 first."
        }
        $mediaValuesSource = Join-Path $SourcePath "third_party\blink\renderer\core\css\media_values.cc"
        if (-not (Select-String -Path $screenSource -Pattern "fingerprint_height - 48" -Quiet) -or
            -not (Test-Path $mediaValuesSource) -or
            -not (Select-String -Path $mediaValuesSource -Pattern "FingerprintScreenDimension" -Quiet)) {
            throw "Existing Chromium source does not include screen/CSS consistency. Run Update-Screen-Consistency-Patch.ps1 first."
        }
        $geolocationSource = Join-Path $SourcePath "third_party\blink\renderer\core\geolocation\geolocation.cc"
        if (-not (Test-Path $geolocationSource) -or
            -not (Select-String -Path $geolocationSource -Pattern "GetFingerprintLocation" -Quiet)) {
            throw "Existing Chromium source does not include the proxy geolocation patch. Run Update-Network-Patch.ps1 first."
        }
        $renderIdentitySource = Join-Path $SourcePath "components\ungoogled\ungoogled_switches.cc"
        if (-not (Test-Path $renderIdentitySource) -or
            -not (Select-String -Path $renderIdentitySource -Pattern "fingerprint-render-identity" -Quiet) -or
            -not (Select-String -Path $renderIdentitySource -Pattern "fingerprint-language" -Quiet)) {
            throw "Existing Chromium source does not include render identity v1. Run Update-Render-Identity-Patch.ps1 first."
        }
        $speechSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"
        $fontSource = Join-Path $SourcePath "third_party\blink\renderer\platform\fonts\font_cache.cc"
        if (-not (Test-Path $speechSource) -or
            -not (Test-Path $fontSource) -or
            -not (Select-String -Path $speechSource -Pattern 'render_identity != "v2"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $fontSource -Pattern 'render_identity != "v2"' -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include conservative render identity v2. Run Update-Conservative-Render-Identity-Patch.ps1 first."
        }
        $browserViewSource = Join-Path $SourcePath "chrome\browser\ui\views\frame\browser_view.cc"
        $windowPropertySource = Join-Path $SourcePath "chrome\browser\ui\views\frame\browser_window_property_manager_win.cc"
        $toolbarSource = Join-Path $SourcePath "chrome\browser\ui\views\toolbar\toolbar_view.cc"
        if (-not (Test-Path $browserViewSource) -or
            -not (Test-Path $windowPropertySource) -or
            -not (Test-Path $toolbarSource) -or
            -not (Select-String -Path $browserViewSource -Pattern "prism-profile-serial" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $windowPropertySource -Pattern "com.prismbrowser.profile." -SimpleMatch -Quiet) -or
            -not (Select-String -Path $toolbarSource -Pattern "Prism profile identity: mirror" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include profile window identity. Run Update-Window-Identity-Patch.ps1 first."
        }
        $documentSource = Join-Path $SourcePath "third_party\blink\renderer\core\dom\document.cc"
        $canvasSource = Join-Path $SourcePath "third_party\blink\renderer\modules\canvas\canvas2d\base_rendering_context_2d.cc"
        $audioSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_context.cc"
        $webglSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
        if (-not (Test-Path $documentSource) -or
            -not (Test-Path $canvasSource) -or
            -not (Test-Path $audioSource) -or
            -not (Test-Path $webglSource) -or
            -not (Select-String -Path $documentSource -Pattern "PrismRenderIdentityNoise" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $canvasSource -Pattern "PrismCanvasTextOffset" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $audioSource -Pattern 'render_identity != "v1" && render_identity != "v3"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $webglSource -Pattern 'render_identity != "v1" && render_identity != "v3"' -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include coherent render identity v3. Run Update-Coherent-Render-Identity-Patch.ps1 first."
        }
        if (-not (Select-String -Path $documentSource -Pattern "kNoiseMask = 0xffffu" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $documentSource -Pattern "state *= 0x7feb352du" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $documentSource -Pattern "state *= 0x846ca68bu" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include DOMRect seed mixing. Run Update-DOMRect-Identity-Patch.ps1 first."
        }
        $textMetricsSource = Join-Path $SourcePath "third_party\blink\renderer\core\html\canvas\text_metrics.cc"
        $bitmapImageSource = Join-Path $SourcePath "third_party\blink\renderer\platform\graphics\static_bitmap_image.cc"
        $audioDestinationSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_destination_node.cc"
        if (-not (Test-Path $textMetricsSource) -or
            -not (Test-Path $bitmapImageSource) -or
            -not (Test-Path $audioDestinationSource) -or
            -not (Select-String -Path $textMetricsSource -Pattern 'switches::kFingerprintRenderIdentity) == "v3"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $bitmapImageSource -Pattern 'switches::kFingerprintRenderIdentity) == "v3"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $audioDestinationSource -Pattern "integral_sample_rate" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include native surface consistency. Run Update-Native-Surface-Consistency-Patch.ps1 first."
        }
        if (-not (Select-String -Path $canvasSource -Pattern "state *= 0x846ca68bu" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $webglSource -Pattern "identity_seed" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include full-seed Canvas/WebGL identity. Run Update-Native-Surface-Consistency-Patch.ps1 first."
        }
        if (-not (Select-String -Path $canvasSource -Pattern "kCanvasOffsetMask = 0x0fu" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $canvasSource -Pattern "PrismCanvasTextOffset(0x27d4eb2du)" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $canvasSource -Pattern "PrismCanvasTextOffset(0x165667b1u)" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include Canvas seed dispersion. Run Update-Canvas-Seed-Dispersion-Patch.ps1 first."
        }
        if (-not (Select-String -Path $documentSource -Pattern "coherent_render_identity ||" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $documentSource -Pattern "unsupported --enable-blink-features warning flag" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include direct DOMRect identity. Run Update-Direct-DOMRect-Identity-Patch.ps1 first."
        }
        $elementSource = Join-Path $SourcePath "third_party\blink\renderer\core\dom\element.cc"
        $rangeSource = Join-Path $SourcePath "third_party\blink\renderer\core\dom\range.cc"
        if (-not (Select-String -Path $elementSource -Pattern "GetDocument().GetNoiseFactorX() != 1.0" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $rangeSource -Pattern "owner_document_->GetNoiseFactorX() != 1.0" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include direct DOMRect consumption. Run Update-Direct-DOMRect-Consumption-Patch.ps1 first."
        }
        if (-not (Select-String -Path $speechSource -Pattern 'render_identity != "v3" && render_identity != "v4"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $fontSource -Pattern 'render_identity == "v4"' -SimpleMatch -Quiet) -or
            -not (Select-String -Path $documentSource -Pattern 'render_identity == "v3" || render_identity == "v4"' -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include native locale surfaces v4. Run Update-Native-Locale-Surfaces-V4-Patch.ps1 first."
        }
        $ttsWinSource = Join-Path $SourcePath "content\browser\speech\tts_win.cc"
        if (-not (Test-Path $ttsWinSource) -or
            -not (Select-String -Path $ttsWinSource -Pattern "that as success hides every installed desktop SAPI voice" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $ttsWinSource -Pattern "voice_count > 0" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include Windows native TTS voice fallback. Run Update-Windows-Native-TTS-Voices-Patch.ps1 first."
        }
        foreach ($marker in @("StartPrismTtsWorkerThread", "PrismSpEnumTokens", "speech_synthesizer_->GetVoice", "[PrismTTS]", "PrismTtsMtaWorker")) {
            if (-not (Select-String -Path $ttsWinSource -Pattern $marker -SimpleMatch -Quiet)) {
                throw "Existing Chromium source does not include the complete Windows TTS runtime patch. Run Update-Windows-TTS-Runtime-Patch.ps1 first."
            }
        }
        $webGlSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
        if (-not (Select-String -Path $webGlSource -Pattern "ApplyRenderIdentityToWebGLSnapshot" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include WebGL snapshot coherence. Run Update-WebGL-Snapshot-Speech-Coherence-Patch.ps1 first."
        }
        if (-not (Select-String -Path $webGlSource -Pattern "IsPrismWebGLCalibrationSurface" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $webGlSource -Pattern "found_visible_pixel" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include WebGL calibration authenticity. Run Update-WebGL-Calibration-Authenticity-Patch.ps1 first."
        }
        $fontCacheSource = Join-Path $SourcePath "third_party\blink\renderer\platform\fonts\font_cache.cc"
        if (-not (Select-String -Path $fontCacheSource -Pattern "native OS inventory intact" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $fontCacheSource -Pattern 'kFingerprintRenderIdentity) != "v4"' -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include native font inventory authenticity. Run Update-Native-Font-Inventory-Authenticity-Patch.ps1 first."
        }
        $imageBufferSource = Join-Path $SourcePath "third_party\blink\renderer\platform\graphics\image_data_buffer.cc"
        $canvasElementSource = Join-Path $SourcePath "third_party\blink\renderer\core\html\canvas\html_canvas_element.cc"
        $speechVoiceSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis_voice.h"
        $speechUtteranceSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis_utterance.cc"
        if (-not (Select-String -Path $imageBufferSource -Pattern "ApplyPrismCanvasSerializationIdentity" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $canvasElementSource -Pattern "data_buffer->ApplyPrismCanvasSerializationIdentity()" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $speechSource -Pattern "UsesPrismLocaleVoiceCatalog" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $speechVoiceSource -Pattern "platformName()" -SimpleMatch -Quiet) -or
            -not (Select-String -Path $speechUtteranceSource -Pattern "voice_->platformName()" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include final Canvas/Speech identity. Run Update-Canvas-Speech-Identity-Patches.ps1 first."
        }
        $windowPropertySource = Join-Path $SourcePath "chrome\browser\ui\views\frame\browser_window_property_manager_win.cc"
        if (-not (Test-Path $windowPropertySource) -or
            -not (Select-String -Path $windowPropertySource -Pattern "SchedulePrismProfileOverlay" -SimpleMatch -Quiet)) {
            throw "Existing Chromium source does not include Windows taskbar badge readiness. Run Update-Windows-Taskbar-Badge-Readiness-Patch.ps1 first."
        }
    }
}

function Invoke-ResumeNinja {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vsPath = (& $vswhere -latest -prerelease -products * -version "[17.0,19.0)" -property installationPath) -join ""
    if ([string]::IsNullOrWhiteSpace($vsPath)) {
        throw "Visual Studio 2022 or 2026 was not found."
    }

    $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
    $ninja = Join-Path $SourcePath "third_party\ninja\ninja.exe"
    if (-not (Test-Path $vcvars)) {
        throw "vcvars64.bat was not found: $vcvars"
    }
    if (-not (Test-Path $ninja)) {
        throw "Ninja was not found: $ninja"
    }

    $command = "call `"$vcvars`" >nul && set DEPOT_TOOLS_WIN_TOOLCHAIN=0 && `"$ninja`" -C `"$OutputPath`" -j $Jobs chrome chromedriver mini_installer"
    & cmd.exe /d /s /c $command
    if ($LASTEXITCODE -ne 0) {
        throw "Ninja exited with code $LASTEXITCODE. Run this same script again to resume."
    }
}

function Export-Artifacts {
    param([string]$PythonExecutable)

    Push-Location $RepositoryPath
    try {
        Invoke-Checked $PythonExecutable @("package.py")
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
    $packageFiles = @(Get-ChildItem -Path (Join-Path $RepositoryPath "build") -File |
        Where-Object { $_.Name -like "ungoogled-chromium_$ChromiumVersion-*" })
    if ($packageFiles.Count -lt 2) {
        throw "Expected the ZIP and installer under $RepositoryPath\build."
    }

    foreach ($file in $packageFiles) {
        Copy-Item -Path $file.FullName -Destination $ArtifactDirectory -Force
    }

    foreach ($name in @("chromedriver.exe", "args.gn")) {
        $sourceFile = Join-Path $OutputPath $name
        if (-not (Test-Path $sourceFile)) {
            throw "Expected build output is missing: $sourceFile"
        }
        Copy-Item -Path $sourceFile -Destination $ArtifactDirectory -Force
    }

    Copy-Item -Path (Join-Path $RepositoryPath "prism-build-lock.json") -Destination $ArtifactDirectory -Force

    $manifestPath = Join-Path $ArtifactDirectory "manifest.json"
    $sumsPath = Join-Path $ArtifactDirectory "SHA256SUMS.txt"
    Remove-Item -Path $manifestPath, $sumsPath -Force -ErrorAction SilentlyContinue
    $payloadFiles = @(Get-ChildItem -Path $ArtifactDirectory -File | Sort-Object Name)

    $chromePath = Join-Path $OutputPath "chrome.exe"
    $driverPath = Join-Path $OutputPath "chromedriver.exe"
    $manifest = [ordered]@{
        schemaVersion = 2
        chromiumVersion = $ChromiumVersion
        target = "windows-x64"
        contractSha256 = $ExpectedContractHash
        chromeFileVersion = (Get-Item $chromePath).VersionInfo.FileVersion
        chromedriverFileVersion = (Get-Item $driverPath).VersionInfo.FileVersion
        platformCommit = $ExpectedPlatformCommit
        fingerprintCommit = $ExpectedFingerprintCommit
        prismScreenPatchSha256 = $ExpectedPrismScreenPatchHash
        prismScreenConsistencyPatchSha256 = $ExpectedPrismScreenConsistencyPatchHash
        prismGeolocationPatchSha256 = $ExpectedPrismGeolocationPatchHash
        prismRenderIdentityPatchSha256 = $ExpectedPrismRenderIdentityPatchHash
        prismConservativeRenderIdentityPatchSha256 = $ExpectedPrismConservativeRenderIdentityPatchHash
        prismProfileWindowIdentityPatchSha256 = $ExpectedPrismProfileWindowIdentityPatchHash
        prismCoherentRenderIdentityPatchSha256 = $ExpectedPrismCoherentRenderIdentityPatchHash
        prismDomRectSeedMixingPatchSha256 = $ExpectedPrismDomRectSeedMixingPatchHash
        prismNativeSurfaceConsistencyPatchSha256 = $ExpectedPrismNativeSurfaceConsistencyPatchHash
        prismCanvasSeedDispersionPatchSha256 = $ExpectedPrismCanvasSeedDispersionPatchHash
        prismDirectDomRectIdentityPatchSha256 = $ExpectedPrismDirectDomRectIdentityPatchHash
        prismDirectDomRectConsumptionPatchSha256 = $ExpectedPrismDirectDomRectConsumptionPatchHash
        prismNativeLocaleSurfacesV4PatchSha256 = $ExpectedPrismNativeLocaleSurfacesV4PatchHash
        prismWindowsNativeTtsVoicesPatchSha256 = $ExpectedPrismWindowsNativeTtsVoicesPatchHash
        prismWindowsTtsRuntimePatchSha256 = $ExpectedPrismWindowsTtsRuntimePatchHash
        prismWebGpuTemplateIdentityPatchSha256 = $ExpectedPrismWebGpuTemplateIdentityPatchHash
        prismWebGlSnapshotSpeechCoherencePatchSha256 = $ExpectedPrismWebGlSnapshotSpeechCoherencePatchHash
        prismCanvasSerializationIdentityPatchSha256 = $ExpectedPrismCanvasSerializationIdentityPatchHash
        prismLocaleSpeechCatalogPatchSha256 = $ExpectedPrismLocaleSpeechCatalogPatchHash
        prismCoherentCanvasReadbackPatchSha256 = $ExpectedPrismCoherentCanvasReadbackPatchHash
        prismCanvasSeedSlotDispersionPatchSha256 = $ExpectedPrismCanvasSeedSlotDispersionPatchHash
        prismWebGlCalibrationAuthenticityPatchSha256 = $ExpectedPrismWebGlCalibrationAuthenticityPatchHash
        prismNativeFontInventoryAuthenticityPatchSha256 = $ExpectedPrismNativeFontInventoryAuthenticityPatchHash
        prismDomRectCalibrationAuthenticityPatchSha256 = $ExpectedPrismDomRectCalibrationAuthenticityPatchHash
        prismWindowsTaskbarBadgeReadinessPatchSha256 = $ExpectedPrismWindowsTaskbarBadgeReadinessPatchHash
        jobs = $Jobs
        buildLog = (Split-Path $transcriptPath -Leaf)
        completedAtUtc = [DateTime]::UtcNow.ToString("o")
        files = @($payloadFiles | ForEach-Object {
            $hash = Get-FileHash -Algorithm SHA256 -Path $_.FullName
            [ordered]@{
                name = $_.Name
                size = $_.Length
                sha256 = $hash.Hash.ToLowerInvariant()
            }
        })
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8

    # The checksum list covers the payload and manifest, but never itself.
    # This keeps repeated incremental packaging deterministic and avoids
    # circular hashes from stale metadata files left by a previous run.
    $hashFiles = @(Get-ChildItem -Path $ArtifactDirectory -File |
        Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
        Sort-Object Name)
    $hashLines = foreach ($file in $hashFiles) {
        $hash = Get-FileHash -Algorithm SHA256 -Path $file.FullName
        "$($hash.Hash.ToLowerInvariant())  $($file.Name)"
    }
    $hashLines | Set-Content -Path $sumsPath -Encoding ascii
}

Assert-PinnedSource
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $TmpPath -Force | Out-Null
$env:TMP = $TmpPath
$env:TEMP = $TmpPath
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = "0"

$python = Get-PythonExecutable
Assert-CleanPythonEnvironment $python
Enable-Python3Shim $python
Enable-Vs2026SourceCompatibility
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcriptPath = Join-Path $LogDirectory "windows-kernel-$timestamp.log"
$statePath = Join-Path $LogDirectory "windows-kernel-latest.json"
$startedAtUtc = [DateTime]::UtcNow.ToString("o")
Start-Transcript -Path $transcriptPath | Out-Null
Write-BuildState "running" "Build started" $statePath $startedAtUtc $transcriptPath

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED. This keeps the machine awake while the script runs.
[PrismPowerState]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null

try {
    Invoke-Checked $python @("-m", "pip", "install", "httplib2==0.22.0")

    if (Test-Path $BuildNinja) {
        Write-Host "Existing Ninja graph found. Resuming the incremental build..." -ForegroundColor Cyan
        Invoke-ResumeNinja
    } else {
        if (Test-Path (Join-Path $SourcePath "BUILD.gn")) {
            throw "A partial source setup exists but build.ninja is missing. Send the latest log back for diagnosis before cleaning or reapplying patches."
        }
        Write-Host "Starting source retrieval, patching, GN generation, and the first build..." -ForegroundColor Cyan
        Push-Location $RepositoryPath
        try {
            Invoke-Checked $python @("build.py", "-j", $Jobs.ToString())
        } finally {
            Pop-Location
        }
    }

    Export-Artifacts $python
    Write-BuildState "completed" "Build and artifact verification completed" $statePath $startedAtUtc $transcriptPath
    Write-Host ""
    Write-Host "Windows fingerprint Chromium build completed." -ForegroundColor Green
    Write-Host "Artifacts: $ArtifactDirectory"
    Write-Host "Build log: $transcriptPath"
} catch {
    Write-BuildState "failed" $_.Exception.Message $statePath $startedAtUtc $transcriptPath
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (Test-Path $BuildNinja) {
        Write-Host "The incremental build state is intact. Run this same command again to resume."
    } else {
        Write-Host "The failure happened before a Ninja graph was generated. Do not delete the download_cache."
        Write-Host "Send the log to the macOS development task before cleaning the source tree: $transcriptPath"
    }
    exit 1
} finally {
    [PrismPowerState]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
    Stop-Transcript | Out-Null
}
