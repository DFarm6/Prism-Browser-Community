import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type {
  AppUpdateArtifact,
  AppUpdateManifest,
  AppUpdateStatus,
  UpdateChannel,
  UpdateDistributionMode
} from '../shared/types'
import type { Logger } from './app-logger'

interface UpdateConfig {
  schemaVersion: 1
  channel: UpdateChannel
  distributionMode: UpdateDistributionMode
  manifestUrl: string
  publicKey: string
}

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function validVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

function compareVersions(first: string, second: string): number {
  const parse = (value: string) => {
    const [main, prerelease = ''] = value.split('-', 2)
    return { values: main.split('.').map(Number), prerelease }
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < 3; index++) {
    if (left.values[index] !== right.values[index]) return left.values[index] - right.values[index]
  }
  if (!left.prerelease && right.prerelease) return 1
  if (left.prerelease && !right.prerelease) return -1
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true })
}

function validateArtifact(value: unknown): AppUpdateArtifact {
  const artifact = value as Partial<AppUpdateArtifact>
  if (!artifact || typeof artifact !== 'object' || typeof artifact.url !== 'string'
    || new URL(artifact.url).protocol !== 'https:' || !Number.isSafeInteger(artifact.size)
    || artifact.size! <= 0 || artifact.size! > MAX_ARTIFACT_BYTES
    || typeof artifact.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(artifact.sha256)
    || !['dmg', 'exe'].includes(artifact.kind ?? '')) {
    throw new Error('更新产物字段无效')
  }
  return artifact as AppUpdateArtifact
}

export class UpdateManager {
  private current: AppUpdateStatus
  private candidate: { manifest: AppUpdateManifest; artifact: AppUpdateArtifact } | null = null

  constructor(
    private readonly vaultPath: string,
    private readonly currentVersion: string,
    private readonly resourcesPath: string,
    private readonly onChanged: (status: AppUpdateStatus) => void,
    private readonly logger?: Logger,
    private readonly configOverride?: string
  ) {
    this.current = {
      stage: 'disabled',
      currentVersion,
      channel: null,
      distributionMode: null,
      message: '当前构建未配置更新通道'
    }
  }

  status(): AppUpdateStatus {
    return { ...this.current }
  }

  async initialize(): Promise<AppUpdateStatus> {
    try {
      const config = await this.readConfig()
      this.setStatus({
        stage: 'current',
        currentVersion: this.currentVersion,
        channel: config.channel,
        distributionMode: config.distributionMode,
        message: config.distributionMode === 'internal-unsigned'
          ? '已连接内部未签名测试通道'
          : `已连接${config.channel === 'stable' ? '稳定' : '测试'}更新通道`
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.error('应用更新配置无效', error)
        this.setStatus({
          stage: 'error',
          currentVersion: this.currentVersion,
          channel: null,
          distributionMode: null,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return this.status()
  }

  async check(): Promise<AppUpdateStatus> {
    const config = await this.readConfig()
    try {
      const response = await fetch(config.manifestUrl, {
        headers: { accept: 'application/json', 'user-agent': `Prism-Browser/${this.currentVersion}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize > MAX_MANIFEST_BYTES) throw new Error('更新清单超过 256 KB')
      const text = await response.text()
      if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('更新清单超过 256 KB')
      const manifest = this.verifyManifest(JSON.parse(text), config)
      const artifact = validateArtifact(manifest.artifacts[`${process.platform}-${process.arch}`])
      if ((process.platform === 'darwin' && artifact.kind !== 'dmg')
        || (process.platform === 'win32' && artifact.kind !== 'exe')) {
        throw new Error('更新产物类型与当前系统不匹配')
      }
      this.candidate = compareVersions(manifest.version, this.currentVersion) > 0 ? { manifest, artifact } : null
      this.setStatus(this.candidate ? {
        stage: 'available',
        currentVersion: this.currentVersion,
        channel: config.channel,
        distributionMode: config.distributionMode,
        latestVersion: manifest.version,
        message: `发现新版本 ${manifest.version}`,
        notes: manifest.notes
      } : {
        stage: 'current',
        currentVersion: this.currentVersion,
        channel: config.channel,
        distributionMode: config.distributionMode,
        latestVersion: manifest.version,
        message: '当前已是最新版本'
      })
      return this.status()
    } catch (error) {
      this.logger?.error('检查应用更新失败', error)
      this.setStatus({
        stage: 'error',
        currentVersion: this.currentVersion,
        channel: config.channel,
        distributionMode: config.distributionMode,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async download(): Promise<AppUpdateStatus> {
    if (!this.candidate) await this.check()
    if (!this.candidate) return this.status()
    const { manifest, artifact } = this.candidate
    const downloads = join(this.vaultPath, 'downloads', 'app-updates')
    await mkdir(downloads, { recursive: true })
    const extension = artifact.kind
    const destination = join(downloads, `Prism-Browser-${manifest.version}-${process.platform}-${process.arch}.${extension}`)
    const temporary = `${destination}.download`
    await rm(temporary, { force: true })
    try {
      const response = await fetch(artifact.url, {
        headers: { accept: 'application/octet-stream', 'user-agent': `Prism-Browser/${this.currentVersion}` },
        signal: AbortSignal.timeout(30 * 60_000)
      })
      if (!response.ok || !response.body) throw new Error(`更新下载失败（HTTP ${response.status}）`)
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize && declaredSize !== artifact.size) throw new Error('更新文件大小与签名清单不一致')
      let received = 0
      let lastProgress = 0
      const digest = createHash('sha256')
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length
          if (received > artifact.size) {
            callback(new Error('更新下载内容超过签名清单声明的大小'))
            return
          }
          digest.update(chunk)
          const now = Date.now()
          if (now - lastProgress > 200) {
            lastProgress = now
            this.setStatus({
              stage: 'downloading',
              currentVersion: this.currentVersion,
              channel: manifest.channel,
              distributionMode: manifest.distributionMode,
              latestVersion: manifest.version,
              message: '正在下载更新…',
              progress: Math.min(100, Math.floor(received / artifact.size * 100))
            })
          }
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
        progress,
        createWriteStream(temporary, { mode: 0o600 })
      )
      if (received !== artifact.size) throw new Error(`更新下载不完整：期望 ${artifact.size} 字节，实际 ${received} 字节`)
      const actual = digest.digest('hex')
      if (actual !== artifact.sha256.toLowerCase()) throw new Error('更新文件 SHA-256 与签名清单不一致')
      await rename(temporary, destination)
      this.setStatus({
        stage: 'ready',
        currentVersion: this.currentVersion,
        channel: manifest.channel,
        distributionMode: manifest.distributionMode,
        latestVersion: manifest.version,
        message: manifest.distributionMode === 'internal-unsigned'
          ? '内部更新已验证；安装时操作系统仍会提示未签名'
          : '更新已验证，可以打开安装程序',
        progress: 100,
        downloadedPath: destination
      })
      return this.status()
    } catch (error) {
      await rm(temporary, { force: true })
      this.logger?.error('下载应用更新失败', error)
      this.setStatus({
        stage: 'error',
        currentVersion: this.currentVersion,
        channel: manifest.channel,
        distributionMode: manifest.distributionMode,
        latestVersion: manifest.version,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async downloadedPath(): Promise<string> {
    const path = this.current.downloadedPath
    if (!path || this.current.stage !== 'ready') throw new Error('还没有已验证的更新安装程序')
    const root = resolve(this.vaultPath, 'downloads', 'app-updates')
    const target = resolve(path)
    if (!target.startsWith(`${root}${sep}`)) throw new Error('更新安装程序路径无效')
    const info = await stat(target).catch(() => undefined)
    const artifact = this.candidate?.artifact
    if (!info?.isFile() || !artifact || info.size !== artifact.size) {
      await rm(target, { force: true })
      this.setStatus({
        stage: 'error',
        currentVersion: this.currentVersion,
        channel: this.current.channel,
        distributionMode: this.current.distributionMode,
        latestVersion: this.current.latestVersion,
        message: '下载的安装程序不完整，已删除，请重新下载'
      })
      throw new Error('更新安装程序已经不存在或大小发生变化')
    }
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer)
    if (digest.digest('hex') !== artifact.sha256.toLowerCase()) {
      await rm(target, { force: true })
      this.setStatus({
        stage: 'error',
        currentVersion: this.currentVersion,
        channel: this.current.channel,
        distributionMode: this.current.distributionMode,
        latestVersion: this.current.latestVersion,
        message: '下载的安装程序已损坏，已删除，请重新下载'
      })
      throw new Error('更新安装程序在打开前校验失败')
    }
    return target
  }

  private verifyManifest(value: unknown, config: UpdateConfig): AppUpdateManifest {
    const manifest = value as Partial<AppUpdateManifest>
    if (!manifest || manifest.schemaVersion !== 1 || manifest.channel !== config.channel
      || manifest.distributionMode !== config.distributionMode
      || typeof manifest.version !== 'string' || !validVersion(manifest.version)
      || config.channel === 'stable' && manifest.version.includes('-')
      || typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))
      || typeof manifest.notes !== 'string' || manifest.notes.length > 20_000
      || !manifest.artifacts || typeof manifest.artifacts !== 'object'
      || typeof manifest.signature !== 'string') {
      throw new Error('更新清单字段无效')
    }
    const { signature, ...payload } = manifest
    const key = createPublicKey(config.publicKey)
    if (key.asymmetricKeyType !== 'ed25519'
      || !verifySignature(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signature, 'base64'))) {
      throw new Error('更新清单签名无效')
    }
    return manifest as AppUpdateManifest
  }

  private async readConfig(): Promise<UpdateConfig> {
    const path = this.configOverride ?? join(this.resourcesPath, 'update-config.json')
    await access(path)
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateConfig>
    if (value.schemaVersion !== 1 || !['stable', 'beta'].includes(value.channel ?? '')
      || !['signed', 'internal-unsigned'].includes(value.distributionMode ?? '')
      || value.distributionMode === 'internal-unsigned' && value.channel !== 'beta'
      || typeof value.manifestUrl !== 'string' || new URL(value.manifestUrl).protocol !== 'https:'
      || typeof value.publicKey !== 'string' || createPublicKey(value.publicKey).asymmetricKeyType !== 'ed25519') {
      throw new Error('应用更新配置无效')
    }
    return value as UpdateConfig
  }

  private setStatus(status: AppUpdateStatus): void {
    this.current = status
    this.onChanged(this.status())
  }
}

export { canonicalJson, compareVersions }
