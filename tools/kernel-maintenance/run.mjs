#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = resolve(TOOL_DIR, '..')
const LOCK_PATH = join(TOOLS_DIR, 'kernel-lock.json')
const PATCH_DIR = join(TOOLS_DIR, 'kernel-patches')

function parseArguments(argv) {
  const [command = 'verify-lock', ...rest] = argv
  const options = { command, platform: '', platformRoot: '', fingerprintRoot: '', chromiumSource: '', output: '', kitsOutput: '' }
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]
    if (argument === '--platform') options.platform = rest[++index] ?? ''
    else if (argument === '--platform-root') options.platformRoot = resolve(rest[++index] ?? '')
    else if (argument === '--fingerprint-root') options.fingerprintRoot = resolve(rest[++index] ?? '')
    else if (argument === '--chromium-source') options.chromiumSource = resolve(rest[++index] ?? '')
    else if (argument === '--output') options.output = resolve(rest[++index] ?? '')
    else if (argument === '--kits-output') options.kitsOutput = resolve(rest[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!['verify-lock', 'verify-source', 'check-patches', 'probe-upstream', 'export-kits'].includes(command)) {
    throw new Error('Command must be verify-lock, verify-source, check-patches, probe-upstream or export-kits')
  }
  return options
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function readLock() {
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'))
  if (lock.schemaVersion !== 1 || !/^\d+(?:\.\d+){3}$/.test(lock.chromiumVersion)) {
    throw new Error('Kernel lock schema or Chromium version is invalid')
  }
  if (!/^[a-f\d]{40}$/.test(lock.fingerprint?.commit ?? '')) throw new Error('Fingerprint commit is invalid')
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const contract = lock.platforms?.[platform]
    if (!contract || !/^https:\/\/github\.com\/.+\.git$/.test(contract.repository)
      || !contract.tag || !/^[a-f\d]{40}$/.test(contract.commit)) {
      throw new Error(`Kernel platform contract is invalid: ${platform}`)
    }
  }
  if (!Array.isArray(lock.patches) || lock.patches.length === 0) throw new Error('Kernel patch list is empty')
  return lock
}

async function verifyLock() {
  const lock = await readLock()
  const patchChecks = []
  for (const patch of lock.patches) {
    if (!/^[a-f\d]{64}$/.test(patch.sha256) || !patch.file || !patch.seriesPath) {
      throw new Error(`Patch contract is invalid: ${patch.id ?? '-'}`)
    }
    const canonicalPath = join(PATCH_DIR, patch.file)
    const actual = await sha256(canonicalPath)
    if (actual !== patch.sha256) throw new Error(`Patch hash mismatch: ${patch.file}`)
    const windowsCopy = join(TOOLS_DIR, 'windows-kernel', 'patches', patch.file)
    const windowsActual = await sha256(windowsCopy)
    if (windowsActual !== actual) throw new Error(`Windows patch copy drifted: ${patch.file}`)
    patchChecks.push({ id: patch.id, file: patch.file, sha256: actual, copiesMatch: true })
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    chromiumVersion: lock.chromiumVersion,
    fingerprintCommit: lock.fingerprint.commit,
    platforms: Object.fromEntries(Object.entries(lock.platforms).map(([id, value]) => [id, {
      tag: value.tag,
      commit: value.commit
    }])),
    patches: patchChecks
  }
}

async function gitHead(path) {
  return (await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim()
}

async function verifySource(options) {
  if (!['macos-arm64', 'windows-x64'].includes(options.platform)
    || !options.platformRoot || !options.fingerprintRoot) {
    throw new Error('verify-source requires --platform, --platform-root and --fingerprint-root')
  }
  const lock = await readLock()
  await verifyLock()
  const contract = lock.platforms[options.platform]
  const [platformCommit, fingerprintCommit, chromiumVersion, series] = await Promise.all([
    gitHead(options.platformRoot),
    gitHead(options.fingerprintRoot),
    readFile(join(options.fingerprintRoot, 'chromium_version.txt'), 'utf8').then((value) => value.trim()),
    readFile(join(options.fingerprintRoot, 'patches', 'series'), 'utf8').then((value) => value.split(/\r?\n/).filter(Boolean))
  ])
  if (platformCommit !== contract.commit) throw new Error(`Platform commit mismatch: ${platformCommit}`)
  if (fingerprintCommit !== lock.fingerprint.commit) throw new Error(`Fingerprint commit mismatch: ${fingerprintCommit}`)
  if (chromiumVersion !== lock.chromiumVersion) throw new Error(`Chromium version mismatch: ${chromiumVersion}`)
  const patchChecks = []
  const anchorOffsets = new Map()
  for (const patch of lock.patches) {
    const occurrences = series.filter((entry) => entry === patch.seriesPath).length
    if (occurrences !== 1) throw new Error(`Patch series must contain exactly one ${patch.seriesPath}; found ${occurrences}`)
    const anchor = patch.insertAfterSeriesPath ?? 'extra/fingerprint/003-audio-fingerprint.patch'
    const anchorIndex = series.indexOf(anchor)
    if (anchorIndex < 0) throw new Error(`Patch insertion anchor is missing: ${anchor}`)
    const anchorOffset = anchorOffsets.get(anchor) ?? 0
    const expectedIndex = anchorIndex + 1 + anchorOffset
    const actualIndex = series.indexOf(patch.seriesPath)
    if (actualIndex !== expectedIndex) {
      throw new Error(`Patch series placement mismatch: ${patch.seriesPath} must follow ${anchor}`)
    }
    anchorOffsets.set(anchor, anchorOffset + 1)
    const sourcePatch = join(options.fingerprintRoot, 'patches', patch.seriesPath)
    if (await sha256(sourcePatch) !== patch.sha256) throw new Error(`Prepared patch hash mismatch: ${patch.file}`)
    patchChecks.push({ id: patch.id, seriesOccurrences: occurrences, placementMatches: true, hashMatches: true })
  }
  const result = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    platform: options.platform,
    chromiumVersion,
    platformCommit,
    fingerprintCommit,
    patches: patchChecks
  }
  if (options.chromiumSource) {
    result.patchApplicability = await checkPatches(options.chromiumSource)
    result.passed = result.patchApplicability.passed
  }
  return result
}

async function patchMarkerState(sourceRoot, patch) {
  const values = []
  for (const marker of patch.appliedMarkers ?? []) {
    const [relativePath, text] = marker.split('::')
    const content = await readFile(join(sourceRoot, relativePath), 'utf8').catch(() => '')
    values.push({ path: relativePath, marker: text, present: content.includes(text) })
  }
  return values
}

async function gitApplyCheck(sourceRoot, patchPath, reverse = false) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'])
    const repositoryRoot = stdout.trim()
    const sourceDirectory = relative(repositoryRoot, sourceRoot).split(sep).join('/')
    await execFileAsync('git', [
      '-C', repositoryRoot, 'apply', '--check', '--whitespace=nowarn', '--unsafe-paths',
      ...(sourceDirectory ? [`--directory=${sourceDirectory}`] : []),
      ...(reverse ? ['--reverse'] : []),
      patchPath
    ])
    return true
  } catch {
    return false
  }
}

async function checkPatches(sourceRoot) {
  const lock = await readLock()
  await access(sourceRoot)
  const rawChecks = await Promise.all(lock.patches.map(async (patch) => {
    const patchPath = join(PATCH_DIR, patch.file)
    const [cleanlyApplies, cleanlyReverses, markers] = await Promise.all([
      gitApplyCheck(sourceRoot, patchPath),
      gitApplyCheck(sourceRoot, patchPath, true),
      patchMarkerState(sourceRoot, patch)
    ])
    const markersPresent = markers.length > 0 && markers.every((marker) => marker.present)
    return { patch, cleanlyApplies, cleanlyReverses, markersPresent, markers }
  }))
  const markersByPatchId = new Map(rawChecks.map((check) => [check.patch.id, check.markersPresent]))
  const checks = rawChecks.map(({ patch, cleanlyApplies, cleanlyReverses, markersPresent, markers }) => {
    const supersedingPatchIds = patch.supersededByPatchIds ?? []
    const superseded = supersedingPatchIds.length > 0
      && supersedingPatchIds.every((id) => markersByPatchId.get(id) === true)
    const state = cleanlyApplies && !cleanlyReverses
      ? 'ready'
      : markersPresent
        ? 'already-applied'
        : superseded
          ? 'superseded'
          : 'conflict'
    return {
      id: patch.id,
      state,
      cleanlyApplies,
      cleanlyReverses,
      markersPresent,
      supersededByPatchIds: supersedingPatchIds,
      markers
    }
  })
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    sourceRoot,
    passed: checks.every((check) => check.state !== 'conflict'),
    patches: checks
  }
}

function versionFromTag(tag) {
  return tag.match(/\d+(?:\.\d+){3}/)?.[0]
}

function compareVersions(first, second) {
  const left = first.split('.').map(Number)
  const right = second.split('.').map(Number)
  for (let index = 0; index < 4; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function githubRepositoryPath(repository) {
  const url = new URL(repository)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error(`Only GitHub HTTPS repositories can be probed: ${repository}`)
  }
  const path = url.pathname.replace(/^\/|\.git$/g, '')
  if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error(`Invalid GitHub repository: ${repository}`)
  return path
}

async function fetchTags(repository) {
  const response = await fetch(`https://api.github.com/repos/${githubRepositoryPath(repository)}/tags?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Prism-Kernel-Maintenance/0.1'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`GitHub tag probe failed for ${repository}: HTTP ${response.status}`)
  const values = await response.json()
  if (!Array.isArray(values)) throw new Error(`GitHub returned an invalid tag list for ${repository}`)
  return values
    .filter((tag) => tag && typeof tag.name === 'string' && typeof tag.commit?.sha === 'string')
    .map((tag) => ({ tag: tag.name, version: versionFromTag(tag.name), commit: tag.commit.sha }))
    .filter((tag) => tag.version)
}

async function probeUpstream() {
  const lock = await readLock()
  const repositories = {
    fingerprint: lock.fingerprint.repository,
    'macos-arm64': lock.platforms['macos-arm64'].repository,
    'windows-x64': lock.platforms['windows-x64'].repository
  }
  const entries = await Promise.all(Object.entries(repositories).map(async ([id, repository]) => {
    const tags = await fetchTags(repository)
    const newest = tags.sort((first, second) => compareVersions(second.version, first.version))[0]
    if (!newest) throw new Error(`No four-part Chromium tags found for ${repository}`)
    const pinnedTag = id === 'fingerprint' ? lock.fingerprint.tag : lock.platforms[id].tag
    const pinnedCommit = id === 'fingerprint' ? lock.fingerprint.commit : lock.platforms[id].commit
    return [id, {
      repository,
      pinned: { tag: pinnedTag, version: versionFromTag(pinnedTag), commit: pinnedCommit },
      newest,
      updateAvailable: compareVersions(newest.version, versionFromTag(pinnedTag)) > 0
        || (newest.tag === pinnedTag && newest.commit !== pinnedCommit)
    }]
  }))
  const sources = Object.fromEntries(entries)
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    pinnedChromiumVersion: lock.chromiumVersion,
    updateAvailable: Object.values(sources).some((source) => source.updateAvailable),
    sources
  }
}

async function assertSafeExportRoot(outputRoot) {
  const target = resolve(outputRoot)
  const protectedPaths = new Set([
    parse(target).root,
    resolve(homedir()),
    resolve(process.cwd()),
    resolve(TOOLS_DIR),
    resolve(TOOLS_DIR, '..')
  ])
  if (protectedPaths.has(target)) throw new Error(`Refusing to replace protected export path: ${target}`)
  const info = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(`Refusing to replace symbolic-link export path: ${target}`)
}

async function exportKits(outputRoot) {
  if (!outputRoot) throw new Error('export-kits requires --kits-output')
  await assertSafeExportRoot(outputRoot)
  const lockReport = await verifyLock()
  const staging = `${outputRoot}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await cp(join(TOOLS_DIR, 'kernel-maintenance'), join(staging, 'kernel-maintenance'), { recursive: true })
    await cp(LOCK_PATH, join(staging, 'kernel-lock.json'))
    await cp(PATCH_DIR, join(staging, 'kernel-patches'), { recursive: true })
    for (const platform of ['macos-kernel', 'windows-kernel']) {
      const destination = join(staging, platform)
      await cp(join(TOOLS_DIR, platform), destination, { recursive: true })
      await cp(LOCK_PATH, join(destination, 'kernel-lock.json'))
      const patchDestination = join(destination, 'patches')
      await mkdir(patchDestination, { recursive: true })
      const lock = await readLock()
      for (const patch of lock.patches) await cp(join(PATCH_DIR, patch.file), join(patchDestination, patch.file))
    }
    await writeFile(join(staging, 'verification.json'), JSON.stringify(lockReport, null, 2), 'utf8')
    await rm(outputRoot, { recursive: true, force: true })
    await cp(staging, outputRoot, { recursive: true })
    return { schemaVersion: 1, passed: true, outputRoot }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  let result
  if (options.command === 'verify-lock') result = await verifyLock()
  else if (options.command === 'verify-source') result = await verifySource(options)
  else if (options.command === 'check-patches') {
    if (!options.chromiumSource) throw new Error('check-patches requires --chromium-source')
    result = await checkPatches(options.chromiumSource)
  } else if (options.command === 'probe-upstream') result = await probeUpstream()
  else result = await exportKits(options.kitsOutput)
  if (options.output) await writeFile(options.output, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
