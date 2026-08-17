import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LicenseStatus, ProEntitlement } from '../shared/types'
import type { Logger } from './app-logger'
import { DeviceIdentityStore, type DeviceKeyProtector } from './device-identity'
import {
  canonicalJson,
  verifyLicenseCertificate,
  type SignedLicenseCertificate
} from './license-crypto'

export interface LicenseConfig {
  schemaVersion: 1
  product: 'prism-pro'
  activationBaseUrl: string
  licensePublicKey: string
  agentReleasePublicKey?: string
}

interface ActivationChallenge {
  schemaVersion: 1
  challengeId: string
  nonce: string
  requestNonce: string
  expiresAt: string
}

interface ActivationCompleteResponse {
  schemaVersion: 1
  certificate: SignedLicenseCertificate
}

interface LeaseRefreshResponse {
  schemaVersion: 1
  certificate: SignedLicenseCertificate
}

interface DeactivationResponse {
  schemaVersion: 1
  deactivated: true
}

interface BindingStatusResponse {
  schemaVersion: 1
  active: true
  bindingGeneration: number
}

export interface ProAgentChallenge {
  schemaVersion: 1
  product: 'prism-pro-agent'
  protocolVersion: 1
  agentVersion: string
  nonce: string
  expiresAt: string
}

export interface ProAgentHandshake {
  schemaVersion: 1
  certificate: SignedLicenseCertificate
  devicePublicKey: string
  payload: {
    schemaVersion: 1
    product: 'prism-pro-agent'
    protocolVersion: 1
    agentVersion: string
    agentNonce: string
    deviceId: string
    appVersion: string
    requestNonce: string
    requestedAt: string
  }
  proof: string
}

type FetchLike = typeof fetch

const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const LEASE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60_000
const BINDING_MONITOR_INTERVAL_MS = 15 * 60_000

class LicenseHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'LicenseHttpError'
  }
}

function unavailableStatus(message: string): LicenseStatus {
  return {
    plan: 'community',
    state: 'unavailable',
    activationAvailable: false,
    message,
    entitlements: []
  }
}

function validateConfig(value: unknown): LicenseConfig {
  const config = value as Partial<LicenseConfig>
  const activationUrl = typeof config?.activationBaseUrl === 'string' ? new URL(config.activationBaseUrl) : null
  if (!config || config.schemaVersion !== 1 || config.product !== 'prism-pro'
    || !activationUrl || activationUrl.protocol !== 'https:' || activationUrl.username || activationUrl.password
    || activationUrl.search || activationUrl.hash
    || typeof config.licensePublicKey !== 'string'
    || createPublicKey(config.licensePublicKey).asymmetricKeyType !== 'ed25519'
    || (config.agentReleasePublicKey !== undefined
      && (typeof config.agentReleasePublicKey !== 'string' || createPublicKey(config.agentReleasePublicKey).asymmetricKeyType !== 'ed25519'))) {
    throw new Error('Prism Pro 激活配置无效')
  }
  return config as LicenseConfig
}

function activationUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const url = new URL(path.replace(/^\//, ''), normalized)
  if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:') throw new Error('激活服务地址无效')
  return url.toString()
}

function normalizedActivationCode(value: string): string {
  const code = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3,7}$/.test(code)) {
    throw new Error('激活码格式无效，请输入购买后获得的完整激活码')
  }
  return code
}

export class LicenseManager {
  private current: LicenseStatus = unavailableStatus('当前构建尚未配置 Prism Pro 激活服务')
  private config: LicenseConfig | null = null
  private readonly certificatePath: string
  private readonly identities: DeviceIdentityStore
  private leaseTimer: ReturnType<typeof setInterval> | null = null
  private refreshInFlight: Promise<LicenseStatus> | null = null
  private syncInFlight: Promise<LicenseStatus> | null = null

  constructor(
    vaultPath: string,
    private readonly resourcesPath: string,
    private readonly appVersion: string,
    protector: DeviceKeyProtector,
    private readonly onChanged: (status: LicenseStatus) => void,
    private readonly logger?: Logger,
    private readonly configOverride?: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly architecture: string = process.arch,
    private readonly now: () => number = Date.now
  ) {
    this.certificatePath = join(vaultPath, 'license', 'certificate.json')
    this.identities = new DeviceIdentityStore(vaultPath, protector)
  }

  status(): LicenseStatus {
    return { ...this.current, entitlements: [...this.current.entitlements] }
  }

  has(entitlement: ProEntitlement): boolean {
    return this.current.plan === 'pro' && this.current.entitlements.includes(entitlement)
  }

  async proAgentReleasePublicKey(): Promise<string> {
    const config = this.config ?? await this.readConfig()
    this.config = config
    if (!config.agentReleasePublicKey) throw new Error('当前构建未配置 Prism Pro Agent 发布公钥')
    return config.agentReleasePublicKey
  }

  async initialize(): Promise<LicenseStatus> {
    if (!['darwin', 'win32'].includes(this.platform)) {
      this.setStatus(unavailableStatus('Prism Pro 当前不支持此操作系统'))
      return this.status()
    }
    try {
      this.config = await this.readConfig()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.error('Prism Pro 激活配置不可用', error)
        this.setStatus({ ...unavailableStatus('Prism Pro 激活配置验证失败'), state: 'invalid' })
      }
      return this.status()
    }

    this.startLeaseMonitor()

    try {
      const certificate: unknown = JSON.parse(await readFile(this.certificatePath, 'utf8'))
      const identity = await this.identities.loadOrCreate()
      try {
        const verified = verifyLicenseCertificate(certificate, identity.deviceId, this.config.licensePublicKey, new Date(this.now()))
        this.setStatus(verified.status)
        if (this.leaseRefreshDue(verified.certificate)) {
          try {
            await this.refreshCertificate(verified.certificate)
          } catch (error) {
            this.logger?.error('Prism Pro 授权租约静默刷新失败，将在租约到期前继续重试', error)
          }
        }
      } catch (verificationError) {
        try {
          await this.refreshCertificate(certificate)
          this.logger?.info('Prism Pro 本地许可证已升级为 30 天签名租约')
        } catch (refreshError) {
          this.logger?.error('本地 Prism Pro 许可证验证或租约刷新失败', { verificationError, refreshError })
          throw verificationError
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.setStatus({
          plan: 'community',
          state: 'community',
          activationAvailable: true,
          message: '可以使用激活码在当前设备升级 Prism Pro',
          entitlements: []
        })
      } else {
        this.logger?.error('本地 Prism Pro 许可证验证失败', error)
        const expired = error instanceof Error && error.message.includes('一年授权已到期')
        this.setStatus({
          plan: 'community',
          state: expired ? 'maintenance-expired' : 'invalid',
          activationAvailable: true,
          message: error instanceof Error ? error.message : '本地 Prism Pro 许可证无效',
          entitlements: []
        })
      }
    }
    return this.status()
  }

  async activate(input: string): Promise<LicenseStatus> {
    if (!['darwin', 'win32'].includes(this.platform)) throw new Error('Prism Pro 当前不支持此操作系统')
    const config = this.config ?? await this.readConfig()
    this.config = config
    const activationCode = normalizedActivationCode(input)
    const activationCodeHash = createHash('sha256').update(activationCode).digest('hex')
    const identity = await this.identities.loadOrCreate()
    const requestNonce = randomBytes(32).toString('base64')
    const common = {
      schemaVersion: 1 as const,
      product: 'prism-pro' as const,
      activationCodeHash,
      deviceId: identity.deviceId,
      devicePublicKey: identity.publicKey,
      requestNonce,
      appVersion: this.appVersion,
      platform: this.platform,
      architecture: this.architecture
    }

    const challenge = await this.postJson<ActivationChallenge>(
      activationUrl(config.activationBaseUrl, '/v1/activation/challenge'),
      common
    )
    if (challenge.schemaVersion !== 1 || typeof challenge.challengeId !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge.challengeId)
      || typeof challenge.nonce !== 'string' || Buffer.from(challenge.nonce, 'base64').length < 32
      || challenge.requestNonce !== requestNonce || typeof challenge.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(challenge.expiresAt))
      || Date.parse(challenge.expiresAt) <= this.now()
      || Date.parse(challenge.expiresAt) > this.now() + 5 * 60_000) {
      throw new Error('激活服务器挑战无效')
    }

    const proofPayload = {
      ...common,
      challengeId: challenge.challengeId,
      challengeNonce: challenge.nonce,
      challengeExpiresAt: challenge.expiresAt
    }
    const proof = sign(null, Buffer.from(canonicalJson(proofPayload)), createPrivateKey(identity.privateKey)).toString('base64')
    const completed = await this.postJson<ActivationCompleteResponse>(
      activationUrl(config.activationBaseUrl, '/v1/activation/complete'),
      { ...proofPayload, activationCode, proof }
    )
    if (completed.schemaVersion !== 1 || !completed.certificate) throw new Error('激活服务器响应无效')
    const verified = verifyLicenseCertificate(
      completed.certificate,
      identity.deviceId,
      config.licensePublicKey,
      new Date(this.now())
    )
    await this.persistCertificate(verified.certificate)
    this.setStatus(verified.status)
    this.logger?.info('Prism Pro 已在当前设备激活', { licenseId: verified.status.licenseId })
    return this.status()
  }

  async deactivate(): Promise<LicenseStatus> {
    if (!['darwin', 'win32'].includes(this.platform)) throw new Error('Prism Pro 当前不支持此操作系统')
    if (this.current.plan !== 'pro') throw new Error('当前设备尚未激活 Prism Pro')
    const config = this.config ?? await this.readConfig()
    this.config = config
    const identity = await this.identities.loadOrCreate()
    const certificate: unknown = JSON.parse(await readFile(this.certificatePath, 'utf8'))
    const verified = verifyLicenseCertificate(certificate, identity.deviceId, config.licensePublicKey, new Date(this.now()))
    const payload = {
      schemaVersion: 1 as const,
      product: 'prism-pro' as const,
      action: 'deactivate' as const,
      licenseId: verified.certificate.payload.licenseId,
      deviceId: identity.deviceId,
      requestNonce: randomBytes(32).toString('base64'),
      requestedAt: new Date(this.now()).toISOString()
    }
    const proof = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(identity.privateKey)).toString('base64')
    const result = await this.postJson<DeactivationResponse>(
      activationUrl(config.activationBaseUrl, '/v1/activation/deactivate'),
      { ...payload, certificate: verified.certificate, proof }
    )
    if (result.schemaVersion !== 1 || result.deactivated !== true) throw new Error('激活服务器解绑响应无效')
    await rm(this.certificatePath, { force: true })
    this.setStatus({
      plan: 'community',
      state: 'community',
      activationAvailable: true,
      message: '当前设备已解除绑定，可在其他设备使用此激活码',
      entitlements: []
    })
    this.logger?.info('Prism Pro 已从当前设备解除绑定')
    return this.status()
  }

  async synchronize(): Promise<LicenseStatus> {
    if (!this.config || this.current.plan !== 'pro') return this.status()
    if (this.syncInFlight) return this.syncInFlight
    const operation = this.checkServerBinding()
    this.syncInFlight = operation
    try {
      return await operation
    } finally {
      this.syncInFlight = null
    }
  }

  async createProAgentHandshake(challenge: ProAgentChallenge): Promise<ProAgentHandshake> {
    await this.refreshLeaseIfDue()
    if (this.current.plan !== 'pro') throw new Error('Prism Pro Agent 需要有效的 Pro 授权')
    if (challenge?.schemaVersion !== 1 || challenge.product !== 'prism-pro-agent' || challenge.protocolVersion !== 1
      || typeof challenge.agentVersion !== 'string' || challenge.agentVersion.length > 64
      || typeof challenge.nonce !== 'string' || Buffer.from(challenge.nonce, 'base64').length < 32
      || typeof challenge.expiresAt !== 'string' || !Number.isFinite(Date.parse(challenge.expiresAt))
      || Date.parse(challenge.expiresAt) <= this.now() || Date.parse(challenge.expiresAt) > this.now() + 5 * 60_000) {
      throw new Error('Prism Pro Agent 挑战无效')
    }
    const config = this.config ?? await this.readConfig()
    this.config = config
    const identity = await this.identities.loadOrCreate()
    const certificate = JSON.parse(await readFile(this.certificatePath, 'utf8')) as SignedLicenseCertificate
    verifyLicenseCertificate(certificate, identity.deviceId, config.licensePublicKey, new Date(this.now()))
    const payload: ProAgentHandshake['payload'] = {
      schemaVersion: 1,
      product: 'prism-pro-agent',
      protocolVersion: 1,
      agentVersion: challenge.agentVersion,
      agentNonce: challenge.nonce,
      deviceId: identity.deviceId,
      appVersion: this.appVersion,
      requestNonce: randomBytes(32).toString('base64'),
      requestedAt: new Date(this.now()).toISOString()
    }
    return {
      schemaVersion: 1,
      certificate,
      devicePublicKey: identity.publicKey,
      payload,
      proof: sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(identity.privateKey)).toString('base64')
    }
  }

  private async readConfig(): Promise<LicenseConfig> {
    const path = this.configOverride ?? join(this.resourcesPath, 'license-config.json')
    await access(path)
    return validateConfig(JSON.parse(await readFile(path, 'utf8')))
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `Prism-Browser/${this.appVersion}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('激活服务器响应过大')
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('激活服务器响应过大')
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new LicenseHttpError(response.status, '激活码无效、已停用或不能用于当前设备')
      }
      if (response.status === 409) throw new LicenseHttpError(response.status, '激活码已绑定其他设备，请先在原设备解除绑定')
      if (response.status === 429) throw new LicenseHttpError(response.status, '激活尝试过于频繁，请稍后再试')
      throw new LicenseHttpError(response.status, `激活服务暂时不可用（HTTP ${response.status}）`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('激活服务器返回了无效数据')
    }
  }

  private startLeaseMonitor(): void {
    if (this.leaseTimer) return
    this.leaseTimer = setInterval(() => {
      void this.synchronize()
        .then(() => this.refreshLeaseIfDue())
        .catch((error) => this.logger?.error('Prism Pro 授权状态后台检查失败', error))
    }, BINDING_MONITOR_INTERVAL_MS)
    this.leaseTimer.unref?.()
  }

  private async checkServerBinding(): Promise<LicenseStatus> {
    try {
      const config = this.config ?? await this.readConfig()
      this.config = config
      const identity = await this.identities.loadOrCreate()
      const certificate = JSON.parse(await readFile(this.certificatePath, 'utf8')) as SignedLicenseCertificate
      const verified = verifyLicenseCertificate(certificate, identity.deviceId, config.licensePublicKey, new Date(this.now()))
      const payload = {
        schemaVersion: 1 as const,
        product: 'prism-pro' as const,
        action: 'status' as const,
        licenseId: verified.certificate.payload.licenseId,
        deviceId: identity.deviceId,
        requestNonce: randomBytes(32).toString('base64'),
        requestedAt: new Date(this.now()).toISOString()
      }
      const proof = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(identity.privateKey)).toString('base64')
      const response = await this.postJson<BindingStatusResponse>(
        activationUrl(config.activationBaseUrl, '/v1/activation/status'),
        { ...payload, certificate: verified.certificate, proof }
      )
      if (response.schemaVersion !== 1 || response.active !== true
        || !Number.isSafeInteger(response.bindingGeneration)
        || response.bindingGeneration !== verified.certificate.payload.bindingGeneration) {
        throw new Error('激活服务器授权状态响应无效')
      }
      return this.status()
    } catch (error) {
      if (error instanceof LicenseHttpError && [401, 403, 404].includes(error.status)) {
        await rm(this.certificatePath, { force: true })
        this.setStatus({
          plan: 'community',
          state: 'community',
          activationAvailable: true,
          message: 'Prism Pro 已在管理后台解绑，当前设备已返回 Community',
          entitlements: []
        })
        this.logger?.info('检测到 Prism Pro 已由管理后台解绑，本地许可证已清除')
        return this.status()
      }
      this.logger?.error('Prism Pro 在线绑定状态检查失败，继续使用本地签名租约', error)
      return this.status()
    }
  }

  private async refreshLeaseIfDue(): Promise<LicenseStatus> {
    if (!this.config) return this.status()
    if (this.refreshInFlight) return this.refreshInFlight
    const operation = this.maintainLease()
    this.refreshInFlight = operation
    try {
      return await operation
    } finally {
      this.refreshInFlight = null
    }
  }

  private async maintainLease(): Promise<LicenseStatus> {
    let certificate: unknown
    try {
      certificate = JSON.parse(await readFile(this.certificatePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.status()
      throw error
    }
    const identity = await this.identities.loadOrCreate()
    try {
      const verified = verifyLicenseCertificate(certificate, identity.deviceId, this.config!.licensePublicKey, new Date(this.now()))
      if (!this.leaseRefreshDue(verified.certificate)) return this.status()
      try {
        return await this.refreshCertificate(verified.certificate)
      } catch (error) {
        this.logger?.error('Prism Pro 授权租约静默刷新失败，将在租约到期前继续重试', error)
        return this.status()
      }
    } catch (verificationError) {
      try {
        return await this.refreshCertificate(certificate)
      } catch (refreshError) {
        this.logger?.error('Prism Pro 授权租约已失效且无法联网刷新', { verificationError, refreshError })
        const expired = verificationError instanceof Error && verificationError.message.includes('一年授权已到期')
        this.setStatus({
          plan: 'community',
          state: expired ? 'maintenance-expired' : 'invalid',
          activationAvailable: true,
          message: verificationError instanceof Error ? verificationError.message : 'Prism Pro 授权租约无效',
          entitlements: []
        })
        return this.status()
      }
    }
  }

  private leaseRefreshDue(certificate: SignedLicenseCertificate): boolean {
    return this.now() >= Date.parse(certificate.payload.issuedAt) + LEASE_REFRESH_INTERVAL_MS
  }

  private async refreshCertificate(certificate: unknown): Promise<LicenseStatus> {
    const config = this.config ?? await this.readConfig()
    this.config = config
    const identity = await this.identities.loadOrCreate()
    const rawPayload = (certificate as { payload?: { licenseId?: unknown; deviceId?: unknown } })?.payload
    if (typeof rawPayload?.licenseId !== 'string' || rawPayload.deviceId !== identity.deviceId) {
      throw new Error('Prism Pro 本地许可证无法用于租约刷新')
    }
    const payload = {
      schemaVersion: 1 as const,
      product: 'prism-pro' as const,
      action: 'refresh' as const,
      licenseId: rawPayload.licenseId,
      deviceId: identity.deviceId,
      requestNonce: randomBytes(32).toString('base64'),
      requestedAt: new Date(this.now()).toISOString()
    }
    const proof = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(identity.privateKey)).toString('base64')
    const response = await this.postJson<LeaseRefreshResponse>(
      activationUrl(config.activationBaseUrl, '/v1/activation/refresh'),
      { ...payload, certificate, proof }
    )
    if (response.schemaVersion !== 1 || !response.certificate) throw new Error('激活服务器租约响应无效')
    const verified = verifyLicenseCertificate(response.certificate, identity.deviceId, config.licensePublicKey, new Date(this.now()))
    await this.persistCertificate(verified.certificate)
    this.setStatus(verified.status)
    this.logger?.info('Prism Pro 30 天授权租约已静默刷新', { licenseId: verified.status.licenseId })
    return this.status()
  }

  private async persistCertificate(certificate: SignedLicenseCertificate): Promise<void> {
    await mkdir(dirname(this.certificatePath), { recursive: true })
    const temporary = `${this.certificatePath}.tmp`
    await writeFile(temporary, `${JSON.stringify(certificate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.certificatePath)
  }

  private setStatus(status: LicenseStatus): void {
    this.current = status
    this.onChanged(this.status())
  }
}

export { activationUrl, normalizedActivationCode, validateConfig }
