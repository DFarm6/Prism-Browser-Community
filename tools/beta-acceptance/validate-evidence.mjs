#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = ['darwin-arm64', 'win32-x64']
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function parseArguments(argv) {
  const options = { candidate: '', evidence: '', policy: '', output: '', evidenceBundles: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--candidate') options.candidate = resolve(argv[++index] ?? '')
    else if (argument === '--evidence') options.evidence = resolve(argv[++index] ?? '')
    else if (argument === '--policy') options.policy = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--evidence-bundle') options.evidenceBundles.push(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.candidate || !options.evidence || !options.policy || !options.output
    || options.evidenceBundles.length !== 2) {
    throw new Error('--candidate, --evidence, --policy, --output and two --evidence-bundle values are required')
  }
  return options
}

function mappedPaths(specifications) {
  const values = {}
  for (const specification of specifications) {
    const [target, path, ...extra] = specification.split(',')
    if (extra.length || !TARGETS.includes(target) || !path || values[target]) {
      throw new Error(`Invalid evidence bundle specification: ${specification}`)
    }
    values[target] = resolve(path)
  }
  if (TARGETS.some((target) => !values[target])) {
    throw new Error('Evidence bundle specifications must cover both targets')
  }
  return values
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function hashEvidenceBundles(specifications) {
  const paths = mappedPaths(specifications)
  const results = {}
  for (const target of TARGETS) {
    const info = await stat(paths[target])
    if (!info.isFile() || info.size <= 0) throw new Error(`Evidence bundle is empty: ${target}`)
    results[target] = { size: info.size, sha256: await sha256(paths[target]) }
  }
  return results
}

function compareVersions(first, second) {
  const parse = (value) => {
    const [main, prerelease = ''] = value.split('-', 2)
    return { main: main.split('.').map(Number), prerelease }
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < 3; index++) {
    if (left.main[index] !== right.main[index]) return left.main[index] - right.main[index]
  }
  if (!left.prerelease && right.prerelease) return 1
  if (left.prerelease && !right.prerelease) return -1
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true })
}

function validatePolicy(policy) {
  const phasesValid = Array.isArray(policy.phases) && policy.phases.length >= 2
    && policy.phases.every((phase, index) => typeof phase.name === 'string' && phase.name.length > 0
      && Number.isSafeInteger(phase.audiencePercent) && phase.audiencePercent >= 0 && phase.audiencePercent <= 100
      && Number.isFinite(phase.minimumHours) && phase.minimumHours > 0
      && (index === 0 || phase.audiencePercent > policy.phases[index - 1].audiencePercent))
    && new Set(policy.phases.map((phase) => phase.name)).size === policy.phases.length
  if (policy.schemaVersion !== 1 || policy.channel !== 'beta'
    || !Number.isFinite(policy.minimumSoakHoursPerPlatform)
    || !Number.isSafeInteger(policy.minimumLaunchesPerPlatform)
    || !Number.isSafeInteger(policy.minimumUpdateAttemptsPerPlatform)
    || !(policy.minimumCrashFreeRate > 0 && policy.minimumCrashFreeRate <= 1)
    || !(policy.minimumUpdateSuccessRate > 0 && policy.minimumUpdateSuccessRate <= 1)
    || !phasesValid || !Array.isArray(policy.pauseOn) || policy.pauseOn.length === 0
    || policy.rollbackStrategy !== 'publish_newer_recovery_build') {
    throw new Error('Beta rollout policy is invalid')
  }
}

function evaluateEvidence(candidate, evidence, policy, evidenceBundles) {
  const failures = []
  if (candidate.schemaVersion !== 1 || candidate.passed !== true || candidate.channel !== 'beta'
    || candidate.distributionMode !== 'signed'
    || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(candidate.version)) failures.push('candidate_report_invalid')
  if (evidence.schemaVersion !== 1 || evidence.channel !== 'beta' || evidence.version !== candidate.version) {
    failures.push('evidence_identity_mismatch')
  }
  const platformResults = {}
  for (const target of TARGETS) {
    const value = evidence.platforms?.[target]
    if (!value) {
      failures.push(`${target}:missing`)
      continue
    }
    for (const field of ['appE2ePassed', 'fingerprintNativePassed', 'fingerprintFixedTemplatePassed', 'profileDataPassed', 'proxyIdentityPassed']) {
      if (value[field] !== true) failures.push(`${target}:${field}`)
    }
    if (!/^[a-f\d]{64}$/.test(value.evidenceSha256 ?? '')) failures.push(`${target}:evidenceSha256`)
    if (!evidenceBundles?.[target] || evidenceBundles[target].sha256 !== value.evidenceSha256) {
      failures.push(`${target}:evidenceBundleMismatch`)
    }
    if (!Number.isFinite(value.soakHours) || value.soakHours < policy.minimumSoakHoursPerPlatform) failures.push(`${target}:soakHours`)
    if (!Number.isSafeInteger(value.launches) || value.launches < policy.minimumLaunchesPerPlatform
      || !Number.isSafeInteger(value.crashes) || value.crashes < 0 || value.crashes > value.launches) {
      failures.push(`${target}:launchMetrics`)
    }
    if (!Number.isSafeInteger(value.updateAttempts) || value.updateAttempts < policy.minimumUpdateAttemptsPerPlatform
      || !Number.isSafeInteger(value.updateSuccesses) || value.updateSuccesses < 0 || value.updateSuccesses > value.updateAttempts) {
      failures.push(`${target}:updateMetrics`)
    }
    const crashFreeRate = value.launches > 0 ? (value.launches - value.crashes) / value.launches : 0
    const updateSuccessRate = value.updateAttempts > 0 ? value.updateSuccesses / value.updateAttempts : 0
    if (crashFreeRate < policy.minimumCrashFreeRate) failures.push(`${target}:crashFreeRate`)
    if (updateSuccessRate < policy.minimumUpdateSuccessRate) failures.push(`${target}:updateSuccessRate`)
    platformResults[target] = {
      soakHours: value.soakHours,
      launches: value.launches,
      crashFreeRate,
      updateAttempts: value.updateAttempts,
      updateSuccessRate,
      evidenceSha256: value.evidenceSha256,
      evidenceSize: evidenceBundles?.[target]?.size
    }
  }
  const recovery = evidence.recoveryDrill
  if (!recovery || recovery.passed !== true || recovery.signedManifestVerified !== true
    || recovery.profileDataPreserved !== true
    || typeof recovery.recoveryVersion !== 'string' || !VERSION_PATTERN.test(recovery.recoveryVersion)
    || compareVersions(recovery.recoveryVersion, candidate.version) <= 0) {
    failures.push('newer_recovery_build_drill')
  }

  const rolloutGate = evidence.rolloutGate
  const requestedPhaseIndex = policy.phases.findIndex((phase) => phase.name === rolloutGate?.requestedPhase)
  if (requestedPhaseIndex < 0 || !Array.isArray(rolloutGate?.pauseSignals)
    || !Number.isFinite(rolloutGate?.observedHours) || rolloutGate.observedHours < 0) {
    failures.push('rollout_gate_invalid')
  } else {
    const pauseSignals = rolloutGate.pauseSignals
    if (pauseSignals.some((signal) => !policy.pauseOn.includes(signal))) failures.push('rollout_gate_unknown_pause_signal')
    if (pauseSignals.length > 0) failures.push('rollout_paused')
    if (requestedPhaseIndex === 0) {
      if (rolloutGate.completedPhase !== null) failures.push('rollout_gate_phase_sequence')
    } else {
      const completedPhase = policy.phases[requestedPhaseIndex - 1]
      if (rolloutGate.completedPhase !== completedPhase.name) failures.push('rollout_gate_phase_sequence')
      if (rolloutGate.observedHours < completedPhase.minimumHours) failures.push('rollout_gate_observation_time')
    }
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: failures.length === 0,
    channel: candidate.channel,
    version: candidate.version,
    failures,
    platformResults,
    recoveryVersion: recovery?.recoveryVersion,
    rollout: failures.length === 0 ? {
      authorizedPhase: rolloutGate.requestedPhase,
      phases: policy.phases,
      automaticPromotion: false,
      note: '每个阶段达到最短观察时间后，使用新的证据文件重新运行门禁；工具不会自动发布。'
    } : null
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const [candidate, evidence, policy] = await Promise.all([
    readFile(options.candidate, 'utf8').then(JSON.parse),
    readFile(options.evidence, 'utf8').then(JSON.parse),
    readFile(options.policy, 'utf8').then(JSON.parse)
  ])
  validatePolicy(policy)
  const evidenceBundles = await hashEvidenceBundles(options.evidenceBundles)
  const report = evaluateEvidence(candidate, evidence, policy, evidenceBundles)
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export {
  compareVersions,
  evaluateEvidence,
  hashEvidenceBundles,
  mappedPaths,
  parseArguments,
  validatePolicy
}
