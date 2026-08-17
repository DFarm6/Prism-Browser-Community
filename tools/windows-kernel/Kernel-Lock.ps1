Set-StrictMode -Version Latest

function Get-PrismKernelLock {
    $localLock = Join-Path $PSScriptRoot "kernel-lock.json"
    $repositoryLock = Join-Path (Split-Path $PSScriptRoot -Parent) "kernel-lock.json"
    $lockPath = if (Test-Path $localLock) { $localLock } else { $repositoryLock }
    if (-not (Test-Path $lockPath)) {
        throw "kernel-lock.json is missing. Export a fresh build kit before continuing."
    }
    $script:PrismKernelLockPath = $lockPath
    $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
    if ($lock.schemaVersion -ne 1 -or $lock.chromiumVersion -notmatch "^\d+(\.\d+){3}$") {
        throw "kernel-lock.json has an unsupported schema."
    }
    return $lock
}

function Get-PrismKernelPatch {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lock,
        [Parameter(Mandatory = $true)]
        [string]$File
    )
    $patch = @($Lock.patches | Where-Object { $_.file -eq $File })
    if ($patch.Count -ne 1) {
        throw "kernel-lock.json must contain exactly one patch contract for $File."
    }
    return $patch[0]
}

function Set-PrismKernelPatchSeries {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lock,
        [Parameter(Mandatory = $true)]
        [string]$SeriesPath
    )
    $patchesRoot = Split-Path $SeriesPath -Parent
    $managedEntries = @($Lock.patches | ForEach-Object { [string]$_.seriesPath })
    $availableEntries = @($Lock.patches | Where-Object {
        Test-Path (Join-Path $patchesRoot ([string]$_.seriesPath).Replace("/", "\"))
    } | ForEach-Object { [string]$_.seriesPath })
    $series = [System.Collections.ArrayList]::new()
    foreach ($line in (Get-Content $SeriesPath)) {
        if ($managedEntries -notcontains [string]$line) {
            [void]$series.Add([string]$line)
        }
    }
    $anchorOffsets = @{}
    foreach ($patch in @($Lock.patches)) {
        $entry = [string]$patch.seriesPath
        if ($availableEntries -notcontains $entry) {
            continue
        }
        $anchorEntry = if ($patch.PSObject.Properties.Name -contains "insertAfterSeriesPath") {
            [string]$patch.insertAfterSeriesPath
        } else {
            "extra/fingerprint/003-audio-fingerprint.patch"
        }
        $anchor = $series.IndexOf($anchorEntry)
        if ($anchor -lt 0) {
            throw "Could not locate the fingerprint patch insertion point: $anchorEntry"
        }
        $offset = if ($anchorOffsets.ContainsKey($anchorEntry)) {
            [int]$anchorOffsets[$anchorEntry]
        } else {
            0
        }
        $series.Insert($anchor + 1 + $offset, $entry)
        $anchorOffsets[$anchorEntry] = $offset + 1
    }
    $series | Set-Content -Path $SeriesPath -Encoding ascii
}

function Assert-PrismKernelPatchSeries {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lock,
        [Parameter(Mandatory = $true)]
        [string]$SeriesPath
    )
    $series = @((Get-Content $SeriesPath))
    $anchorOffsets = @{}
    foreach ($patch in @($Lock.patches)) {
        $entry = [string]$patch.seriesPath
        if (@($series | Where-Object { $_ -eq $entry }).Count -ne 1) {
            throw "The patch series must contain exactly one $entry."
        }
        $anchorEntry = if ($patch.PSObject.Properties.Name -contains "insertAfterSeriesPath") {
            [string]$patch.insertAfterSeriesPath
        } else {
            "extra/fingerprint/003-audio-fingerprint.patch"
        }
        $anchor = [Array]::IndexOf($series, $anchorEntry)
        if ($anchor -lt 0) {
            throw "The fingerprint patch insertion point is missing: $anchorEntry"
        }
        $offset = if ($anchorOffsets.ContainsKey($anchorEntry)) {
            [int]$anchorOffsets[$anchorEntry]
        } else {
            0
        }
        if ([Array]::IndexOf($series, $entry) -ne $anchor + 1 + $offset) {
            throw "The Prism patch series order does not match kernel-lock.json."
        }
        $anchorOffsets[$anchorEntry] = $offset + 1
    }
}
