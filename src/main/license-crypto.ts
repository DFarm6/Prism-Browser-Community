import { createPublicKey, verify } from 'node:crypto'
import type { LicenseStatus, ProEntitlement } from '../shared/types'

const PRO_ENTITLEMENTS: ProEntitlement[] = [
  'automation-api',
  'scheduler',
  'mcp'
]

// Certificates issued by the private beta contained these two retired feature
// flags. Accept them while loading an old certificate, but never expose them to
// the application or include them in newly issued certificates.
const RETIRED_ENTITLEMENTS = ['scheduled-local-backups', 'managed-kernel-updates'] as const
const ACCEPTED_CERTIFICATE_ENTITLEMENTS = new Set<string>([
  ...PRO_ENTITLEMENTS,
  ...RETIRED_ENTITLEMENTS
])

export interface LicensePayload {
  schemaVersion: 2
  product: 'prism-pro'
  licenseId: string
  deviceId: string
  plan: 'pro'
  issuedAt: string
  leaseExpiresAt: string
  maintenanceUntil: string
  perpetual: true
  bindingGeneration: number
  entitlements: ProEntitlement[]
}

export interface SignedLicenseCertificate {
  payload: LicensePayload
  signature: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function parseCertificate(value: unknown): SignedLicenseCertificate {
  const certificate = value as Partial<SignedLicenseCertificate>
  const payload = certificate?.payload as Partial<LicensePayload> | undefined
  if (!payload || payload.schemaVersion !== 2 || payload.product !== 'prism-pro' || payload.plan !== 'pro'
    || payload.perpetual !== true || typeof payload.licenseId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.licenseId)
    || typeof payload.deviceId !== 'string' || !/^[a-f\d]{64}$/.test(payload.deviceId)
    || typeof payload.issuedAt !== 'string' || !Number.isFinite(Date.parse(payload.issuedAt))
    || typeof payload.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(payload.leaseExpiresAt))
    || Date.parse(payload.leaseExpiresAt) <= Date.parse(payload.issuedAt)
    || Date.parse(payload.leaseExpiresAt) > Date.parse(payload.issuedAt) + 31 * 24 * 60 * 60_000
    || typeof payload.maintenanceUntil !== 'string' || !Number.isFinite(Date.parse(payload.maintenanceUntil))
    || !Number.isInteger(payload.bindingGeneration) || Number(payload.bindingGeneration) < 1
    || !Array.isArray(payload.entitlements) || payload.entitlements.length === 0
    || new Set(payload.entitlements).size !== payload.entitlements.length
    || payload.entitlements.some((item) => typeof item !== 'string' || !ACCEPTED_CERTIFICATE_ENTITLEMENTS.has(item))
    || typeof certificate.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(certificate.signature)) {
    throw new Error('Prism Pro 许可证字段无效')
  }
  return certificate as SignedLicenseCertificate
}

export function verifyLicenseCertificate(
  value: unknown,
  expectedDeviceId: string,
  signingPublicKey: string,
  now = new Date()
): { certificate: SignedLicenseCertificate; status: LicenseStatus } {
  const certificate = parseCertificate(value)
  const key = createPublicKey(signingPublicKey)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(canonicalJson(certificate.payload)), key, Buffer.from(certificate.signature, 'base64'))) {
    throw new Error('Prism Pro 许可证签名无效')
  }
  if (certificate.payload.deviceId !== expectedDeviceId) throw new Error('Prism Pro 许可证不属于当前设备')
  if (Date.parse(certificate.payload.issuedAt) > now.getTime() + 5 * 60_000) throw new Error('Prism Pro 许可证签发时间无效')
  // `maintenanceUntil` is the legacy schema-v2 wire name. It is the hard Pro
  // subscription expiry and must never be extended by a 30-day lease refresh.
  if (Date.parse(certificate.payload.maintenanceUntil) <= now.getTime()) {
    throw new Error('Prism Pro 一年授权已到期，请购买新的授权并激活')
  }
  if (Date.parse(certificate.payload.leaseExpiresAt) <= now.getTime()) {
    throw new Error('Prism Pro 授权租约已到期，请联网刷新')
  }

  const entitlements = certificate.payload.entitlements.filter((item): item is ProEntitlement =>
    PRO_ENTITLEMENTS.includes(item as ProEntitlement)
  )
  return {
    certificate,
    status: {
      plan: 'pro',
      state: 'active',
      activationAvailable: true,
      message: 'Prism Pro 已在当前设备激活',
      deviceId: expectedDeviceId,
      licenseId: certificate.payload.licenseId,
      issuedAt: certificate.payload.issuedAt,
      leaseExpiresAt: certificate.payload.leaseExpiresAt,
      maintenanceUntil: certificate.payload.maintenanceUntil,
      entitlements
    }
  }
}

export { PRO_ENTITLEMENTS }
