import type { FingerprintConfig, ProxyTestResult } from './types'

export const GEOIP_CONFLICT_CONFIRMATION_PREFIX = '[PRISM_GEOIP_CONFLICT_CONFIRMATION_REQUIRED]'

export interface NetworkIdentityOptions {
  allowGeoConflict?: boolean
}

export interface NetworkIdentity {
  language: string
  acceptLanguages: string
  timezone: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  source: 'manual' | 'proxy'
}

const COUNTRY_LOCALES: Record<string, { language: string; acceptLanguages: string }> = {
  AU: { language: 'en-AU', acceptLanguages: 'en-AU,en' },
  BR: { language: 'pt-BR', acceptLanguages: 'pt-BR,pt,en-US,en' },
  CA: { language: 'en-CA', acceptLanguages: 'en-CA,en-US,en' },
  CN: { language: 'zh-CN', acceptLanguages: 'zh-CN,zh,en-US,en' },
  DE: { language: 'de-DE', acceptLanguages: 'de-DE,de,en-US,en' },
  ES: { language: 'es-ES', acceptLanguages: 'es-ES,es,en-US,en' },
  FR: { language: 'fr-FR', acceptLanguages: 'fr-FR,fr,en-US,en' },
  GB: { language: 'en-GB', acceptLanguages: 'en-GB,en-US,en' },
  HK: { language: 'zh-HK', acceptLanguages: 'zh-HK,zh-TW,zh,en-US,en' },
  ID: { language: 'id-ID', acceptLanguages: 'id-ID,id,en-US,en' },
  IN: { language: 'en-IN', acceptLanguages: 'en-IN,en' },
  IT: { language: 'it-IT', acceptLanguages: 'it-IT,it,en-US,en' },
  JP: { language: 'ja-JP', acceptLanguages: 'ja-JP,ja,en-US,en' },
  KR: { language: 'ko-KR', acceptLanguages: 'ko-KR,ko,en-US,en' },
  MX: { language: 'es-MX', acceptLanguages: 'es-MX,es,en-US,en' },
  MY: { language: 'ms-MY', acceptLanguages: 'ms-MY,ms,en-US,en' },
  NL: { language: 'nl-NL', acceptLanguages: 'nl-NL,nl,en-US,en' },
  PH: { language: 'en-PH', acceptLanguages: 'en-PH,en-US,en' },
  RU: { language: 'ru-RU', acceptLanguages: 'ru-RU,ru,en-US,en' },
  SG: { language: 'en-SG', acceptLanguages: 'en-SG,en-US,en' },
  TH: { language: 'th-TH', acceptLanguages: 'th-TH,th,en-US,en' },
  TW: { language: 'zh-TW', acceptLanguages: 'zh-TW,zh,en-US,en' },
  US: { language: 'en-US', acceptLanguages: 'en-US,en' },
  VN: { language: 'vi-VN', acceptLanguages: 'vi-VN,vi,en-US,en' }
}

export function localeForCountry(countryCode: string | undefined): { language: string; acceptLanguages: string } | undefined {
  return countryCode ? COUNTRY_LOCALES[countryCode.toUpperCase()] : undefined
}

type CompleteProxyIdentity = ProxyTestResult & {
  ok: true
  ip: string
  countryCode: string
  timezone: string
  latitude: number
  longitude: number
}

export function hasCompleteProxyIdentity(
  check: ProxyTestResult | undefined,
  options: NetworkIdentityOptions = {}
): check is CompleteProxyIdentity {
  return Boolean(check?.ok
    && (check.geoConfidence !== 'conflict' || options.allowGeoConflict)
    && check.ip
    && check.countryCode
    && check.timezone
    && check.latitude !== undefined
    && check.longitude !== undefined)
}

export function effectiveNetworkIdentity(
  fingerprint: FingerprintConfig,
  check?: ProxyTestResult,
  options: NetworkIdentityOptions = {}
): NetworkIdentity {
  const fallback: NetworkIdentity = {
    language: fingerprint.language,
    acceptLanguages: fingerprint.acceptLanguages,
    timezone: fingerprint.timezone,
    source: 'manual'
  }
  if (fingerprint.networkIdentityMode !== 'proxy' || !hasCompleteProxyIdentity(check, options)) return fallback
  const locale = localeForCountry(check.countryCode)
  return {
    language: locale?.language ?? fallback.language,
    acceptLanguages: locale?.acceptLanguages ?? fallback.acceptLanguages,
    timezone: check.timezone ?? fallback.timezone,
    latitude: check.latitude,
    longitude: check.longitude,
    accuracyMeters: check.accuracyMeters,
    source: 'proxy'
  }
}

export function geoConflictConfirmationMessage(errorText: string): string | undefined {
  const marker = errorText.indexOf(GEOIP_CONFLICT_CONFIRMATION_PREFIX)
  if (marker < 0) return undefined
  return errorText.slice(marker + GEOIP_CONFLICT_CONFIRMATION_PREFIX.length).replace(/^\s*[:：]?\s*/, '')
}

export function proxyLaunchError(check: ProxyTestResult, exitPolicy: FingerprintConfig['proxyExitPolicy']): string | undefined {
  if (!check.ok) {
    if (check.failureKind === 'authentication') return '代理认证失败，请检查用户名和密码'
    if (check.failureKind === 'timeout') return '代理连接超时，请检查线路或更换代理'
    return `代理启动前检测失败：${check.error ?? '无法连接代理出口'}`
  }
  if (check.exitChanged && exitPolicy === 'block') {
    return `代理出口已从 ${check.previousIp ?? '原地址'} 变为 ${check.ip ?? '新地址'}；请确认后再次检测再启动`
  }
  return undefined
}
