#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson } from './create-update-manifest.mjs'

const TARGETS = ['darwin-arm64', 'win32-x64']

function parseArguments(argv) {
  const options = { manifest: '', publicKey: '', artifacts: [], acceptances: [], output: '', requireChannel: '' }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--manifest') options.manifest = resolve(argv[++index] ?? '')
    else if (argument === '--public-key') options.publicKey = resolve(argv[++index] ?? '')
    else if (argument === '--artifact') options.artifacts.push(argv[++index] ?? '')
    else if (argument === '--acceptance') options.acceptances.push(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--require-channel') options.requireChannel = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.manifest || !options.publicKey || !options.output
    || options.artifacts.length !== 2 || options.acceptances.length !== 2) {
    throw new Error('--manifest, --public-key, --output, two --artifact and two --acceptance values are required')
  }
  if (options.requireChannel && !['stable', 'beta'].includes(options.requireChannel)) {
    throw new Error('--require-channel must be stable or beta')
  }
  return options
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function mappedPaths(specifications, label) {
  const values = {}
  for (const specification of specifications) {
    const [target, path, ...extra] = specification.split(',')
    if (extra.length || !TARGETS.includes(target) || !path || values[target]) {
      throw new Error(`Invalid ${label} specification: ${specification}`)
    }
    values[target] = resolve(path)
  }
  if (TARGETS.some((target) => !values[target])) throw new Error(`${label} specifications must cover both targets`)
  return values
}

function validateAcceptance(target, value, version) {
  if (value.schemaVersion !== 1 || value.passed !== true || value.target !== target
    || value.version !== version || value.updateConfigVerified !== true) {
    throw new Error(`Release acceptance does not match ${target} ${version}`)
  }
  if (target === 'darwin-arm64') {
    for (const field of ['developerIdVerified', 'gatekeeperVerified', 'notarizationStapleVerified']) {
      if (value[field] !== true) throw new Error(`macOS release acceptance is missing ${field}`)
    }
    if (typeof value.developerTeam !== 'string' || value.developerTeam.length === 0
      || !Array.isArray(value.artifacts) || value.artifacts.length !== 2
      || !value.artifacts.some((file) => file.endsWith('.dmg'))
      || !value.artifacts.some((file) => file.endsWith('.zip'))) {
      throw new Error('macOS release acceptance is missing its Developer ID team or signed artifacts')
    }
  } else {
    if (!Array.isArray(value.files) || value.files.length < 4
      || new Set(value.files.map((file) => file.file)).size < 4
      || value.files.some((file) => typeof file.file !== 'string' || file.file.length === 0
        || file.status !== 'Valid' || file.timestamped !== true || !file.thumbprint)) {
      throw new Error('Windows release acceptance contains an unsigned or untimestamped file')
    }
  }
}

async function verifyCandidate(options) {
  const publicKeyText = await readFile(options.publicKey, 'utf8')
  const publicKey = createPublicKey(publicKeyText)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Candidate public key must be Ed25519')
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'))
  const { signature, ...payload } = manifest
  if (manifest.schemaVersion !== 1 || !['stable', 'beta'].includes(manifest.channel)
    || manifest.distributionMode !== 'signed'
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || typeof signature !== 'string' || !manifest.artifacts
    || !verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('Candidate update manifest is invalid or has an invalid signature')
  }
  if (options.requireChannel && manifest.channel !== options.requireChannel) {
    throw new Error(`Expected ${options.requireChannel} channel, received ${manifest.channel}`)
  }
  if (manifest.channel === 'stable' && manifest.version.includes('-')) {
    throw new Error('Stable candidate cannot use a prerelease version')
  }
  if (options.requireChannel === 'beta' && !/-beta\.\d+$/.test(manifest.version)) {
    throw new Error('Beta candidate version must end with -beta.<number>')
  }

  const artifactPaths = mappedPaths(options.artifacts, 'artifact')
  const acceptancePaths = mappedPaths(options.acceptances, 'acceptance')
  const artifacts = {}
  const acceptanceEvidence = {}
  for (const target of TARGETS) {
    const contract = manifest.artifacts[target]
    if (!contract || typeof contract.url !== 'string' || new URL(contract.url).protocol !== 'https:'
      || !Number.isSafeInteger(contract.size) || contract.size <= 0
      || !/^[a-f\d]{64}$/i.test(contract.sha256)
      || (target === 'darwin-arm64' ? contract.kind !== 'dmg' : contract.kind !== 'exe')) {
      throw new Error(`Manifest artifact contract is invalid: ${target}`)
    }
    const path = artifactPaths[target]
    const info = await stat(path)
    const digest = await sha256(path)
    if (!info.isFile() || info.size !== contract.size || digest !== contract.sha256.toLowerCase()
      || decodeURIComponent(basename(new URL(contract.url).pathname)) !== basename(path)) {
      throw new Error(`Local candidate artifact does not match signed manifest: ${target}`)
    }
    const acceptanceText = await readFile(acceptancePaths[target], 'utf8')
    validateAcceptance(target, JSON.parse(acceptanceText), manifest.version)
    artifacts[target] = { file: basename(path), size: info.size, sha256: digest, kind: contract.kind }
    acceptanceEvidence[target] = {
      file: basename(acceptancePaths[target]),
      sha256: createHash('sha256').update(acceptanceText).digest('hex')
    }
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    channel: manifest.channel,
    distributionMode: manifest.distributionMode,
    version: manifest.version,
    manifestSha256: await sha256(options.manifest),
    publicKeySha256: createHash('sha256').update(publicKeyText).digest('hex'),
    artifacts,
    acceptanceEvidence
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await verifyCandidate(options)
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { parseArguments, validateAcceptance, verifyCandidate }
