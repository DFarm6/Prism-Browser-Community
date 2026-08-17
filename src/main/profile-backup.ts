import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BrowserProfile, ProfileBackupResult, ProfileDraft } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'

interface ProfileBackupManifest {
  schemaVersion: 1
  exportedAt: string
  sourcePlatform: NodeJS.Platform
  sourceAppVersion: string
  totalBytes: number
  fileCount: number
  contentSha256?: string
  profile: ProfileDraft
}

interface CopyStats {
  bytes: number
  files: number
  hash: Hash
}

const MAX_BACKUP_FILES = 1_000_000
const MAX_BACKUP_BYTES = 500 * 1024 * 1024 * 1024

function safeDirectoryName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 50)
  return safe || '环境'
}

function ensureOutside(source: string, target: string): void {
  const normalizedSource = resolve(source)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}${sep}`)) {
    throw new Error('备份目录不能位于当前环境数据目录内部')
  }
}

async function copySafeTree(source: string, target: string, stats: CopyStats, relativePath = ''): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    for (const entry of (await readdir(source)).sort()) {
      await copySafeTree(join(source, entry), join(target, entry), stats, join(relativePath, entry))
    }
    return
  }
  if (!info.isFile()) return
  stats.files += 1
  stats.bytes += info.size
  if (stats.files > MAX_BACKUP_FILES) throw new Error('环境数据文件数量超过 100 万，已停止备份')
  if (stats.bytes > MAX_BACKUP_BYTES) throw new Error('环境数据超过 500 GB，已停止备份')
  await copyFile(source, target)
  stats.hash.update(relativePath.replaceAll(sep, '/'))
  stats.hash.update('\0')
  stats.hash.update(String(info.size))
  stats.hash.update('\0')
  for await (const chunk of createReadStream(target)) stats.hash.update(chunk as Buffer)
}

function portableDraft(profile: BrowserProfile): ProfileDraft {
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: [],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    window: { ...profile.window },
    proxy: { ...profile.proxy, password: '', passwordStored: false },
    fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
  }
}

export class ProfileBackupManager {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly appVersion: string,
    private readonly logger?: Logger
  ) {}

  async export(profileId: string, destinationParent: string): Promise<ProfileBackupResult> {
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再备份完整数据')
    await this.profiles.assertProfileDataIdentity(profileId)
    const source = this.profiles.profileDataPath(profileId)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = join(resolve(destinationParent), `Prism Backup - ${safeDirectoryName(profile.name)} - ${stamp}`)
    const staging = `${target}.partial`
    ensureOutside(source, target)
    try {
      await stat(target)
      throw new Error('目标备份目录已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(staging, { recursive: false })
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    try {
      await copySafeTree(source, join(staging, 'user-data'), stats)
      const contentSha256 = stats.hash.digest('hex')
      const manifest: ProfileBackupManifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        sourcePlatform: process.platform,
        sourceAppVersion: this.appVersion,
        totalBytes: stats.bytes,
        fileCount: stats.files,
        contentSha256,
        profile: portableDraft(profile)
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.logger?.info('环境完整数据备份已导出', { profileId, bytes: stats.bytes, files: stats.files })
      return { path: target, totalBytes: stats.bytes, fileCount: stats.files }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async import(sourceInput: string): Promise<{ profile: BrowserProfile; result: ProfileBackupResult }> {
    const source = resolve(sourceInput)
    const manifestPath = join(source, 'manifest.json')
    if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('备份清单不能超过 1 MB')
    let manifest: ProfileBackupManifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileBackupManifest
    } catch {
      throw new Error('备份清单不是有效 JSON')
    }
    if (manifest.schemaVersion !== 1 || !manifest.profile || typeof manifest.totalBytes !== 'number' || typeof manifest.fileCount !== 'number') {
      throw new Error('不支持或不完整的 Prism 环境数据备份')
    }
    if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_BACKUP_BYTES
      || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > MAX_BACKUP_FILES) {
      throw new Error('备份清单中的数据大小或文件数量超出安全范围')
    }
    if (manifest.contentSha256 !== undefined && !/^[a-f\d]{64}$/i.test(manifest.contentSha256)) throw new Error('备份内容摘要无效')
    if (typeof manifest.profile.name !== 'string') throw new Error('备份中的环境名称无效')
    const userDataSource = join(source, 'user-data')
    const sourceInfo = await lstat(userDataSource)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('备份中的 user-data 目录无效')
    const draft = validateProfileDraft({
      ...manifest.profile,
      kernelVersion: typeof manifest.profile.kernelVersion === 'string' ? manifest.profile.kernelVersion : '',
      name: `${manifest.profile.name.slice(0, 53)}（迁移）`,
      extensionIds: [],
      proxy: { ...manifest.profile.proxy, password: '', passwordStored: false }
    })
    const stagingRoot = await mkdtemp(join(this.profiles.vaultPath, '.profile-backup-import-'))
    const staging = join(stagingRoot, 'user-data')
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    let profile: BrowserProfile | undefined
    try {
      ensureOutside(userDataSource, staging)
      await copySafeTree(userDataSource, staging, stats)
      if (stats.bytes !== manifest.totalBytes || stats.files !== manifest.fileCount) {
        throw new Error('备份数据数量与清单不一致，文件可能不完整')
      }
      const contentSha256 = stats.hash.digest('hex')
      if (manifest.contentSha256 && contentSha256 !== manifest.contentSha256) {
        throw new Error('备份内容 SHA-256 校验失败，文件可能已损坏或被修改')
      }
      profile = await this.profiles.create(draft)
      const target = this.profiles.profileDataPath(profile.id)
      const empty = `${target}.empty-${randomUUID()}`
      await rename(target, empty)
      try {
        await rename(staging, target)
        await rm(empty, { recursive: true, force: true })
      } catch (error) {
        await rename(empty, target).catch(() => undefined)
        throw error
      }
      await this.profiles.assertProfileDataIdentity(profile.id)
      this.logger?.info('环境完整数据备份已导入', { profileId: profile.id, bytes: stats.bytes, files: stats.files })
      return { profile: this.profiles.get(profile.id), result: { path: source, totalBytes: stats.bytes, fileCount: stats.files } }
    } catch (error) {
      if (profile) {
        await this.profiles.remove(profile.id).catch(() => undefined)
        const item = (await this.profiles.listTrash().catch(() => [])).find((candidate) => candidate.profileId === profile!.id)
        if (item) await this.profiles.purgeTrash(item.trashId).catch(() => undefined)
      }
      throw error
    } finally { await rm(stagingRoot, { recursive: true, force: true }) }
  }
}
