[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter()]
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Node.js 22 LTS x64 was not found."
}
$nodeMajor = [int]((& $node.Source -p "process.versions.node.split('.')[0]") -join "")
if ($nodeMajor -lt 22) {
    throw "Node.js 22 LTS or newer is required."
}
if (-not [Environment]::Is64BitProcess) {
    throw "Use the x64 Node.js runtime."
}

$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$unpacked = Join-Path $ProjectRoot "release\win-unpacked"
$output = Join-Path $ProjectRoot "release\windows-package-acceptance.json"
$runner = Join-Path $PSScriptRoot "run.cjs"
if (-not (Test-Path $runner)) {
    throw "Windows acceptance runner is missing: $runner"
}

$arguments = @(
    $runner,
    "--unpacked", $unpacked,
    "--output", $output
)
if ($KeepData) {
    $arguments += "--keep-data"
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows package acceptance failed. Inspect: $output"
}
