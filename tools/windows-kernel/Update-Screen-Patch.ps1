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
$ExpectedPatchHash = (Get-PrismKernelPatch $KernelLock "004-screen-size.patch").sha256
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$PatchPath = Join-Path $PSScriptRoot "patches\004-screen-size.patch"

if (-not (Test-Path $PatchPath)) {
    throw "Prism screen patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism patch hash: $patchHash"
}

$platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
$fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($platformCommit -ne $ExpectedPlatformCommit -or $fingerprintCommit -ne $ExpectedFingerprintCommit) {
    throw "The prepared source does not match the pinned Prism Chromium 144 build."
}

$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) {
    throw "The Chromium build is still running. Wait for it to finish before applying the incremental screen patch."
}

$fingerprintPatchDestination = Join-Path $FingerprintPath "patches\extra\fingerprint\004-screen-size.patch"
Copy-Item -Path $PatchPath -Destination $fingerprintPatchDestination -Force
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath

$screenSource = Join-Path $SourcePath "third_party\blink\renderer\core\frame\screen.cc"
if (Test-Path $screenSource) {
    $alreadyApplied = Select-String -Path $screenSource -Pattern "has_fingerprint_size" -Quiet
    if (-not $alreadyApplied) {
        Push-Location $SourcePath
        try {
            & git.exe apply --check $PatchPath
            if ($LASTEXITCODE -ne 0) {
                throw "The screen patch does not apply cleanly to the current Chromium source."
            }
            & git.exe apply $PatchPath
            if ($LASTEXITCODE -ne 0) {
                throw "Could not apply the screen patch."
            }
        } finally {
            Pop-Location
        }
    }
}

Write-Host "Prism screen fingerprint patch is ready." -ForegroundColor Green
if (Test-Path (Join-Path $SourcePath "out\Default\build.ninja")) {
    Write-Host "Run Build-Kernel.ps1 again; Ninja will perform an incremental rebuild."
} else {
    Write-Host "Run Build-Kernel.ps1; the patch will be included in the first full build."
}
