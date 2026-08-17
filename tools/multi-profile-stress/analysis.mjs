const MIB = 1024 * 1024

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback
}

export function analyzeStressRun(input) {
  const samples = Array.isArray(input.samples) ? input.samples : []
  if (samples.length < 2) throw new Error('Multi-profile stress analysis requires at least two runtime samples')
  const first = samples[0]
  const last = samples.at(-1)
  const peakRssBytes = Math.max(...samples.map((sample) => finite(sample.rssBytes)))
  const rssGrowthBytes = finite(last.rssBytes) - finite(first.rssBytes)
  const peakRssGrowthBytes = peakRssBytes - finite(first.rssBytes)
  const rssGrowthLimitBytes = Math.max(input.profileCount * 64 * MIB, finite(first.rssBytes) * 0.35)
  const peakRssGrowthLimitBytes = Math.max(input.profileCount * 96 * MIB, finite(first.rssBytes) * 0.5)
  const cpuSamples = samples.map((sample) => sample.cpuPercent).filter(Number.isFinite)
  const averageCpuPercent = cpuSamples.length
    ? cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length
    : null
  const peakProcessCount = Math.max(...samples.map((sample) => finite(sample.processCount)))
  const peakRssPerProfileBytes = peakRssBytes / Math.max(1, input.profileCount)
  const averageCpuLimitPercent = Math.max(50, input.profileCount * 20)
  const checks = {
    allProfilesLaunched: input.launchedProfiles === input.profileCount && input.launchFailures.length === 0,
    uniqueUserDataDirectories: input.uniqueUserDataDirectories === input.profileCount,
    launchConcurrencyBounded: input.maxObservedLaunches > 0 && input.maxObservedLaunches <= input.launchConcurrency,
    noUnexpectedExits: input.unexpectedExits.length === 0,
    allRootsStayedAlive: samples.every((sample) => sample.activeRootPids === input.launchedProfiles),
    finalRssGrowth: rssGrowthBytes <= rssGrowthLimitBytes,
    peakRssGrowth: peakRssGrowthBytes <= peakRssGrowthLimitBytes,
    perProfileRssBudget: peakRssPerProfileBytes <= 1024 * MIB,
    processDensity: peakProcessCount <= input.profileCount * 12,
    boundedAverageCpu: averageCpuPercent === null || averageCpuPercent <= averageCpuLimitPercent,
    noRemainingRootProcesses: input.remainingRootPids.length === 0,
    noRemainingManagedProcesses: input.remainingManagedPids.length === 0
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Math.max(0, finite(last.capturedAtMs) - finite(first.capturedAtMs)),
    profileCount: input.profileCount,
    launchedProfiles: input.launchedProfiles,
    launchConcurrency: input.launchConcurrency,
    maxObservedLaunches: input.maxObservedLaunches,
    samples: samples.length,
    memory: {
      firstRssBytes: finite(first.rssBytes),
      lastRssBytes: finite(last.rssBytes),
      peakRssBytes,
      rssGrowthBytes,
      peakRssGrowthBytes,
      peakRssPerProfileBytes,
      rssGrowthLimitBytes,
      peakRssGrowthLimitBytes
    },
    cpu: {
      averagePercent: averageCpuPercent === null ? null : Number(averageCpuPercent.toFixed(2)),
      limitPercent: averageCpuLimitPercent
    },
    peakProcessCount,
    launchFailures: input.launchFailures,
    unexpectedExits: input.unexpectedExits,
    remainingRootPids: input.remainingRootPids,
    remainingManagedPids: input.remainingManagedPids,
    checks,
    passed: Object.values(checks).every(Boolean)
  }
}
