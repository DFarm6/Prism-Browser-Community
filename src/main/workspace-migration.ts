import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BrowserExtension, BrowserProfile, ProfileDraft, WorkspaceMigrationResult } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'
import type { Logger } from './app-logger'
import type { ExtensionStore } from './extension-store'
import type { ProfileStore } from './profile-store'

const MAGIC = Buffer.concat([Buffer.from('PRISM-MIGRATION'), Buffer.from([1])])
const AUTH_TAG_BYTES = 16
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_RECORD_HEADER_BYTES = 64 * 1024
const MAX_FILES = 1_000_000
const MAX_BYTES = 500 * 1024 * 1024 * 1024
const MAX_PROFILES = 500
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1

interface ArchiveHeader {
  type: 'prism-workspace-migration'
  schemaVersion: 1
  createdAt: string
  sourcePlatform: NodeJS.Platform
  sourceAppVersion: string
  profileCount: number
  cipher: 'aes-256-gcm'
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string }
  nonce: string
  keyCheck: string
}

interface MigrationProfile { sourceId: string; favorite: boolean; profile: ProfileDraft }
interface MigrationExtension extends Omit<BrowserExtension, 'path'> { sourceId: string }
interface ArchiveManifest { schemaVersion: 1; archiveId: string; profiles: MigrationProfile[]; extensions: MigrationExtension[] }
interface RecordMetadata {
  type: 'manifest' | 'file' | 'end'
  size?: number
  path?: string
  fileCount?: number
  totalBytes?: number
  contentSha256?: string
}
type ConflictPolicy = 'rename' | 'skip'

function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new Error('迁移密码必须为 10–200 个字符')
  return password.normalize('NFKC')
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(validatePassword(password), salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolvePromise(key as Buffer)
    })
  })
}

function keyCheck(key: Buffer): Buffer {
  return createHmac('sha256', key).update('prism-workspace-migration-key-check-v1').digest().subarray(0, 16)
}

async function readExactAt(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read({ buffer, offset, length: buffer.length - offset, position: position + offset })
    if (!bytesRead) throw new Error('迁移包数据提前结束')
    offset += bytesRead
  }
}

function portableProfile(profile: BrowserProfile): MigrationProfile {
  return {
    sourceId: profile.id,
    favorite: profile.favorite,
    profile: {
      name: profile.name, note: profile.note, group: profile.group, tags: [...profile.tags],
      extensionIds: [...profile.extensionIds], color: profile.color, startUrls: [...profile.startUrls],
      kernelVersion: profile.kernelVersion, window: { ...profile.window }, proxy: { ...profile.proxy },
      fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
    }
  }
}

async function writeChunk(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

async function writeRecordHeader(stream: PassThrough, metadata: RecordMetadata): Promise<void> {
  const value = Buffer.from(JSON.stringify(metadata))
  if (value.length > MAX_RECORD_HEADER_BYTES) throw new Error('迁移记录头超出安全限制')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(value.length)
  await writeChunk(stream, length)
  await writeChunk(stream, value)
}

async function *safeFiles(root: string, prefix: string): AsyncGenerator<{ source: string; archivePath: string; size: number }> {
  const visit = async function *(current: string, relative: string): AsyncGenerator<{ source: string; archivePath: string; size: number }> {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`迁移数据包含符号链接：${relative || prefix}`)
    if (info.isDirectory()) {
      for (const entry of (await readdir(current)).sort()) yield *visit(join(current, entry), join(relative, entry))
    } else if (info.isFile()) {
      yield { source: current, archivePath: join(prefix, relative).split(sep).join('/'), size: info.size }
    }
  }
  yield *visit(root, '')
}

function safeArchivePath(root: string, value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('迁移包包含不安全的文件路径')
  const target = resolve(root, ...value.split('/'))
  const normalizedRoot = resolve(root)
  if (!target.startsWith(`${normalizedRoot}${sep}`)) throw new Error('迁移包文件路径越界')
  return target
}

class DecryptedReader {
  private readonly iterator: AsyncIterator<Buffer | string>
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) { this.iterator = stream[Symbol.asyncIterator]() }

  async readExactly(size: number): Promise<Buffer<ArrayBufferLike>> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('迁移包记录长度无效')
    while (this.buffer.length < size) {
      const next = await this.iterator.next()
      if (next.done) throw new Error('迁移包数据提前结束')
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
    const result = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return result
  }

  async copyExactly(size: number, target: string, digest: ReturnType<typeof createHash>): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
    let remaining = size
    try {
      while (remaining > 0) {
        if (!this.buffer.length) {
          const next = await this.iterator.next()
          if (next.done) throw new Error('迁移包文件数据提前结束')
          this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
        }
        const length = Math.min(remaining, this.buffer.length)
        const chunk = this.buffer.subarray(0, length)
        this.buffer = this.buffer.subarray(length)
        digest.update(chunk)
        remaining -= length
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'finish')
    } catch (error) {
      output.destroy()
      await rm(target, { force: true })
      throw error
    }
  }

  async ensureEnd(): Promise<void> {
    if (this.buffer.length) throw new Error('迁移包结束记录后仍有额外数据')
    const next = await this.iterator.next()
    if (!next.done) throw new Error('迁移包结束记录后仍有额外数据')
  }
}

async function readRecordHeader(reader: DecryptedReader): Promise<RecordMetadata> {
  const length = (await reader.readExactly(4)).readUInt32BE()
  if (length <= 0 || length > MAX_RECORD_HEADER_BYTES) throw new Error('迁移包记录头长度无效')
  try { return JSON.parse((await reader.readExactly(length)).toString('utf8')) as RecordMetadata } catch { throw new Error('迁移包记录头不是有效 JSON') }
}

function validateManifest(value: unknown): ArchiveManifest {
  const manifest = value as Partial<ArchiveManifest>
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.archiveId !== 'string'
    || !/^[a-f\d-]{36}$/i.test(manifest.archiveId) || !Array.isArray(manifest.profiles)
    || manifest.profiles.length === 0 || manifest.profiles.length > MAX_PROFILES || !Array.isArray(manifest.extensions)) {
    throw new Error('迁移包清单无效或版本不受支持')
  }
  const ids = new Set<string>()
  const profiles = manifest.profiles.map((item) => {
    if (!item || typeof item.sourceId !== 'string' || !/^[a-f\d-]{36}$/i.test(item.sourceId) || ids.has(item.sourceId)) throw new Error('迁移包包含无效或重复的环境 ID')
    ids.add(item.sourceId)
    return { sourceId: item.sourceId, favorite: item.favorite === true, profile: validateProfileDraft(item.profile) }
  })
  const extensionIds = new Set<string>()
  const extensions = manifest.extensions.map((item) => {
    if (!item || typeof item.sourceId !== 'string' || !/^[a-f\d-]{36}$/i.test(item.sourceId) || extensionIds.has(item.sourceId)) throw new Error('迁移包包含无效或重复的扩展 ID')
    extensionIds.add(item.sourceId)
    return item as MigrationExtension
  })
  if (profiles.some((item) => item.profile.extensionIds.some((id) => !extensionIds.has(id)))) throw new Error('迁移包缺少环境引用的本地扩展')
  return { schemaVersion: 1, archiveId: manifest.archiveId, profiles, extensions }
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const base = `${name.slice(0, 52)}（迁移）`
  let candidate = base
  let index = 2
  while (used.has(candidate)) candidate = `${base.slice(0, 58 - String(index).length)} ${index++}`
  used.add(candidate)
  return candidate
}

async function canonicalPathForCreation(input: string): Promise<string> {
  const absolute = resolve(input)
  let existing = absolute
  while (true) {
    try {
      return resolve(await realpath(existing), relative(existing, absolute))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
}

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function assertExportTargetsOutsideSources(targets: string[], sources: string[]): Promise<void> {
  const canonicalSources = await Promise.all(sources.map((source) => realpath(source)))
  const canonicalTargets = await Promise.all(targets.map(canonicalPathForCreation))
  for (const target of canonicalTargets) {
    if (canonicalSources.some((source) => insideOrEqual(source, target))) {
      throw new Error('迁移包不能保存在浏览器环境或扩展数据目录内部')
    }
  }
}

export class WorkspaceMigrationManager {
  constructor(private readonly profiles: ProfileStore, private readonly extensions: ExtensionStore, private readonly appVersion: string, private readonly logger?: Logger) {}

  async exportAll(destinationInput: string, passwordInput: string): Promise<WorkspaceMigrationResult> {
    const password = validatePassword(passwordInput)
    const profiles = this.profiles.list()
    if (!profiles.length) throw new Error('当前没有可迁移的浏览器环境')
    if (profiles.length > MAX_PROFILES) throw new Error('单次最多迁移 500 个环境')
    for (const profile of profiles) {
      if (profile.status !== 'closed' && profile.status !== 'error') throw new Error(`请先关闭环境“${profile.name}”`)
      await this.profiles.assertProfileDataIdentity(profile.id)
    }
    const extensionMap = new Map(this.extensions.list().map((extension) => [extension.id, extension]))
    const referencedExtensionIds = [...new Set(profiles.flatMap((profile) => profile.extensionIds))]
    for (const id of referencedExtensionIds) if (!extensionMap.has(id)) throw new Error(`环境引用的扩展 ${id.slice(0, 8)} 不存在`)
    const manifest: ArchiveManifest = {
      schemaVersion: 1,
      archiveId: randomUUID(),
      profiles: profiles.map(portableProfile),
      extensions: referencedExtensionIds.map((id) => {
        const { path: _path, ...extension } = extensionMap.get(id)!
        return { ...extension, sourceId: id }
      })
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('迁移清单过大')
    const salt = randomBytes(16)
    const nonce = randomBytes(12)
    const key = await deriveKey(password, salt)
    const header: ArchiveHeader = {
      type: 'prism-workspace-migration', schemaVersion: 1, createdAt: new Date().toISOString(), sourcePlatform: process.platform,
      sourceAppVersion: this.appVersion, profileCount: profiles.length, cipher: 'aes-256-gcm',
      kdf: { name: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
      nonce: nonce.toString('base64'), keyCheck: keyCheck(key).toString('base64')
    }
    const headerBytes = Buffer.from(JSON.stringify(header))
    const headerLength = Buffer.allocUnsafe(4)
    headerLength.writeUInt32BE(headerBytes.length)
    const destination = resolve(destinationInput)
    const staging = `${destination}.partial-${randomUUID()}`
    const roots = profiles.map((profile) => ({ root: this.profiles.profileDataPath(profile.id), prefix: `profiles/${profile.id}/user-data` }))
    for (const id of referencedExtensionIds) roots.push({ root: extensionMap.get(id)!.path, prefix: `extensions/${id}` })
    await assertExportTargetsOutsideSources([destination, staging], roots.map((root) => root.root))
    await mkdir(dirname(destination), { recursive: true })
    try {
      await stat(destination)
      throw new Error('目标迁移包已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(staging, Buffer.concat([MAGIC, headerLength, headerBytes]), { mode: 0o600, flag: 'wx' })
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(headerBytes)
    const input = new PassThrough()
    const completion = pipeline(input, cipher, createWriteStream(staging, { flags: 'a', mode: 0o600 }))
    const digest = createHash('sha256')
    let fileCount = 0
    let totalBytes = 0
    try {
      await writeRecordHeader(input, { type: 'manifest', size: manifestBytes.length })
      await writeChunk(input, manifestBytes)
      for (const root of roots) for await (const file of safeFiles(root.root, root.prefix)) {
        fileCount += 1; totalBytes += file.size
        if (fileCount > MAX_FILES) throw new Error('迁移数据文件数量超过 100 万')
        if (totalBytes > MAX_BYTES) throw new Error('迁移数据超过 500 GB')
        await writeRecordHeader(input, { type: 'file', path: file.archivePath, size: file.size })
        digest.update(file.archivePath).update('\0').update(String(file.size)).update('\0')
        for await (const chunk of createReadStream(file.source)) { digest.update(chunk as Buffer); await writeChunk(input, chunk as Buffer) }
      }
      await writeRecordHeader(input, { type: 'end', fileCount, totalBytes, contentSha256: digest.digest('hex') })
      input.end()
      await completion
      await appendFile(staging, cipher.getAuthTag())
      await rename(staging, destination)
      this.logger?.info('全部环境加密迁移包已导出', { profileCount: profiles.length, fileCount, totalBytes })
      return { path: destination, profileCount: profiles.length, importedCount: 0, skippedCount: 0, renamedCount: 0, extensionCount: referencedExtensionIds.length, totalBytes, fileCount }
    } catch (error) {
      input.destroy(); await completion.catch(() => undefined); await rm(staging, { force: true }); throw error
    } finally { key.fill(0) }
  }

  async importAll(sourceInput: string, passwordInput: string, conflictPolicy: ConflictPolicy = 'rename'): Promise<WorkspaceMigrationResult> {
    const password = validatePassword(passwordInput)
    if (conflictPolicy !== 'rename' && conflictPolicy !== 'skip') throw new Error('迁移冲突处理策略无效')
    const source = resolve(sourceInput)
    const sourceInfo = await stat(source)
    if (!sourceInfo.isFile() || sourceInfo.size < MAGIC.length + 4 + AUTH_TAG_BYTES) throw new Error('迁移包文件无效')
    const handle = await open(source, 'r')
    let headerBytes: Buffer; let header: ArchiveHeader; let payloadOffset: number; let authTag: Buffer
    try {
      const prefix = Buffer.alloc(MAGIC.length + 4)
      await readExactAt(handle, prefix, 0)
      if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是受支持的 Prism 全部环境迁移包')
      const headerLength = prefix.readUInt32BE(MAGIC.length)
      if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) throw new Error('迁移包头长度无效')
      headerBytes = Buffer.alloc(headerLength)
      await readExactAt(handle, headerBytes, MAGIC.length + 4)
      try { header = JSON.parse(headerBytes.toString('utf8')) as ArchiveHeader } catch { throw new Error('迁移包头不是有效 JSON') }
      if (header.type !== 'prism-workspace-migration' || header.schemaVersion !== 1 || header.cipher !== 'aes-256-gcm'
        || header.kdf?.name !== 'scrypt' || header.kdf.n !== SCRYPT_N || header.kdf.r !== SCRYPT_R || header.kdf.p !== SCRYPT_P
        || !Number.isInteger(header.profileCount) || header.profileCount < 1 || header.profileCount > MAX_PROFILES) throw new Error('迁移包版本或加密参数不受支持')
      payloadOffset = MAGIC.length + 4 + headerLength
      if (sourceInfo.size <= payloadOffset + AUTH_TAG_BYTES) throw new Error('迁移包缺少加密内容')
      authTag = Buffer.alloc(AUTH_TAG_BYTES)
      await readExactAt(handle, authTag, sourceInfo.size - AUTH_TAG_BYTES)
    } finally { await handle.close() }
    const salt = Buffer.from(header!.kdf.salt, 'base64'); const nonce = Buffer.from(header!.nonce, 'base64'); const expectedCheck = Buffer.from(header!.keyCheck, 'base64')
    if (salt.length !== 16 || nonce.length !== 12 || expectedCheck.length !== 16) throw new Error('迁移包加密参数无效')
    const key = await deriveKey(password, salt)
    if (!timingSafeEqual(keyCheck(key), expectedCheck)) { key.fill(0); throw new Error('迁移密码错误') }
    const staging = await mkdtemp(join(this.profiles.vaultPath, '.migration-import-'))
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(headerBytes!); decipher.setAuthTag(authTag!)
    const reader = new DecryptedReader(createReadStream(source, { start: payloadOffset!, end: sourceInfo.size - AUTH_TAG_BYTES - 1 }).pipe(decipher))
    let manifest: ArchiveManifest; let fileCount = 0; let totalBytes = 0
    const digest = createHash('sha256')
    try {
      const first = await readRecordHeader(reader)
      if (first.type !== 'manifest' || !Number.isSafeInteger(first.size) || first.size! < 1 || first.size! > MAX_MANIFEST_BYTES) throw new Error('迁移包缺少有效清单')
      try { manifest = validateManifest(JSON.parse((await reader.readExactly(first.size!)).toString('utf8'))) } catch (error) {
        if (error instanceof SyntaxError) throw new Error('迁移包清单不是有效 JSON'); throw error
      }
      if (manifest.profiles.length !== header!.profileCount) throw new Error('迁移包环境数量与包头不一致')
      while (true) {
        const record = await readRecordHeader(reader)
        if (record.type === 'end') {
          if (record.fileCount !== fileCount || record.totalBytes !== totalBytes || record.contentSha256 !== digest.digest('hex')) throw new Error('迁移包内容摘要不一致，文件可能已损坏')
          break
        }
        if (record.type !== 'file' || typeof record.path !== 'string' || !Number.isSafeInteger(record.size) || record.size! < 0) throw new Error('迁移包文件记录无效')
        fileCount += 1; totalBytes += record.size!
        if (fileCount > MAX_FILES || totalBytes > MAX_BYTES) throw new Error('迁移包内容超过安全限制')
        digest.update(record.path).update('\0').update(String(record.size)).update('\0')
        await reader.copyExactly(record.size!, safeArchivePath(staging, record.path), digest)
      }
      await reader.ensureEnd()
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if ((error as Error).message.includes('authenticate data')) throw new Error('迁移密码错误或迁移包已损坏')
      throw error
    } finally { key.fill(0) }

    const usedNames = new Set(this.profiles.list().map((profile) => profile.name))
    let renamedCount = 0; let skippedCount = 0
    const selected = manifest!.profiles.flatMap((item) => {
      if (usedNames.has(item.profile.name) && conflictPolicy === 'skip') { skippedCount += 1; return [] }
      const name = uniqueName(item.profile.name, usedNames)
      if (name !== item.profile.name) renamedCount += 1
      return [{ ...item, profile: { ...item.profile, name } }]
    })
    const referencedExtensions = new Set(selected.flatMap((item) => item.profile.extensionIds))
    const extensionMap = new Map<string, string>(); const importedExtensionIds: string[] = []; const createdProfiles: BrowserProfile[] = []
    try {
      for (const extension of manifest!.extensions.filter((item) => referencedExtensions.has(item.sourceId))) {
        const imported = await this.extensions.importDirectory(join(staging, 'extensions', extension.sourceId))
        extensionMap.set(extension.sourceId, imported.id); importedExtensionIds.push(imported.id)
      }
      const drafts = selected.map((item) => validateProfileDraft({ ...item.profile, extensionIds: item.profile.extensionIds.map((id) => {
        const mapped = extensionMap.get(id); if (!mapped) throw new Error('迁移扩展映射不完整'); return mapped
      }) }))
      if (drafts.length) createdProfiles.push(...await this.profiles.createMany(drafts))
      for (let index = 0; index < createdProfiles.length; index++) {
        const profile = createdProfiles[index]
        const stagedData = join(staging, 'profiles', selected[index].sourceId, 'user-data')
        await mkdir(stagedData, { recursive: true })
        const target = this.profiles.profileDataPath(profile.id); const empty = `${target}.empty-${randomUUID()}`
        await rename(target, empty)
        try { await rename(stagedData, target); await rm(empty, { recursive: true, force: true }) }
        catch (error) { await rename(empty, target).catch(() => undefined); throw error }
        await this.profiles.assertProfileDataIdentity(profile.id)
        if (selected[index].favorite) await this.profiles.setFavorite(profile.id, true)
      }
      this.logger?.info('全部环境加密迁移包已导入', { importedCount: createdProfiles.length, skippedCount, renamedCount, fileCount, totalBytes })
      return { path: source, profileCount: manifest!.profiles.length, importedCount: createdProfiles.length, skippedCount, renamedCount, extensionCount: importedExtensionIds.length, totalBytes, fileCount }
    } catch (error) {
      for (const profile of createdProfiles.reverse()) {
        await this.profiles.remove(profile.id).catch(() => undefined)
        const item = (await this.profiles.listTrash().catch(() => [])).find((candidate) => candidate.profileId === profile.id)
        if (item) await this.profiles.purgeTrash(item.trashId).catch(() => undefined)
      }
      await this.extensions.rollbackMigrationImports(importedExtensionIds)
      throw error
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
}
