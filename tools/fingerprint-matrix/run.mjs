#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { availableParallelism, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const AUDIT_TOOL = resolve(TOOL_DIR, '../fingerprint-audit/run.mjs')
const WINDOWS_GPU_CATALOG = JSON.parse(await readFile(
  resolve(TOOL_DIR, '../../src/shared/windows-gpu-catalog.json'),
  'utf8'
))
const MACOS_GPU_CATALOG = [
  'Apple M1',
  'Apple M1 Pro',
  'Apple M2',
  'Apple M2 Max',
  'Apple M2 Pro',
  'Apple M3',
  'Apple M3 Max',
  'Apple M3 Pro',
  'Apple M4',
  'Apple M4 Max',
  'Apple M4 Pro'
].map((model, bucket) => ({ model, bucket }))

function currentPlatformVersion(platform) {
  if (platform === 'windows') return '10.0.0'
  const darwinMajor = Number(release().split('.')[0])
  if (!Number.isInteger(darwinMajor)) return '15.0.0'
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`
  return darwinMajor >= 20 ? `${darwinMajor - 9}.0.0` : '15.0.0'
}

function parseArguments(argv) {
  const options = {
    browser: '',
    platform: process.platform === 'win32' ? 'windows' : 'macos',
    version: '144.0.7559.132',
    outputDir: resolve('release/fingerprint-matrix'),
    allowNoSandbox: false,
    debugTransport: 'auto'
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--browser') options.browser = resolve(argv[++index] ?? '')
    else if (argument === '--platform') options.platform = argv[++index] ?? ''
    else if (argument === '--version') options.version = argv[++index] ?? ''
    else if (argument === '--output-dir') options.outputDir = resolve(argv[++index] ?? '')
    else if (argument === '--debug-transport') options.debugTransport = argv[++index] ?? ''
    else if (argument === '--allow-no-sandbox') options.allowNoSandbox = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.browser) {
    throw new Error('Usage: node tools/fingerprint-matrix/run.mjs --browser /path/to/Chromium [--platform macos|windows] [--version 144.0.7559.132]')
  }
  if (!['macos', 'windows'].includes(options.platform)) throw new Error('--platform must be macos or windows')
  if (!['auto', 'pipe', 'websocket'].includes(options.debugTransport)) throw new Error('--debug-transport must be auto, pipe or websocket')
  if (!/^\d+(?:\.\d+){3}$/.test(options.version)) throw new Error('--version must be an exact four-part Chromium version')
  return options
}

function alignedSeed(seed, bucket, bucketCount) {
  const remainder = seed % bucketCount
  const candidate = seed - remainder + bucket
  return candidate <= 0xffffffff ? candidate : candidate - bucketCount
}

function profileCases(platform) {
  if (platform === 'windows') {
    return [
      {
        id: 'windows-host',
        surfaceMode: 'native',
        platformVersion: '10.0.0',
        hardwareConcurrency: Math.max(2, Math.min(64, availableParallelism())),
        screenWidth: 1920,
        screenHeight: 1080
      },
      {
        id: 'windows-seeded-nvidia',
        surfaceMode: 'template',
        seededGpu: true,
        renderIdentity: 'v4',
        gpuPool: WINDOWS_GPU_CATALOG.curatedDesktop,
        gpuBucketCount: WINDOWS_GPU_CATALOG.kernelCatalogSize,
        platformVersion: '10.0.0',
        hardwareConcurrency: 8,
        screenWidth: 1920,
        screenHeight: 1080
      },
      {
        id: 'windows-10-rtx3060',
        surfaceMode: 'fixed-template',
        platformVersion: '10.0.0',
        hardwareConcurrency: 8,
        screenWidth: 1920,
        screenHeight: 1080,
        expectedGpu: 'NVIDIA GeForce RTX 3060',
        renderIdentity: 'v4',
        gpuBucket: 5,
        gpuBucketCount: 57
      },
      {
        id: 'windows-11-rtx4060',
        surfaceMode: 'fixed-template',
        platformVersion: '10.0.0',
        hardwareConcurrency: 12,
        screenWidth: 1920,
        screenHeight: 1080,
        expectedGpu: 'NVIDIA GeForce RTX 4060',
        renderIdentity: 'v4',
        gpuBucket: 29,
        gpuBucketCount: 57
      },
      {
        id: 'windows-11-rtx4070',
        surfaceMode: 'fixed-template',
        platformVersion: '10.0.0',
        hardwareConcurrency: 16,
        screenWidth: 2560,
        screenHeight: 1440,
        expectedGpu: 'NVIDIA GeForce RTX 4070',
        renderIdentity: 'v4',
        gpuBucket: 34,
        gpuBucketCount: 57
      }
    ]
  }
  return [
    {
      id: 'macos-host',
      surfaceMode: 'native',
      platformVersion: currentPlatformVersion('macos'),
      hardwareConcurrency: Math.max(2, Math.min(64, availableParallelism())),
      screenWidth: 1440,
      screenHeight: 900
    },
    {
      id: 'macos-seeded-apple',
      surfaceMode: 'template',
      seededGpu: true,
      renderIdentity: 'v4',
      gpuPool: MACOS_GPU_CATALOG,
      gpuBucketCount: MACOS_GPU_CATALOG.length,
      platformVersion: '15.0.0',
      hardwareConcurrency: 8,
      screenWidth: 1440,
      screenHeight: 900
    },
    {
      id: 'macos-m1',
      surfaceMode: 'fixed-template',
      platformVersion: '13.0.0',
      hardwareConcurrency: 8,
      screenWidth: 1440,
      screenHeight: 900,
      expectedGpu: 'Apple M1',
      renderIdentity: 'v4',
      gpuBucket: 0,
      gpuBucketCount: 11
    },
    {
      id: 'macos-m3-pro',
      surfaceMode: 'fixed-template',
      platformVersion: '14.0.0',
      hardwareConcurrency: 12,
      screenWidth: 1512,
      screenHeight: 982,
      expectedGpu: 'Apple M3 Pro',
      renderIdentity: 'v4',
      gpuBucket: 7,
      gpuBucketCount: 11
    },
    {
      id: 'macos-m4-pro',
      surfaceMode: 'fixed-template',
      platformVersion: '15.0.0',
      hardwareConcurrency: 12,
      screenWidth: 1512,
      screenHeight: 982,
      expectedGpu: 'Apple M4 Pro',
      renderIdentity: 'v4',
      gpuBucket: 10,
      gpuBucketCount: 11
    }
  ]
}

function runAudit(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [AUDIT_TOOL, ...args], { stdio: 'inherit', windowsHide: true })
    child.once('exit', (code, signal) => resolveRun({ code, signal }))
    child.once('error', () => resolveRun({ code: 1, signal: null }))
  })
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await mkdir(options.outputDir, { recursive: true })
  const cases = []
  const profiles = profileCases(options.platform)
  for (const profile of profiles) {
    const selectedGpuA = profile.gpuPool?.[100001 % profile.gpuPool.length] ?? null
    const selectedGpuB = profile.gpuPool?.[200003 % profile.gpuPool.length] ?? null
    const seedA = selectedGpuA
      ? alignedSeed(100001, selectedGpuA.bucket, profile.gpuBucketCount)
      : profile.gpuBucket === undefined
        ? 100001
        : alignedSeed(100001, profile.gpuBucket, profile.gpuBucketCount)
    const seedB = selectedGpuB
      ? alignedSeed(200003, selectedGpuB.bucket, profile.gpuBucketCount)
      : profile.gpuBucket === undefined
        ? 200003
        : alignedSeed(200003, profile.gpuBucket, profile.gpuBucketCount)
    const reportPath = join(options.outputDir, `${profile.id}.json`)
    const args = [
      '--browser', options.browser,
      '--output', reportPath,
      '--platform', options.platform,
      '--platform-version', profile.platformVersion,
      '--version', options.version,
      '--surface-mode', profile.surfaceMode,
      '--hardware-concurrency', String(profile.hardwareConcurrency),
      '--screen-width', String(profile.screenWidth),
      '--screen-height', String(profile.screenHeight),
      '--seed-a', String(seedA),
      '--seed-b', String(seedB),
      '--debug-transport', options.debugTransport
    ]
    const auditExpectedGpu = profile.expectedGpu ?? selectedGpuA?.model
    if (auditExpectedGpu) args.push('--expected-gpu', auditExpectedGpu)
    if (profile.disableSpoofing) args.push('--disable-spoofing', profile.disableSpoofing)
    if (profile.renderIdentity) args.push('--render-identity', profile.renderIdentity)
    if (options.allowNoSandbox) args.push('--allow-no-sandbox')
    console.log(`\n[${cases.length + 1}/${profiles.length}] Auditing ${profile.id}...`)
    const execution = await runAudit(args)
    let report = null
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
    } catch {
      // The execution result below preserves a useful failure when Chromium
      // exits before the audit can write a report.
    }
    cases.push({
      id: profile.id,
      reportPath,
      passed: execution.code === 0 && report?.result?.passed === true,
      exitCode: execution.code,
      signal: execution.signal,
      seededGpu: profile.seededGpu === true,
      fixedGpu: Boolean(profile.expectedGpu && !profile.seededGpu),
      requiresWebgpuTemplateIdentity: profile.renderIdentity === 'v4',
      expectedGpu: profile.expectedGpu ?? null,
      selectedGpuA,
      selectedGpuB,
      actualGpu: report?.samples?.[0]?.webglRenderer ?? null,
      report
    })
  }

  const simulated = cases.filter((item) => item.fixedGpu)
  const simulatedRenderers = simulated.map((item) => item.actualGpu).filter(Boolean)
  const seeded = cases.filter((item) => item.seededGpu)
  const requiredSeededFields = new Set([
    'canvasSha256',
    'creepCanvasSha256',
    'webglRenderer',
    'webglImageSha256',
    'webglPixelsSha256',
    'audioSha256',
    'rect'
  ])
  const transitionSurfaceChecks = {
    coherentSeededSurfacesVary: seeded.length === 1
      && seeded.every((item) => {
        const fields = item.report?.result?.differentSeedFields
        return Array.isArray(fields)
          && [...requiredSeededFields].every((field) => fields.includes(field))
      })
  }
  const webgpuRequiredCases = cases.filter((item) => item.requiresWebgpuTemplateIdentity)
  const renderBundleReadiness = {
    requiredForCurrentInternalBeta: true,
    coherentSeededBundles: seeded.length === 1
      && seeded.every((item) => item.report?.result?.renderIdentityReadiness?.passed === true),
    collisionFields: [...new Set(seeded.flatMap((item) => (
      item.report?.result?.renderIdentityReadiness?.crossSeedCollisionFields ?? []
    )))].sort(),
    speechPolicyPassed: seeded.length === 1
      && seeded.every((item) => item.report?.result?.renderIdentityReadiness?.speechPolicyPassed === true),
    nativeSpeechVoicesAvailable: seeded.length === 1
      && seeded.every((item) => item.report?.result?.renderIdentityReadiness?.speechVoicesAvailable === true),
    speechSurfaceCoherent: seeded.length === 1
      && seeded.every((item) => item.report?.result?.renderIdentityReadiness?.speechPolicyPassed === true),
    webgpuCoverage: {
      requiredProfiles: webgpuRequiredCases.length,
      availableProfiles: cases.filter((item) => item.report?.result?.renderIdentityReadiness?.webgpuAvailable === true).length,
      varyingProfiles: cases.filter((item) => item.report?.result?.renderIdentityReadiness?.webgpuVaries === true).length,
      coherentProfiles: webgpuRequiredCases.filter((item) => item.report?.result?.renderIdentityReadiness?.webgpuCoherent === true).length,
      policyPassedProfiles: webgpuRequiredCases.filter((item) => item.report?.result?.renderIdentityReadiness?.webgpuPolicyPassed === true).length,
      needsKernelCoverage: cases.some((item) => item.report?.result?.renderIdentityReadiness?.webgpuNeedsKernelCoverage === true)
    }
  }
  const matrixChecks = {
    allProfilesPassed: cases.every((item) => item.passed),
    seededGpuProfilesVaryBySeed: seeded.length === 1
      && seeded.every((item) => item.report?.result?.differentSeedFields?.includes('webglRenderer')),
    seededGpuUsesCuratedDesktopPool: seeded.length === 1
      && seeded.every((item) => (
        item.selectedGpuA?.model
        && item.selectedGpuB?.model
        && !/Laptop/i.test(item.selectedGpuA.model)
        && !/Laptop/i.test(item.selectedGpuB.model)
        && item.actualGpu?.includes(item.selectedGpuA.model)
      )),
    coherentSeededSurfacesVary: transitionSurfaceChecks.coherentSeededSurfacesVary,
    coherentRenderIdentityReady: renderBundleReadiness.coherentSeededBundles,
    webgpuTemplateIdentityReady: webgpuRequiredCases.length > 0
      && webgpuRequiredCases.every((item) => item.report?.result?.renderIdentityReadiness?.webgpuPolicyPassed === true),
    simulatedGpuTemplatesDistinct: simulatedRenderers.length === simulated.length
      && new Set(simulatedRenderers).size === simulated.length,
    sameSchemaVersion: new Set(cases.map((item) => item.report?.schemaVersion).filter(Boolean)).size === 1,
    schemaVersion14: cases.every((item) => item.report?.schemaVersion === 14)
  }
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: options.platform,
    browser: options.browser,
    expectedVersion: options.version,
    passed: Object.values(matrixChecks).every(Boolean),
    matrixChecks,
    transitionSurfaceChecks,
    renderBundleReadiness,
    cases: cases.map(({ report, ...item }) => ({
      ...item,
      configuration: report?.result?.configuration ?? null,
      consistency: report?.result?.consistency ?? null
    }))
  }
  const summaryPath = join(options.outputDir, `${options.platform}-summary.json`)
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
  console.log(`\nFingerprint matrix: ${summary.passed ? 'PASS' : 'FAIL'}`)
  console.log(`Summary: ${summaryPath}`)
  if (!summary.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { alignedSeed, profileCases }
