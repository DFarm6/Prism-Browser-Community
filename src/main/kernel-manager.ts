import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'
import type { EngineStatus, KernelHealth, KernelInstallProgress, KernelRelease } from '../shared/types'
import { locateBrowser, locateBrowserSelection, normalizeBrowserSelection } from './browser-locator'
import {
  collectKernelIntegrity,
  kernelPayloadIdentity,
  validateKernelIntegrityFields,
  verifyKernelIntegrity,
  type KernelIntegrityFields
} from './kernel-integrity'
import type { SettingsStore } from './settings-store'
import type { Logger } from './app-logger'
import type { AppSettings } from '../shared/types'
import { kernelRequiresPro } from '../shared/kernel-policy'

const execFileAsync = promisify(execFile)
const RELEASES_URL = 'https://api.github.com/repos/adryfish/fingerprint-chromium/releases?per_page=10'

interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
  digest: string | null
}

interface GithubRelease {
  tag_name: string
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

interface InstalledKernelManifest extends KernelIntegrityFields {
  schemaVersion?: 1 | 2
  version: string
  assetName: string
  sha256: string
  installedAt: string
  executableRelative: string
  executableSha256?: string
  executableSize?: number
  source?: 'release' | 'local-build'
  target?: string
}

interface KernelActivationBackup {
  schemaVersion: 1
  recordedAt: string
  settings: AppSettings
}

function supportedAsset(assets: GithubAsset[]): GithubAsset | undefined {
  if (process.platform === 'darwin') return assets.find((asset) => asset.name.endsWith('_macos.dmg'))
  if (process.platform === 'win32') return assets.find((asset) => asset.name.endsWith('_windows_x64.zip'))
  return undefined
}

function safeVersion(version: string): string {
  if (!/^\d+(?:\.\d+){3}$/.test(version)) throw new Error('内核版本号无效')
  return version
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findEntry(root: string, predicate: (name: string) => boolean, depth = 4): Promise<string | undefined> {
  if (depth < 0) return undefined
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (predicate(entry.name)) return path
    if (entry.isDirectory()) {
      const nested = await findEntry(path, predicate, depth - 1)
      if (nested) return nested
    }
  }
  return undefined
}

export class KernelManager {
  private installingVersion: string | null = null
  private installAbort: AbortController | null = null
  private canUseProKernel: () => boolean = () => true

  constructor(
    private readonly vaultPath: string,
    private readonly settings: SettingsStore,
    private readonly onProgress: (progress: KernelInstallProgress) => void,
    private readonly logger?: Logger,
    private readonly kernelUsers: (version: string) => string[] | Promise<string[]> = () => []
  ) {}

  setProKernelAccessCheck(check: () => boolean): void {
    this.canUseProKernel = check
  }

  private assertKernelEntitlement(version: string): void {
    if (kernelRequiresPro(version) && !this.canUseProKernel()) {
      throw new Error(`Chromium ${version} 是 Prism Pro 内核，请先激活 Pro`)
    }
  }

  async installed(): Promise<KernelRelease[]> {
    const manifests = await this.installedManifests()
    const releases: KernelRelease[] = []
    for (const manifest of manifests.values()) {
      if (manifest.target && manifest.target !== `${process.platform}-${process.arch}`) continue
      const executable = join(this.kernelPath(manifest.version), manifest.executableRelative)
      if (!await pathExists(executable)) continue
      releases.push({
        version: manifest.version,
        publishedAt: manifest.installedAt,
        assetName: manifest.assetName,
        downloadUrl: '',
        size: 0,
        sha256: manifest.sha256,
        installed: true,
        remoteAvailable: false,
        origin: manifest.source ?? 'release',
        executable
      })
    }
    return releases.sort((first, second) => second.version.localeCompare(first.version, undefined, { numeric: true }))
  }

  async releases(): Promise<KernelRelease[]> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error('当前只支持自动安装 macOS 和 Windows 内核')
    }
    const installed = await this.installedManifests()
    let releases: GithubRelease[]
    try {
      const response = await fetch(RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Prism-Browser/0.1' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`获取内核版本失败（GitHub HTTP ${response.status}）`)
      releases = await response.json() as GithubRelease[]
    } catch (error) {
      if (installed.size === 0) throw error
      this.logger?.error('获取远程内核版本失败，展示本地版本', error)
      releases = []
    }

    const remote = releases
      .filter((release) => !release.draft && !release.prerelease)
      .flatMap((release) => {
        const asset = supportedAsset(release.assets)
        const digest = asset?.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : ''
        if (!asset || !digest) return []
        const manifest = installed.get(release.tag_name)
        return [{
          version: release.tag_name,
          publishedAt: release.published_at,
          assetName: asset.name,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          sha256: digest,
          installed: Boolean(manifest),
          remoteAvailable: true,
          origin: manifest?.source ?? 'release',
          executable: manifest ? join(this.kernelPath(release.tag_name), manifest.executableRelative) : undefined
        } satisfies KernelRelease]
      })
    const remoteVersions = new Set(remote.map((release) => release.version))
    const localOnly = [...installed.values()]
      .filter((manifest) => !remoteVersions.has(manifest.version))
      .map((manifest) => ({
        version: manifest.version,
        publishedAt: manifest.installedAt,
        assetName: manifest.assetName,
        downloadUrl: '',
        size: 0,
        sha256: manifest.sha256,
        installed: true,
        remoteAvailable: false,
        origin: manifest.source ?? 'release',
        executable: join(this.kernelPath(manifest.version), manifest.executableRelative)
      } satisfies KernelRelease))
    return [...remote, ...localOnly]
  }

  async install(versionInput: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    this.assertKernelEntitlement(version)
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    const existing = await this.readManifest(version)
    if (existing) return this.activate(version)

    const release = (await this.releases()).find((item) => item.version === version)
    if (!release) throw new Error('没有找到适用于当前系统的内核发行包')
    this.validateRelease(release)
    this.installingVersion = version
    this.installAbort = new AbortController()

    const downloadsPath = join(this.vaultPath, 'downloads')
    const kernelsPath = join(this.vaultPath, 'kernels')
    await Promise.all([mkdir(downloadsPath, { recursive: true }), mkdir(kernelsPath, { recursive: true })])
    const archivePath = join(downloadsPath, `${version}-${basename(release.assetName)}.download`)

    try {
      await this.assertDownloadSpace(downloadsPath, archivePath, release.size)
      await this.download(release, archivePath)
      this.emit(release, 'installing', release.size, release.size, '正在安装浏览器内核…')
      const manifest = process.platform === 'darwin'
        ? await this.installMac(release, archivePath)
        : await this.installWindows(release, archivePath)
      await rm(archivePath, { force: true })
      await this.rememberPreviousKernel(join(this.kernelPath(version), manifest.executableRelative))
      await this.settings.update({
        browserExecutable: join(this.kernelPath(version), manifest.executableRelative),
        fingerprintKernel: true,
        enginePreference: 'auto'
      })
      this.logger?.info('浏览器内核安装完成', { version })
      this.emit(release, 'ready', release.size, release.size, '内核安装完成')
      return locateBrowser(this.settings)
    } catch (error) {
      const cancelled = this.installAbort.signal.aborted
      const message = cancelled ? '下载已取消，可稍后从断点继续' : error instanceof Error ? error.message : String(error)
      this.emit(release, cancelled ? 'cancelled' : 'error', 0, release.size, message)
      throw new Error(message)
    } finally {
      this.installingVersion = null
      this.installAbort = null
    }
  }

  async importLocal(selection: string): Promise<EngineStatus> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error('当前只支持导入 macOS 和 Windows 本地内核')
    }
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    const executable = await normalizeBrowserSelection(selection)
    const { version, sourceRoot, executableRelative } = await this.inspectLocalBuild(executable)
    this.assertKernelEntitlement(version)
    const destination = this.kernelPath(version)
    const existing = await this.readManifest(version)
    if (existing) {
      const sourceIntegrityRoot = process.platform === 'darwin' ? dirname(sourceRoot) : sourceRoot
      const sourceExecutableRelative = process.platform === 'darwin'
        ? join(basename(sourceRoot), 'Contents', 'MacOS', basename(executable))
        : basename(executable)
      const [existingIntegrity, sourceIntegrity] = await Promise.all([
        collectKernelIntegrity(destination, existing.executableRelative),
        collectKernelIntegrity(sourceIntegrityRoot, sourceExecutableRelative)
      ])
      if (existing.source === 'local-build'
        && kernelPayloadIdentity(existingIntegrity, existing.executableRelative)
          === kernelPayloadIdentity(sourceIntegrity, sourceExecutableRelative)) {
        if (!existing.criticalFiles || !existing.criticalFilesSha256) {
          const upgraded: InstalledKernelManifest = { ...existing, schemaVersion: 2, ...existingIntegrity }
          await writeFile(join(destination, 'manifest.json'), JSON.stringify(upgraded, null, 2), { mode: 0o600 })
          this.logger?.info('本地内核完整性清单已升级', { version, files: existingIntegrity.criticalFiles.length })
        }
        return this.activate(version)
      }
      throw new Error(`内核 ${version} 已存在且内容不同，请先切换并移除旧版本`)
    }
    if (await pathExists(destination)) throw new Error(`内核目录 ${version} 已存在但缺少有效清单，请先人工检查`)

    const kernelsPath = join(this.vaultPath, 'kernels')
    await mkdir(kernelsPath, { recursive: true })
    const root = await mkdtemp(join(kernelsPath, `.import-${version}-`))
    const stagingPath = join(root, 'staging')
    await mkdir(stagingPath)
    try {
      if (process.platform === 'darwin') {
        await execFileAsync('ditto', [sourceRoot, join(stagingPath, 'Chromium.app')])
      } else {
        await cp(sourceRoot, join(stagingPath, 'browser'), { recursive: true })
      }
      const importedExecutable = join(stagingPath, executableRelative)
      const info = await stat(importedExecutable)
      if (!info.isFile() || info.size <= 0) throw new Error('导入后的浏览器可执行文件无效')
      const integrity = await collectKernelIntegrity(stagingPath, executableRelative)
      const normalizedExecutableRelative = executableRelative.split(sep).join('/')
      const executableRecord = integrity.criticalFiles.find((file) => file.path === normalizedExecutableRelative)
      if (!executableRecord) throw new Error('内核完整性清单缺少浏览器入口')
      const manifest: InstalledKernelManifest = {
        schemaVersion: 2,
        version,
        assetName: `local-build-${process.platform}-${process.arch}`,
        sha256: executableRecord.sha256,
        installedAt: new Date().toISOString(),
        executableRelative,
        executableSha256: executableRecord.sha256,
        executableSize: executableRecord.size,
        ...integrity,
        source: 'local-build',
        target: `${process.platform}-${process.arch}`
      }
      await writeFile(join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await rename(stagingPath, destination)
      await this.rememberPreviousKernel(join(destination, executableRelative))
      await this.settings.update({ browserExecutable: join(destination, executableRelative), fingerprintKernel: true, enginePreference: 'auto' })
      this.logger?.info('本地构建内核已导入并启用', { version, target: manifest.target })
      return locateBrowser(this.settings)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  cancel(versionInput: string): void {
    const version = safeVersion(versionInput)
    if (this.installingVersion !== version || !this.installAbort) throw new Error('该内核当前没有正在进行的安装任务')
    this.installAbort.abort()
  }

  async activate(versionInput: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    this.assertKernelEntitlement(version)
    const manifest = await this.readManifest(version)
    if (!manifest) throw new Error('该内核尚未安装')
    const executable = join(this.kernelPath(version), manifest.executableRelative)
    if (!await pathExists(executable)) throw new Error('内核文件不完整，请重新安装')
    const integrity = await verifyKernelIntegrity(this.kernelPath(version), manifest.executableRelative, manifest)
    if (integrity.status === 'corrupt') throw new Error(`内核完整性校验失败：${integrity.reason}`)
    await this.rememberPreviousKernel(executable)
    await this.settings.update({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
    this.logger?.info('浏览器内核已切换', { version })
    return locateBrowser(this.settings)
  }

  async configure(patch: Pick<AppSettings, 'browserExecutable' | 'fingerprintKernel' | 'enginePreference'>, resolvedExecutable = patch.browserExecutable): Promise<EngineStatus> {
    if (patch.fingerprintKernel && resolvedExecutable) {
      const { version } = await this.inspectLocalBuild(resolvedExecutable)
      this.assertKernelEntitlement(version)
    }
    await this.rememberPreviousKernel(resolvedExecutable)
    await this.settings.update(patch)
    return locateBrowser(this.settings)
  }

  async rollbackAvailable(): Promise<boolean> {
    try {
      const backup = await this.readActivationBackup()
      if (!backup) return false
      await this.assertRollbackCandidate(backup.settings)
      return true
    } catch {
      return false
    }
  }

  async rollback(): Promise<EngineStatus> {
    const backup = await this.readActivationBackup()
    if (!backup) throw new Error('没有可回滚的上一个内核')
    const current = this.settings.get()
    const previous = backup.settings
    await this.assertRollbackCandidate(previous)
    try {
      await this.settings.update(previous)
      const engine = await locateBrowser(this.settings)
      if (!engine.executable) throw new Error('上一个内核当前不可用')
      await rm(this.activationBackupPath(), { force: true })
      this.logger?.info('已回滚到上一个浏览器内核', { engine: engine.label, version: engine.version })
      return engine
    } catch (error) {
      await this.settings.update(current)
      throw error
    }
  }

  async verify(versionInput: string): Promise<KernelHealth> {
    const version = safeVersion(versionInput)
    const checkedAt = new Date().toISOString()
    try {
      const manifest = await this.readManifest(version)
      if (!manifest) return { version, status: 'corrupt', message: '内核文件不完整，请重新导入或安装新版 Prism Browser', checkedAt }
      const executable = join(this.kernelPath(version), manifest.executableRelative)
      const info = await stat(executable)
      if (!info.isFile() || info.size <= 0) return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版 Prism Browser', checkedAt }
      const integrity = await verifyKernelIntegrity(this.kernelPath(version), manifest.executableRelative, manifest)
      if (integrity.status === 'corrupt') {
        this.logger?.error('浏览器内核完整性检查失败', { version, reason: integrity.reason })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版 Prism Browser', checkedAt }
      }
      if (integrity.status === 'healthy') {
        return {
          version,
          status: 'healthy',
          message: '内核完整性正常',
          checkedAt
        }
      }
      if (!manifest.executableSha256 || !manifest.executableSize) {
        this.logger?.info('浏览器内核无法完成完整性检查', { version, reason: integrity.reason })
        return { version, status: 'unverified', message: '当前内核无法完成完整检查，建议重新导入或安装新版 Prism Browser', checkedAt }
      }
      if (info.size !== manifest.executableSize) {
        this.logger?.error('浏览器内核入口大小异常', { version, expected: manifest.executableSize, actual: info.size })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版 Prism Browser', checkedAt }
      }
      const actual = await this.hashFile(executable)
      if (actual !== manifest.executableSha256) {
        this.logger?.error('浏览器内核入口摘要与安装记录不一致', { version })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版 Prism Browser', checkedAt }
      }
      return { version, status: 'unverified', message: '当前内核无法完成完整检查，建议重新导入或安装新版 Prism Browser', checkedAt }
    } catch (error) {
      return { version, status: 'corrupt', message: error instanceof Error ? error.message : String(error), checkedAt }
    }
  }

  async repair(versionInput: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    const release = (await this.releases()).find((item) => item.version === version && item.remoteAvailable)
    if (!release) throw new Error('远程发行源中已找不到该版本，无法重新安装')
    this.validateRelease(release)
    const currentPath = this.kernelPath(version)
    const recycleRoot = join(this.vaultPath, 'recycle-bin', 'kernels')
    const backupPath = join(recycleRoot, `${version}-before-repair-${Date.now()}`)
    const previousSettings = this.settings.get()
    const repairedWasActive = Boolean(previousSettings.browserExecutable)
      && resolve(previousSettings.browserExecutable).startsWith(`${resolve(currentPath)}${sep}`)
    await mkdir(recycleRoot, { recursive: true })
    await rename(currentPath, backupPath)
    try {
      let engine = await this.install(version)
      if (!repairedWasActive) {
        await this.settings.update(previousSettings)
        engine = await locateBrowser(this.settings)
      }
      this.logger?.info('浏览器内核已重新安装并通过发行包校验', { version })
      return engine
    } catch (error) {
      await rm(currentPath, { recursive: true, force: true })
      await rename(backupPath, currentPath)
      this.logger?.error('浏览器内核重新安装失败，已恢复原目录', { version, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async remove(versionInput: string): Promise<void> {
    const version = safeVersion(versionInput)
    if (this.installingVersion === version) throw new Error('正在安装的内核不能删除')
    const manifest = await this.readManifest(version)
    if (!manifest) throw new Error('该内核尚未安装')
    const users = await this.kernelUsers(version)
    if (users.length) {
      const preview = users.slice(0, 3).map((name) => `“${name}”`).join('、')
      throw new Error(`该内核仍被 ${users.length} 个环境固定使用（${preview}${users.length > 3 ? '等' : ''}），请先修改这些环境`)
    }
    const executable = join(this.kernelPath(version), manifest.executableRelative)
    const configured = this.settings.get().browserExecutable
    if (configured && resolve(configured) === resolve(executable)) {
      throw new Error('当前正在使用该内核，请先切换到其他版本')
    }
    const recycle = join(this.vaultPath, 'recycle-bin', 'kernels')
    await mkdir(recycle, { recursive: true })
    await rename(this.kernelPath(version), join(recycle, `${version}-${Date.now()}`))
    this.logger?.info('浏览器内核已移入回收目录', { version })
  }

  private async download(release: KernelRelease, destination: string, allowRangeReset = true): Promise<void> {
    let existingBytes = await stat(destination).then((info) => info.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0
      throw error
    })
    if (existingBytes > release.size) {
      await rm(destination, { force: true })
      existingBytes = 0
    }
    if (existingBytes === release.size) {
      const existingHash = createHash('sha256')
      for await (const chunk of createReadStream(destination)) existingHash.update(chunk as Buffer)
      this.emit(release, 'verifying', existingBytes, release.size, '正在校验已下载的内核文件…')
      if (existingHash.digest('hex') === release.sha256.toLowerCase()) return
      await rm(destination, { force: true })
      existingBytes = 0
    }
    const headers: Record<string, string> = {
      accept: 'application/octet-stream',
      'user-agent': 'Prism-Browser/0.1'
    }
    if (existingBytes > 0 && existingBytes < release.size) headers.range = `bytes=${existingBytes}-`
    const response = await fetch(release.downloadUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.any([AbortSignal.timeout(15 * 60_000), this.installAbort?.signal ?? new AbortController().signal])
    })
    if (response.status === 416 && existingBytes > 0 && allowRangeReset) {
      await rm(destination, { force: true })
      return this.download(release, destination, false)
    }
    if (!response.ok || !response.body) throw new Error(`内核下载失败（HTTP ${response.status}）`)

    let resumedBytes = 0
    let writeFlags: 'a' | 'w' = 'w'
    if (existingBytes > 0 && response.status === 206) {
      const rangeStart = Number(response.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1])
      if (rangeStart !== existingBytes) throw new Error('内核下载服务器返回了无效的断点范围')
      resumedBytes = existingBytes
      writeFlags = 'a'
    }

    const hash = createHash('sha256')
    if (resumedBytes) {
      for await (const chunk of createReadStream(destination)) hash.update(chunk as Buffer)
    }
    let received = resumedBytes
    let lastReport = 0
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        hash.update(chunk)
        const now = Date.now()
        if (now - lastReport > 200) {
          lastReport = now
          this.emit(release, 'downloading', received, release.size, resumedBytes ? '正在从断点继续下载…' : '正在下载浏览器内核…')
        }
        callback(null, chunk)
      }
    })
    const source = Readable.from(response.body as unknown as AsyncIterable<Uint8Array>)
    this.emit(release, 'downloading', received, release.size, resumedBytes ? '正在从断点继续下载…' : '正在下载浏览器内核…')
    await pipeline(source, progress, createWriteStream(destination, { flags: writeFlags, mode: 0o600 }))
    if (received !== release.size) throw new Error(`内核下载不完整：期望 ${release.size} 字节，实际 ${received} 字节`)
    this.emit(release, 'verifying', received, release.size, '正在校验 SHA-256…')
    const actual = hash.digest('hex')
    if (actual !== release.sha256.toLowerCase()) {
      await rm(destination, { force: true })
      throw new Error(`SHA-256 校验失败：期望 ${release.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
  }

  private async assertDownloadSpace(downloadsPath: string, destination: string, totalBytes: number): Promise<void> {
    const existingBytes = await stat(destination).then((info) => Math.min(info.size, totalBytes)).catch(() => 0)
    const remainingBytes = Math.max(0, totalBytes - existingBytes)
    const fileSystem = await statfs(downloadsPath)
    const availableBytes = fileSystem.bavail * fileSystem.bsize
    const reserveBytes = 512 * 1024 * 1024
    if (availableBytes < remainingBytes + reserveBytes) {
      throw new Error(`磁盘空间不足：下载至少还需要 ${Math.ceil((remainingBytes + reserveBytes) / 1024 / 1024)} MB 可用空间`)
    }
  }

  private async installMac(release: KernelRelease, archivePath: string): Promise<InstalledKernelManifest> {
    const root = await mkdtemp(join(this.vaultPath, 'kernels', `.install-${release.version}-`))
    const mountPath = join(root, 'mount')
    const stagingPath = join(root, 'staging')
    await Promise.all([mkdir(mountPath), mkdir(stagingPath)])
    let mounted = false
    try {
      await execFileAsync('hdiutil', ['attach', archivePath, '-nobrowse', '-readonly', '-mountpoint', mountPath])
      mounted = true
      const appBundle = await findEntry(mountPath, (name) => name.endsWith('.app'), 2)
      if (!appBundle) throw new Error('DMG 中没有找到 Chromium.app')
      const targetApp = join(stagingPath, 'Chromium.app')
      await execFileAsync('ditto', [appBundle, targetApp])
      const executable = join(targetApp, 'Contents', 'MacOS', 'Chromium')
      if (!await pathExists(executable)) throw new Error('Chromium.app 内缺少可执行文件')
      const manifest = await this.createManifest(release, stagingPath, relative(stagingPath, executable))
      await writeFile(join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await rename(stagingPath, this.kernelPath(release.version))
      return manifest
    } finally {
      if (mounted) await execFileAsync('hdiutil', ['detach', mountPath, '-force']).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }

  private async installWindows(release: KernelRelease, archivePath: string): Promise<InstalledKernelManifest> {
    const root = await mkdtemp(join(this.vaultPath, 'kernels', `.install-${release.version}-`))
    const extracted = join(root, 'extracted')
    const stagingPath = join(root, 'staging')
    await Promise.all([mkdir(extracted), mkdir(stagingPath)])
    try {
      const command = `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
      const chrome = await findEntry(extracted, (name) => name.toLowerCase() === 'chrome.exe')
      if (!chrome) throw new Error('ZIP 中没有找到 chrome.exe')
      const browserPath = join(stagingPath, 'browser')
      await cp(dirname(chrome), browserPath, { recursive: true })
      const executable = join(browserPath, 'chrome.exe')
      const manifest = await this.createManifest(release, stagingPath, relative(stagingPath, executable))
      await writeFile(join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await rename(stagingPath, this.kernelPath(release.version))
      return manifest
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  private async createManifest(release: KernelRelease, root: string, executableRelative: string): Promise<InstalledKernelManifest> {
    const executable = join(root, executableRelative)
    const executableInfo = await stat(executable)
    const integrity = await collectKernelIntegrity(root, executableRelative)
    return {
      schemaVersion: 2,
      version: release.version,
      assetName: release.assetName,
      sha256: release.sha256,
      installedAt: new Date().toISOString(),
      executableRelative,
      executableSha256: await this.hashFile(executable),
      executableSize: executableInfo.size,
      ...integrity,
      source: 'release',
      target: `${process.platform}-${process.arch}`
    }
  }

  private async inspectLocalBuild(executable: string): Promise<{ version: string; sourceRoot: string; executableRelative: string }> {
    if (process.platform === 'darwin') {
      let sourceRoot = dirname(resolve(executable))
      while (!sourceRoot.endsWith('.app')) {
        const parent = dirname(sourceRoot)
        if (parent === sourceRoot) throw new Error('所选文件不在 macOS .app 浏览器包中')
        sourceRoot = parent
      }
      const plist = join(sourceRoot, 'Contents', 'Info.plist')
      const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])
      const version = safeVersion(stdout.trim())
      return { version, sourceRoot, executableRelative: join('Chromium.app', 'Contents', 'MacOS', basename(executable)) }
    }

    const escaped = executable.replaceAll("'", "''")
    const command = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
    const match = stdout.match(/\d+(?:\.\d+){3}/)
    if (!match) throw new Error('无法从 chrome.exe 读取四段式 Chromium 版本')
    return { version: safeVersion(match[0]), sourceRoot: dirname(executable), executableRelative: join('browser', 'chrome.exe') }
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  private activationBackupPath(): string {
    return join(this.vaultPath, 'kernels', 'activation-backup.json')
  }

  private async rememberPreviousKernel(nextExecutable: string): Promise<void> {
    const previous = this.settings.get()
    if (previous.browserExecutable && resolve(previous.browserExecutable) === resolve(nextExecutable)) return
    await mkdir(join(this.vaultPath, 'kernels'), { recursive: true })
    const backup: KernelActivationBackup = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      settings: previous
    }
    await writeFile(this.activationBackupPath(), JSON.stringify(backup, null, 2), { mode: 0o600 })
  }

  private async readActivationBackup(): Promise<KernelActivationBackup | undefined> {
    try {
      const value = JSON.parse(await readFile(this.activationBackupPath(), 'utf8')) as Partial<KernelActivationBackup>
      if (value.schemaVersion !== 1 || typeof value.recordedAt !== 'string' || !value.settings
        || typeof value.settings.browserExecutable !== 'string'
        || typeof value.settings.fingerprintKernel !== 'boolean'
        || !['auto', 'bundled', 'system'].includes(value.settings.enginePreference)
        || ![0, 7, 30, 90].includes(value.settings.recycleRetentionDays)) {
        throw new Error('内核回滚记录无效')
      }
      return value as KernelActivationBackup
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async assertRollbackCandidate(previous: AppSettings): Promise<void> {
    if (!previous.browserExecutable) {
      const engine = await locateBrowserSelection(previous)
      if (!engine.executable) throw new Error('上一个内核选择当前不可用，无法回滚')
      return
    }
    if (!await pathExists(previous.browserExecutable)) throw new Error('上一个内核文件已经不存在，无法回滚')
    const kernelsRoot = resolve(this.vaultPath, 'kernels')
    const executable = resolve(previous.browserExecutable)
    if (!executable.startsWith(`${kernelsRoot}${sep}`)) return
    const version = relative(kernelsRoot, executable).split(sep)[0]
    const health = await this.verify(version)
    if (health.status === 'corrupt') throw new Error(`上一个内核健康检查失败：${health.message}`)
  }

  private validateRelease(release: KernelRelease): void {
    const url = new URL(release.downloadUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('内核下载地址不可信')
    if (!url.pathname.startsWith('/adryfish/fingerprint-chromium/releases/download/')) {
      throw new Error('内核下载地址不属于受信任仓库')
    }
    if (!/^[a-f\d]{64}$/i.test(release.sha256)) throw new Error('发行包缺少有效的 SHA-256')
    if (release.size < 10_000_000 || release.size > 800_000_000) throw new Error('发行包大小异常')
  }

  private kernelPath(version: string): string {
    return join(this.vaultPath, 'kernels', safeVersion(version))
  }

  private async readManifest(version: string): Promise<InstalledKernelManifest | undefined> {
    try {
      const manifest = JSON.parse(await readFile(join(this.kernelPath(version), 'manifest.json'), 'utf8')) as InstalledKernelManifest
      if (manifest.version !== version || typeof manifest.assetName !== 'string' || !/^[a-f\d]{64}$/i.test(manifest.sha256)
        || typeof manifest.installedAt !== 'string' || typeof manifest.executableRelative !== 'string') {
        throw new Error('内核清单字段无效')
      }
      const root = resolve(this.kernelPath(version))
      const executable = resolve(root, manifest.executableRelative)
      if (isAbsolute(manifest.executableRelative) || (executable !== root && !executable.startsWith(`${root}${sep}`))) {
        throw new Error('内核清单中的可执行文件路径越界')
      }
      if (manifest.executableSha256 !== undefined && !/^[a-f\d]{64}$/i.test(manifest.executableSha256)) {
        throw new Error('内核可执行文件摘要无效')
      }
      if (manifest.executableSize !== undefined && (!Number.isSafeInteger(manifest.executableSize) || manifest.executableSize <= 0)) {
        throw new Error('内核可执行文件大小无效')
      }
      if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
        throw new Error('内核清单版本无效')
      }
      if (manifest.schemaVersion === 2 && (!manifest.criticalFiles || !manifest.criticalFilesSha256)) {
        throw new Error('内核关键文件清单缺失')
      }
      const integrityError = validateKernelIntegrityFields(manifest, manifest.executableRelative)
      if (integrityError) throw new Error(integrityError)
      if (manifest.source !== undefined && manifest.source !== 'release' && manifest.source !== 'local-build') {
        throw new Error('内核来源字段无效')
      }
      if (manifest.target !== undefined && (typeof manifest.target !== 'string' || manifest.target.length > 64)) {
        throw new Error('内核目标平台字段无效')
      }
      return manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async installedManifests(): Promise<Map<string, InstalledKernelManifest>> {
    const result = new Map<string, InstalledKernelManifest>()
    const root = join(this.vaultPath, 'kernels')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const manifest = await this.readManifest(entry.name).catch(() => undefined)
      if (manifest) result.set(entry.name, manifest)
    }
    return result
  }

  private emit(
    release: KernelRelease,
    stage: KernelInstallProgress['stage'],
    receivedBytes: number,
    totalBytes: number,
    message: string
  ): void {
    this.onProgress({
      version: release.version,
      stage,
      receivedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, Math.round(receivedBytes / totalBytes * 100)) : 0,
      message
    })
  }
}
