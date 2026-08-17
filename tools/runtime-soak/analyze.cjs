#!/usr/bin/env node

const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { dirname, resolve } = require('node:path')

const MIB = 1024 * 1024

function parseArguments(argv) {
  const files = []
  let output = ''
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output') output = resolve(argv[++index] ?? '')
    else if (argv[index].startsWith('--')) throw new Error(`Unknown argument: ${argv[index]}`)
    else files.push(resolve(argv[index]))
  }
  if (files.length < 2) throw new Error('Usage: node tools/runtime-soak/analyze.cjs [--output report.json] <first-diagnostics.json> <later-diagnostics.json> [...]')
  return { files, output }
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid runtime metric: ${label}`)
  return Number(value)
}

function normalizeSnapshot(document, index) {
  const generatedAt = Date.parse(document?.generatedAt)
  const runtime = document?.runtime
  const main = runtime?.mainProcess
  const launcher = runtime?.launcher
  if (!Number.isFinite(generatedAt) || !main || !launcher || typeof main.activeResources !== 'object') {
    throw new Error(`Diagnostics snapshot ${index + 1} does not contain runtime metrics`)
  }
  const activeResources = Object.entries(main.activeResources).reduce((total, [name, count]) =>
    total + finiteNonNegative(count, `activeResources.${name}`), 0)
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    timestamp: generatedAt,
    rssBytes: finiteNonNegative(main.rssBytes, 'rssBytes'),
    heapUsedBytes: finiteNonNegative(main.heapUsedBytes, 'heapUsedBytes'),
    externalBytes: finiteNonNegative(main.externalBytes, 'externalBytes'),
    cpuMicroseconds: finiteNonNegative(main.cpuUserMicroseconds, 'cpuUserMicroseconds')
      + finiteNonNegative(main.cpuSystemMicroseconds, 'cpuSystemMicroseconds'),
    activeResources,
    launcher: {
      managedProcesses: finiteNonNegative(launcher.managedProcesses, 'managedProcesses'),
      orphanProcesses: finiteNonNegative(launcher.orphanProcesses, 'orphanProcesses'),
      launchOperations: finiteNonNegative(launcher.launchOperations, 'launchOperations'),
      closeOperations: finiteNonNegative(launcher.closeOperations, 'closeOperations'),
      activeLaunches: finiteNonNegative(launcher.activeLaunches, 'activeLaunches'),
      queuedLaunches: finiteNonNegative(launcher.queuedLaunches, 'queuedLaunches'),
      closingAll: launcher.closingAll === true
    }
  }
}

function analyzeSnapshots(documents) {
  if (!Array.isArray(documents) || documents.length < 2) throw new Error('At least two diagnostics snapshots are required')
  const snapshots = documents.map(normalizeSnapshot).sort((left, right) => left.timestamp - right.timestamp)
  const first = snapshots[0]
  const last = snapshots.at(-1)
  const elapsedMs = last.timestamp - first.timestamp
  if (elapsedMs <= 0) throw new Error('Diagnostics timestamps must span a positive duration')

  const rssGrowthBytes = last.rssBytes - first.rssBytes
  const heapGrowthBytes = last.heapUsedBytes - first.heapUsedBytes
  const externalGrowthBytes = last.externalBytes - first.externalBytes
  const activeResourceGrowth = last.activeResources - first.activeResources
  const cpuDeltaMicroseconds = Math.max(0, last.cpuMicroseconds - first.cpuMicroseconds)
  const averageCpuPercent = cpuDeltaMicroseconds / (elapsedMs * 1000) * 100
  const rssLimit = Math.max(128 * MIB, first.rssBytes * 0.5)
  const heapLimit = Math.max(64 * MIB, first.heapUsedBytes * 0.5)
  const externalLimit = Math.max(64 * MIB, first.externalBytes)
  const activeResourceLimit = Math.max(20, first.activeResources)
  const pendingLifecycleOperations = last.launcher.launchOperations + last.launcher.closeOperations
    + last.launcher.activeLaunches + last.launcher.queuedLaunches

  const checks = {
    rssGrowth: rssGrowthBytes <= rssLimit,
    heapGrowth: heapGrowthBytes <= heapLimit,
    externalGrowth: externalGrowthBytes <= externalLimit,
    activeResourceGrowth: activeResourceGrowth <= activeResourceLimit,
    averageCpu: averageCpuPercent <= 50,
    noPendingLifecycleOperations: pendingLifecycleOperations === 0 && !last.launcher.closingAll,
    noOrphanProcesses: last.launcher.orphanProcesses === 0
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: elapsedMs,
    samples: snapshots.length,
    first: { generatedAt: first.generatedAt, launcher: first.launcher },
    last: { generatedAt: last.generatedAt, launcher: last.launcher },
    deltas: {
      rssGrowthBytes,
      heapGrowthBytes,
      externalGrowthBytes,
      activeResourceGrowth,
      averageCpuPercent: Number(averageCpuPercent.toFixed(2))
    },
    limits: {
      rssGrowthBytes: rssLimit,
      heapGrowthBytes: heapLimit,
      externalGrowthBytes: externalLimit,
      activeResourceGrowth: activeResourceLimit,
      averageCpuPercent: 50
    },
    checks,
    passed: Object.values(checks).every(Boolean)
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2))
    const documents = await Promise.all(options.files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
    const report = analyzeSnapshots(documents)
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true })
      await writeFile(options.output, text, 'utf8')
    }
    process.stdout.write(`Runtime soak analysis: ${report.passed ? 'PASS' : 'FAIL'}\n`)
    for (const [name, passed] of Object.entries(report.checks)) {
      process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`)
    }
    process.stdout.write(`Average CPU: ${report.deltas.averageCpuPercent}%\n`)
    if (options.output) process.stdout.write(`Report: ${options.output}\n`)
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) void main()

module.exports = { parseArguments, analyzeSnapshots }
