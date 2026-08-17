import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnnouncementStatus, ProductAnnouncement } from '../shared/types'
import type { Logger } from './app-logger'
import { canonicalJson } from './license-crypto'
import { activationUrl, validateConfig } from './license-manager'

interface AnnouncementPayload extends ProductAnnouncement {
  schemaVersion: 1
  product: 'prism-browser-announcement'
}

interface SignedAnnouncement {
  payload: AnnouncementPayload
  signature: string
}

type FetchLike = typeof fetch
const MAX_RESPONSE_BYTES = 64 * 1024

function compareVersions(first: string, second: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const [core, prerelease = ''] = value.split('-', 2)
    return {
      core: core.split('.').map((item) => Number(item)),
      prerelease: prerelease ? prerelease.split('.') : []
    }
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < 3; index++) {
    if ((left.core[index] ?? 0) !== (right.core[index] ?? 0)) {
      return (left.core[index] ?? 0) - (right.core[index] ?? 0)
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) - Number(b)
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a.localeCompare(b)
  }
  return 0
}

function validateSignedAnnouncement(value: unknown, publicKey: string): ProductAnnouncement {
  const signed = value as Partial<SignedAnnouncement>
  const payload = signed?.payload as Partial<AnnouncementPayload> | undefined
  const action = payload?.action
  if (!payload || payload.schemaVersion !== 1 || payload.product !== 'prism-browser-announcement'
    || typeof payload.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(payload.id)
    || typeof payload.title !== 'string' || payload.title.length < 1 || payload.title.length > 120
    || typeof payload.body !== 'string' || payload.body.length < 1 || payload.body.length > 2000
    || !['info', 'warning', 'critical'].includes(payload.severity ?? '')
    || typeof payload.publishedAt !== 'string' || !Number.isFinite(Date.parse(payload.publishedAt))
    || (payload.expiresAt !== undefined
      && (typeof payload.expiresAt !== 'string' || !Number.isFinite(Date.parse(payload.expiresAt))))
    || !Array.isArray(payload.platforms) || payload.platforms.length === 0
    || payload.platforms.some((item) => !['all', 'darwin', 'win32'].includes(item))
    || (payload.minimumVersion !== undefined
      && (typeof payload.minimumVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(payload.minimumVersion)))
    || (payload.latestVersion !== undefined
      && (typeof payload.latestVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(payload.latestVersion)))
    || (payload.latestVersion !== undefined && action === undefined)
    || (action !== undefined && (!action || typeof action.label !== 'string' || action.label.length < 1
      || action.label.length > 40 || typeof action.url !== 'string'
      || new URL(action.url).protocol !== 'https:' || new URL(action.url).username || new URL(action.url).password))
    || typeof signed.signature !== 'string' || Buffer.from(signed.signature, 'base64').length !== 64
    || !verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(publicKey), Buffer.from(signed.signature, 'base64'))) {
    throw new Error('公告签名或字段无效')
  }
  const { schemaVersion: _schemaVersion, product: _product, ...announcement } = payload as AnnouncementPayload
  return structuredClone(announcement)
}

export class AnnouncementManager {
  private current: AnnouncementStatus = { state: 'disabled', message: '暂时无法检查更新' }

  constructor(
    private readonly resourcesPath: string,
    private readonly currentVersion: string,
    private readonly logger?: Logger,
    private readonly configOverride?: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = () => Date.now()
  ) {}

  status(): AnnouncementStatus {
    return structuredClone(this.current)
  }

  async check(): Promise<AnnouncementStatus> {
    try {
      const path = this.configOverride ?? join(this.resourcesPath, 'license-config.json')
      const config = validateConfig(JSON.parse(await readFile(path, 'utf8')))
      const response = await this.fetchImpl(activationUrl(config.activationBaseUrl, '/v1/announcements/current'), {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': `Prism-Browser/${this.currentVersion}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`公告服务返回 HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('公告响应过大')
      const text = await response.text()
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('公告响应过大')
      const envelope = JSON.parse(text)
      if (!envelope || envelope.schemaVersion !== 1) throw new Error('公告响应格式无效')
      if (envelope.announcement === null) {
        this.current = { state: 'none', message: '暂无公告' }
        return this.status()
      }
      const announcement = validateSignedAnnouncement(envelope.announcement, config.licensePublicKey)
      const compatible = announcement.platforms.includes('all')
        || announcement.platforms.includes(this.platform as 'darwin' | 'win32')
      const expired = announcement.expiresAt !== undefined && Date.parse(announcement.expiresAt) <= this.now()
      const updateCurrent = announcement.latestVersion !== undefined
        && compareVersions(this.currentVersion, announcement.latestVersion) >= 0
      const alreadyCurrent = announcement.latestVersion === undefined && announcement.minimumVersion !== undefined
        && compareVersions(this.currentVersion, announcement.minimumVersion) >= 0
      this.current = !compatible || expired || alreadyCurrent
        ? { state: 'none', message: '暂无适用于当前版本的公告' }
        : updateCurrent
          ? { state: 'current', message: '当前已是最新版本', announcement }
          : { state: 'available', message: announcement.title, announcement }
      return this.status()
    } catch (error) {
      this.logger?.error('检查产品公告失败', error)
      this.current = { state: 'error', message: error instanceof Error ? error.message : String(error) }
      return this.status()
    }
  }
}

export { compareVersions, validateSignedAnnouncement }
