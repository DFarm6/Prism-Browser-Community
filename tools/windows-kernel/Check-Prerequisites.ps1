[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock

$script:Failures = 0

function Write-Check {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    if ($Passed) {
        Write-Host "[OK]   $Name - $Detail" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $Name - $Detail" -ForegroundColor Red
        $script:Failures++
    }
}

function Get-PythonExecutable {
    foreach ($candidate in @("python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $command -and $command.CommandType -eq "Application") {
            return $command.Source
        }
    }
    return $null
}

Write-Host "Prism Windows fingerprint Chromium prerequisite check"
Write-Host "Pinned Chromium version: $($KernelLock.chromiumVersion)"
Write-Host ""

$expectedScreenPatchHash = (Get-PrismKernelPatch $KernelLock "004-screen-size.patch").sha256
$expectedScreenConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "005-screen-consistency.patch").sha256
$expectedGeolocationPatchHash = (Get-PrismKernelPatch $KernelLock "019-proxy-geolocation.patch").sha256
$expectedProfileWindowIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "022-profile-window-identity.patch").sha256
$expectedCoherentRenderIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "023-coherent-render-identity-v3.patch").sha256
$expectedDomRectSeedMixingPatchHash = (Get-PrismKernelPatch $KernelLock "024-domrect-seed-mixing.patch").sha256
$expectedNativeSurfaceConsistencyPatchHash = (Get-PrismKernelPatch $KernelLock "025-native-surface-consistency.patch").sha256
$expectedCanvasSeedDispersionPatchHash = (Get-PrismKernelPatch $KernelLock "026-canvas-seed-dispersion.patch").sha256
$expectedDirectDomRectIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "027-direct-domrect-identity.patch").sha256
$expectedDirectDomRectConsumptionPatchHash = (Get-PrismKernelPatch $KernelLock "028-direct-domrect-consumption.patch").sha256
$expectedNativeLocaleSurfacesV4PatchHash = (Get-PrismKernelPatch $KernelLock "029-native-locale-surfaces-v4.patch").sha256
$expectedWindowsNativeTtsVoicesPatchHash = (Get-PrismKernelPatch $KernelLock "030-windows-native-tts-voices.patch").sha256
$expectedWindowsTtsRuntimePatchHash = (Get-PrismKernelPatch $KernelLock "031-windows-tts-runtime.patch").sha256
$expectedWebGpuTemplateIdentityPatchHash = (Get-PrismKernelPatch $KernelLock "032-webgpu-template-identity.patch").sha256
$expectedWebGlSnapshotSpeechCoherencePatchHash = (Get-PrismKernelPatch $KernelLock "033-webgl-snapshot-speech-coherence.patch").sha256
$expectedWindowsTaskbarBadgeReadinessPatchHash = (Get-PrismKernelPatch $KernelLock "044-windows-taskbar-badge-readiness.patch").sha256
$screenPatchPath = Join-Path $PSScriptRoot "patches\004-screen-size.patch"
$screenConsistencyPatchPath = Join-Path $PSScriptRoot "patches\005-screen-consistency.patch"
$geolocationPatchPath = Join-Path $PSScriptRoot "patches\019-proxy-geolocation.patch"
$profileWindowIdentityPatchPath = Join-Path $PSScriptRoot "patches\022-profile-window-identity.patch"
$coherentRenderIdentityPatchPath = Join-Path $PSScriptRoot "patches\023-coherent-render-identity-v3.patch"
$domRectSeedMixingPatchPath = Join-Path $PSScriptRoot "patches\024-domrect-seed-mixing.patch"
$nativeSurfaceConsistencyPatchPath = Join-Path $PSScriptRoot "patches\025-native-surface-consistency.patch"
$canvasSeedDispersionPatchPath = Join-Path $PSScriptRoot "patches\026-canvas-seed-dispersion.patch"
$directDomRectIdentityPatchPath = Join-Path $PSScriptRoot "patches\027-direct-domrect-identity.patch"
$directDomRectConsumptionPatchPath = Join-Path $PSScriptRoot "patches\028-direct-domrect-consumption.patch"
$nativeLocaleSurfacesV4PatchPath = Join-Path $PSScriptRoot "patches\029-native-locale-surfaces-v4.patch"
$windowsNativeTtsVoicesPatchPath = Join-Path $PSScriptRoot "patches\030-windows-native-tts-voices.patch"
$windowsTtsRuntimePatchPath = Join-Path $PSScriptRoot "patches\031-windows-tts-runtime.patch"
$webGpuTemplateIdentityPatchPath = Join-Path $PSScriptRoot "patches\032-webgpu-template-identity.patch"
$webGlSnapshotSpeechCoherencePatchPath = Join-Path $PSScriptRoot "patches\033-webgl-snapshot-speech-coherence.patch"
$windowsTaskbarBadgeReadinessPatchPath = Join-Path $PSScriptRoot "patches\044-windows-taskbar-badge-readiness.patch"
$screenPatchHash = if (Test-Path $screenPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $screenPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$screenConsistencyPatchHash = if (Test-Path $screenConsistencyPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $screenConsistencyPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$geolocationPatchHash = if (Test-Path $geolocationPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $geolocationPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$profileWindowIdentityPatchHash = if (Test-Path $profileWindowIdentityPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $profileWindowIdentityPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$coherentRenderIdentityPatchHash = if (Test-Path $coherentRenderIdentityPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $coherentRenderIdentityPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$domRectSeedMixingPatchHash = if (Test-Path $domRectSeedMixingPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $domRectSeedMixingPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$nativeSurfaceConsistencyPatchHash = if (Test-Path $nativeSurfaceConsistencyPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $nativeSurfaceConsistencyPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$canvasSeedDispersionPatchHash = if (Test-Path $canvasSeedDispersionPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $canvasSeedDispersionPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$directDomRectIdentityPatchHash = if (Test-Path $directDomRectIdentityPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $directDomRectIdentityPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$directDomRectConsumptionPatchHash = if (Test-Path $directDomRectConsumptionPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $directDomRectConsumptionPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$nativeLocaleSurfacesV4PatchHash = if (Test-Path $nativeLocaleSurfacesV4PatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $nativeLocaleSurfacesV4PatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$windowsNativeTtsVoicesPatchHash = if (Test-Path $windowsNativeTtsVoicesPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $windowsNativeTtsVoicesPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$windowsTtsRuntimePatchHash = if (Test-Path $windowsTtsRuntimePatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $windowsTtsRuntimePatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$webGpuTemplateIdentityPatchHash = if (Test-Path $webGpuTemplateIdentityPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $webGpuTemplateIdentityPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$webGlSnapshotSpeechCoherencePatchHash = if (Test-Path $webGlSnapshotSpeechCoherencePatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $webGlSnapshotSpeechCoherencePatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
$windowsTaskbarBadgeReadinessPatchHash = if (Test-Path $windowsTaskbarBadgeReadinessPatchPath) {
    (Get-FileHash -Algorithm SHA256 -Path $windowsTaskbarBadgeReadinessPatchPath).Hash.ToLowerInvariant()
} else {
    ""
}
Write-Check "Screen patch" ($screenPatchHash -eq $expectedScreenPatchHash) $screenPatchPath
Write-Check "Screen consistency patch" ($screenConsistencyPatchHash -eq $expectedScreenConsistencyPatchHash) $screenConsistencyPatchPath
Write-Check "Proxy geolocation patch" ($geolocationPatchHash -eq $expectedGeolocationPatchHash) $geolocationPatchPath
Write-Check "Profile window identity patch" ($profileWindowIdentityPatchHash -eq $expectedProfileWindowIdentityPatchHash) $profileWindowIdentityPatchPath
Write-Check "Coherent render identity v3 patch" ($coherentRenderIdentityPatchHash -eq $expectedCoherentRenderIdentityPatchHash) $coherentRenderIdentityPatchPath
Write-Check "DOMRect seed mixing patch" ($domRectSeedMixingPatchHash -eq $expectedDomRectSeedMixingPatchHash) $domRectSeedMixingPatchPath
Write-Check "Native surface consistency patch" ($nativeSurfaceConsistencyPatchHash -eq $expectedNativeSurfaceConsistencyPatchHash) $nativeSurfaceConsistencyPatchPath
Write-Check "Canvas seed dispersion patch" ($canvasSeedDispersionPatchHash -eq $expectedCanvasSeedDispersionPatchHash) $canvasSeedDispersionPatchPath
Write-Check "Direct DOMRect identity patch" ($directDomRectIdentityPatchHash -eq $expectedDirectDomRectIdentityPatchHash) $directDomRectIdentityPatchPath
Write-Check "Direct DOMRect consumption patch" ($directDomRectConsumptionPatchHash -eq $expectedDirectDomRectConsumptionPatchHash) $directDomRectConsumptionPatchPath
Write-Check "Native locale surfaces v4 patch" ($nativeLocaleSurfacesV4PatchHash -eq $expectedNativeLocaleSurfacesV4PatchHash) $nativeLocaleSurfacesV4PatchPath
Write-Check "Windows native TTS voices patch" ($windowsNativeTtsVoicesPatchHash -eq $expectedWindowsNativeTtsVoicesPatchHash) $windowsNativeTtsVoicesPatchPath
Write-Check "Windows TTS runtime patch" ($windowsTtsRuntimePatchHash -eq $expectedWindowsTtsRuntimePatchHash) $windowsTtsRuntimePatchPath
Write-Check "WebGPU template identity patch" ($webGpuTemplateIdentityPatchHash -eq $expectedWebGpuTemplateIdentityPatchHash) $webGpuTemplateIdentityPatchPath
Write-Check "WebGL snapshot and speech coherence patch" ($webGlSnapshotSpeechCoherencePatchHash -eq $expectedWebGlSnapshotSpeechCoherencePatchHash) $webGlSnapshotSpeechCoherencePatchPath
Write-Check "Windows taskbar badge readiness patch" ($windowsTaskbarBadgeReadinessPatchHash -eq $expectedWindowsTaskbarBadgeReadinessPatchHash) $windowsTaskbarBadgeReadinessPatchPath

$os = Get-CimInstance Win32_OperatingSystem
$isSupportedWindows = [version]$os.Version -ge [version]"10.0"
Write-Check "Windows" $isSupportedWindows "$($os.Caption) $($os.Version)"

$isX64 = [Environment]::Is64BitOperatingSystem
Write-Check "Architecture" $isX64 $env:PROCESSOR_ARCHITECTURE

$buildDriveName = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$systemDrive = Get-PSDrive -Name $buildDriveName -ErrorAction SilentlyContinue
if ($null -eq $systemDrive) {
    Write-Check "Build drive" $false "Cannot resolve the drive for $BuildRoot"
} else {
    $freeGiB = [math]::Round($systemDrive.Free / 1GB, 1)
    Write-Check "Free disk" ($freeGiB -ge 180) "$freeGiB GiB free; 300 GiB or more is recommended"
}

$driveLetter = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$volume = Get-Volume -DriveLetter $driveLetter -ErrorAction SilentlyContinue
if ($null -eq $volume) {
    Write-Check "Filesystem" $false "Cannot inspect drive $driveLetter"
} else {
    Write-Check "Filesystem" ($volume.FileSystem -eq "NTFS") "$($volume.FileSystem); NTFS is required"
}

$shortPath = ($BuildRoot.Length -le 40) -and (-not $BuildRoot.Contains(" "))
Write-Check "Build path" $shortPath "$BuildRoot; use a short path without spaces"

$longPaths = Get-ItemPropertyValue `
    -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" `
    -ErrorAction SilentlyContinue
Write-Check "Long paths" ($longPaths -eq 1) "LongPathsEnabled must be 1"

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -eq $git) {
    Write-Check "Git" $false "git.exe was not found"
} else {
    $gitVersion = (& $git.Source --version) -join " "
    Write-Check "Git" ($LASTEXITCODE -eq 0) $gitVersion
}

$python = Get-PythonExecutable
if ($null -eq $python) {
    Write-Check "Python" $false "Python 3.11 or newer was not found"
} else {
    $pythonVersionText = (& $python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))") -join ""
    $pythonVersion = [version]$pythonVersionText
    Write-Check "Python" ($pythonVersion -ge [version]"3.11") "$pythonVersionText at $python"
    $venvProbe = (& $python -c "import os,sys; print('clean' if sys.prefix != sys.base_prefix and not os.environ.get('CONDA_PREFIX') else 'shared')") -join ""
    Write-Check "Clean Python venv" ($venvProbe -eq "clean") "Use py -3.12 -m venv C:\prism-venv; do not build inside Anaconda"
}

$sevenZipCandidates = @()
$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($null -ne $sevenZipCommand -and (Test-Path $sevenZipCommand.Source)) {
    $sevenZipCandidates += $sevenZipCommand.Source
}
$defaultSevenZip = "$env:ProgramFiles\7-Zip\7z.exe"
if ((Test-Path $defaultSevenZip) -and ($sevenZipCandidates -notcontains $defaultSevenZip)) {
    $sevenZipCandidates += $defaultSevenZip
}
$sevenZipDetail = "7z.exe was not found"
if ($sevenZipCandidates.Count -gt 0) {
    $sevenZipDetail = $sevenZipCandidates[0]
}
Write-Check "7-Zip" ($sevenZipCandidates.Count -gt 0) $sevenZipDetail

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Write-Check "Visual Studio" $false "vswhere.exe was not found; install Visual Studio 2022 or 2026"
} else {
    $vsPath = (& $vswhere -latest -prerelease -products * -version "[17.0,19.0)" `
        -requires Microsoft.VisualStudio.Workload.NativeDesktop `
        Microsoft.VisualStudio.Component.VC.ATLMFC `
        -property installationPath) -join ""
    $vsDetail = "C++ and ATL/MFC components are missing"
    if (-not [string]::IsNullOrWhiteSpace($vsPath)) {
        $vsDetail = $vsPath
    }
    Write-Check "Visual Studio 2022/2026" (-not [string]::IsNullOrWhiteSpace($vsPath)) $vsDetail
}

$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
$sdkInclude = Join-Path $sdkRoot "Include\10.0.26100.0"
$sdkDebugger = Join-Path $sdkRoot "Debuggers\x64\cdb.exe"
Write-Check "Windows 11 SDK" (Test-Path $sdkInclude) "10.0.26100.x headers are required"
Write-Check "SDK debugging tools" (Test-Path $sdkDebugger) "$sdkDebugger"

$depotTools = Get-Command gclient.bat -ErrorAction SilentlyContinue
Write-Check "No depot_tools" ($null -eq $depotTools) "This build uses the platform repository's custom toolchain"

Write-Host ""
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) prerequisite check(s) failed." -ForegroundColor Red
    Write-Host "Fix the failed items, open a new Administrator PowerShell, and run this script again."
    exit 1
}

Write-Host "All required checks passed." -ForegroundColor Green
exit 0
