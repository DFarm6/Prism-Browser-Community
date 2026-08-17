#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function parseArguments(argv) {
  const options = {
    channel: '',
    distributionMode: 'signed',
    version: '',
    privateKey: '',
    notes: '',
    output: '',
    artifacts: [],
    allowPartial: false
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--channel') options.channel = argv[++index] ?? ''
    else if (argument === '--distribution-mode') options.distributionMode = argv[++index] ?? ''
    else if (argument === '--version') options.version = argv[++index] ?? ''
    else if (argument === '--private-key') options.privateKey = resolve(argv[++index] ?? '')
    else if (argument === '--notes') options.notes = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--artifact') options.artifacts.push(argv[++index] ?? '')
    else if (argument === '--allow-partial') options.allowPartial = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!['stable', 'beta'].includes(options.channel)) throw new Error('--channel must be stable or beta')
  if (!['signed', 'internal-unsigned'].includes(options.distributionMode)
    || options.distributionMode === 'internal-unsigned' && options.channel !== 'beta') {
    throw new Error('--distribution-mode must be signed, or internal-unsigned with the beta channel')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)
    || (options.channel === 'stable' && options.version.includes('-'))) {
    throw new Error('Version and channel are inconsistent')
  }
  if (!options.privateKey || !options.notes || !options.output || options.artifacts.length === 0) {
    throw new Error('--private-key, --notes, --output and at least one --artifact are required')
  }
  return options
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function createManifest(options) {
  const privateKey = createPrivateKey(await readFile(options.privateKey, 'utf8'))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing key must be Ed25519')
  const notes = await readFile(options.notes, 'utf8')
  if (notes.length > 20_000) throw new Error('Release notes exceed 20,000 characters')
  const artifacts = {}
  for (const specification of options.artifacts) {
    const [target, kind, pathValue, urlValue, ...extra] = specification.split(',')
    if (extra.length || !/^(darwin-arm64|win32-x64)$/.test(target)
      || !/^(dmg|exe)$/.test(kind) || !pathValue || !urlValue) {
      throw new Error(`Invalid artifact specification: ${specification}`)
    }
    if ((target === 'darwin-arm64' && kind !== 'dmg') || (target === 'win32-x64' && kind !== 'exe')) {
      throw new Error(`Artifact kind does not match target: ${specification}`)
    }
    const url = new URL(urlValue)
    if (url.protocol !== 'https:' || decodeURIComponent(basename(url.pathname)) !== basename(pathValue)) {
      throw new Error(`Artifact URL must be HTTPS and end with the exact filename: ${specification}`)
    }
    const path = resolve(pathValue)
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) throw new Error(`Artifact is empty: ${path}`)
    artifacts[target] = { url: url.href, size: info.size, sha256: await hashFile(path), kind }
  }
  if (!options.allowPartial && (!artifacts['darwin-arm64'] || !artifacts['win32-x64'])) {
    throw new Error('A production update manifest requires both darwin-arm64 and win32-x64 artifacts')
  }
  const payload = {
    schemaVersion: 1,
    channel: options.channel,
    distributionMode: options.distributionMode,
    version: options.version,
    publishedAt: new Date().toISOString(),
    notes,
    artifacts
  }
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64')
  return {
    manifest: { ...payload, signature },
    publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await createManifest(options)
  await writeFile(options.output, `${JSON.stringify(result.manifest, null, 2)}\n`, { mode: 0o644 })
  process.stdout.write(JSON.stringify({
    output: options.output,
    version: result.manifest.version,
    channel: result.manifest.channel,
    distributionMode: result.manifest.distributionMode,
    targets: Object.keys(result.manifest.artifacts),
    publicKey: result.publicKey
  }, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { canonicalJson, createManifest, parseArguments }
