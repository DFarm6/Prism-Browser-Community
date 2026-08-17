#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function verifyKit(root) {
  const target = resolve(root)
  if (basename(target) !== 'beta-acceptance-kit') {
    throw new Error('Kit directory must be named beta-acceptance-kit')
  }
  const manifest = JSON.parse(await readFile(join(target, 'verification.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Kit verification manifest is invalid')
  }
  const expected = [...manifest.files].sort((first, second) => first.file < second.file ? -1 : first.file > second.file ? 1 : 0)
  const actual = (await readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== 'verification.json')
    .map((entry) => entry.name)
    .sort()
  if (expected.some((record) => typeof record.file !== 'string' || record.file.includes('/')
      || !Number.isSafeInteger(record.size) || record.size <= 0 || !/^[a-f\d]{64}$/.test(record.sha256))
    || JSON.stringify(expected.map((record) => record.file)) !== JSON.stringify(actual)) {
    throw new Error('Kit file inventory does not match verification manifest')
  }
  for (const record of expected) {
    const path = join(target, record.file)
    const info = await stat(path)
    if (!info.isFile() || info.size !== record.size || await sha256(path) !== record.sha256) {
      throw new Error(`Kit file integrity check failed: ${record.file}`)
    }
  }
  return { schemaVersion: 1, passed: true, files: expected.length }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const target = process.argv[2] ? resolve(process.argv[2]) : resolve(process.cwd())
  verifyKit(target).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { verifyKit }
