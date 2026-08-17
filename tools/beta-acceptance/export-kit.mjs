#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function listFiles(root, current = root) {
  const values = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) values.push(...await listFiles(root, path))
    else if (entry.isFile()) values.push(path.slice(root.length + 1))
  }
  return values.sort()
}

async function exportKit(output) {
  const target = resolve(output)
  if (basename(target) !== 'beta-acceptance-kit' || target === projectRoot) {
    throw new Error('Output directory must be named beta-acceptance-kit')
  }
  const staging = `${target}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await cp(join(projectRoot, 'tools', 'beta-acceptance', 'README.md'), join(staging, 'README.md'))
    await cp(join(projectRoot, 'tools', 'beta-acceptance', 'evidence.template.json'), join(staging, 'evidence.template.json'))
    await cp(join(projectRoot, 'tools', 'beta-acceptance', 'validate-evidence.mjs'), join(staging, 'validate-evidence.mjs'))
    await cp(join(projectRoot, 'tools', 'beta-acceptance', 'verify-kit.mjs'), join(staging, 'verify-kit.mjs'))
    await cp(join(projectRoot, 'tools', 'release', 'verify-update-candidate.mjs'), join(staging, 'verify-update-candidate.mjs'))
    await cp(join(projectRoot, 'tools', 'release', 'create-update-manifest.mjs'), join(staging, 'create-update-manifest.mjs'))
    await cp(join(projectRoot, 'build', 'beta-rollout-policy.json'), join(staging, 'beta-rollout-policy.json'))
    await cp(join(projectRoot, 'build', 'beta-release.json'), join(staging, 'beta-release.json'))
    await cp(join(projectRoot, 'build', 'update-config.beta.example.json'), join(staging, 'update-config.beta.example.json'))
    const files = await listFiles(staging)
    const records = []
    for (const file of files) {
      const path = join(staging, file)
      records.push({ file, size: (await stat(path)).size, sha256: await sha256(path) })
    }
    await writeFile(join(staging, 'verification.json'), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: records
    }, null, 2)}\n`)
    await rm(target, { recursive: true, force: true })
    await cp(staging, target, { recursive: true })
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2] ? resolve(process.argv[2]) : join(projectRoot, 'release', 'beta-acceptance-kit')
  exportKit(output).then((target) => {
    process.stdout.write(`${JSON.stringify({ passed: true, output: target }, null, 2)}\n`)
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { exportKit, listFiles }
