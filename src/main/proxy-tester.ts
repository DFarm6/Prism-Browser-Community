import { ProxyAgent, request } from 'undici'
import { isIP } from 'node:net'
import type { ProxyConfig, ProxyTestResult } from '../shared/types'
import { closeProxyBridge, openProxyBridge } from './proxy-bridge'
import { safeErrorText } from './redaction'

const IP_CHECK_URL = 'https://api.ipify.org?format=json'
const GEO_CHECK_URL = 'https://ipwho.is/'
const SECONDARY_GEO_CHECK_URL = 'https://ipapi.co/json/'

interface GeoLookupResponse {
  success?: boolean
  message?: string
  ip?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
  timezone?: { id?: string }
  connection?: { asn?: number; org?: string; isp?: string }
  security?: { proxy?: boolean; vpn?: boolean; tor?: boolean; hosting?: boolean }
}

interface SecondaryGeoLookupResponse {
  error?: boolean
  reason?: string
  ip?: string
  city?: string
  region?: string
  country_name?: string
  country_code?: string
  latitude?: number
  longitude?: number
  timezone?: string
  asn?: string
  org?: string
}

function networkRisk(security: GeoLookupResponse['security']): ProxyTestResult['networkRisk'] {
  if (security?.tor) return 'tor'
  if (security?.vpn) return 'vpn'
  if (security?.proxy) return 'proxy'
  if (security?.hosting) return 'hosting'
  return undefined
}

export function parseGeoLookup(data: GeoLookupResponse, latencyMs: number): ProxyTestResult {
  if (data.success === false) throw new Error(data.message || 'IP 地理信息查询失败')
  if (!data.ip) throw new Error('IP 地理信息结果无效')
  const ipVersion = isIP(data.ip)
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error('IP 地理信息返回了无效的出口地址')
  const timezone = data.timezone?.id
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    } catch {
      throw new Error('IP 地理信息返回了无效的时区')
    }
  }
  return {
    ok: true,
    ip: data.ip,
    latencyMs,
    country: data.country,
    countryCode: data.country_code?.toUpperCase(),
    latitude: typeof data.latitude === 'number' && data.latitude >= -90 && data.latitude <= 90 ? data.latitude : undefined,
    longitude: typeof data.longitude === 'number' && data.longitude >= -180 && data.longitude <= 180 ? data.longitude : undefined,
    accuracyMeters: typeof data.latitude === 'number' && typeof data.longitude === 'number' ? 25_000 : undefined,
    ipVersion,
    region: data.region,
    city: data.city,
    timezone,
    asn: data.connection?.asn,
    organization: data.connection?.org,
    isp: data.connection?.isp,
    networkRisk: networkRisk(data.security)
  }
}

export function parseSecondaryGeoLookup(data: SecondaryGeoLookupResponse, latencyMs: number): ProxyTestResult {
  if (data.error) throw new Error(data.reason || '备用 IP 地理信息查询失败')
  if (!data.ip) throw new Error('备用 IP 地理信息结果无效')
  const ipVersion = isIP(data.ip)
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error('备用 IP 地理信息返回了无效的出口地址')
  if (data.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }).format()
    } catch {
      throw new Error('备用 IP 地理信息返回了无效的时区')
    }
  }
  const asn = typeof data.asn === 'string' ? Number(data.asn.replace(/^AS/i, '')) : undefined
  return {
    ok: true,
    ip: data.ip,
    latencyMs,
    country: data.country_name,
    countryCode: data.country_code?.toUpperCase(),
    latitude: typeof data.latitude === 'number' && data.latitude >= -90 && data.latitude <= 90 ? data.latitude : undefined,
    longitude: typeof data.longitude === 'number' && data.longitude >= -180 && data.longitude <= 180 ? data.longitude : undefined,
    accuracyMeters: typeof data.latitude === 'number' && typeof data.longitude === 'number' ? 25_000 : undefined,
    ipVersion,
    region: data.region,
    city: data.city,
    timezone: data.timezone,
    asn: Number.isFinite(asn) ? asn : undefined,
    organization: data.org,
    isp: data.org
  }
}

export function mergeGeoLookups(primary: ProxyTestResult, secondary: ProxyTestResult): ProxyTestResult {
  const conflicts: string[] = []
  if (primary.ip && secondary.ip && primary.ip !== secondary.ip) {
    conflicts.push(`出口 IP：${primary.ip} / ${secondary.ip}`)
  }
  if (primary.countryCode && secondary.countryCode && primary.countryCode !== secondary.countryCode) {
    conflicts.push(`国家：${primary.countryCode} / ${secondary.countryCode}`)
  }
  if (primary.timezone && secondary.timezone && primary.timezone !== secondary.timezone) {
    conflicts.push(`时区：${primary.timezone} / ${secondary.timezone}`)
  }
  if (conflicts.length) {
    const geoConflict = `GeoIP 数据源冲突（${conflicts.join('；')}）`
    return {
      ...primary,
      degraded: true,
      warning: `${geoConflict}；继续使用可能影响时区、语言和地理位置的一致性，启动时将要求用户确认`,
      geoConfidence: 'conflict',
      geoSources: ['ipwho.is', 'ipapi.co'],
      geoConflict
    }
  }
  return {
    ...primary,
    geoConfidence: 'consensus',
    geoSources: ['ipwho.is', 'ipapi.co']
  }
}

export function classifyProxyFailure(error: unknown): NonNullable<ProxyTestResult['failureKind']> {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error)
  if (/407|proxy authentication|authentication failed|auth required|credentials/i.test(text)) return 'authentication'
  if (/timeout|timed out|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT/i.test(text)) return 'timeout'
  if (/\b59\d\b|ECONN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket|connect|TLS|certificate/i.test(text)) return 'connection'
  return 'unknown'
}

async function lookupJson<T>(url: string, dispatcher?: ProxyAgent): Promise<T> {
  const response = await request(url, {
    dispatcher,
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'Prism-Browser/0.1' },
    headersTimeout: 12_000,
    bodyTimeout: 12_000
  })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new Error(`检测服务返回 HTTP ${response.statusCode}`)
  }
  return response.body.json() as Promise<T>
}

async function testProxyOnce(config: ProxyConfig): Promise<ProxyTestResult> {
  const startedAt = Date.now()
  let localProxy: string | undefined
  let dispatcher: ProxyAgent | undefined
  try {
    localProxy = await openProxyBridge(config)
    dispatcher = localProxy ? new ProxyAgent(localProxy) : undefined
    const lookups = await Promise.allSettled([
      lookupJson<GeoLookupResponse>(GEO_CHECK_URL, dispatcher),
      lookupJson<SecondaryGeoLookupResponse>(SECONDARY_GEO_CHECK_URL, dispatcher)
    ])
    const latencyMs = Date.now() - startedAt
    let primary: ProxyTestResult | undefined
    let secondary: ProxyTestResult | undefined
    let primaryError: unknown
    let secondaryError: unknown
    try {
      if (lookups[0].status === 'fulfilled') primary = parseGeoLookup(lookups[0].value, latencyMs)
      else primaryError = lookups[0].reason
    } catch (error) {
      primaryError = error
    }
    try {
      if (lookups[1].status === 'fulfilled') secondary = parseSecondaryGeoLookup(lookups[1].value, latencyMs)
      else secondaryError = lookups[1].reason
    } catch (error) {
      secondaryError = error
    }
    if (primary && secondary) return mergeGeoLookups(primary, secondary)
    if (primary || secondary) {
      const result = primary ?? secondary!
      const source = primary ? 'ipwho.is' : 'ipapi.co'
      const failed = primary ? secondaryError : primaryError
      return {
        ...result,
        degraded: true,
        warning: `仅 ${source} 返回有效地理信息，无法交叉确认：${failed instanceof Error ? failed.message : String(failed ?? '未知错误')}`,
        geoConfidence: 'single-source',
        geoSources: [source]
      }
    }
    try {
      const data = await lookupJson<{ ip?: string }>(IP_CHECK_URL, dispatcher)
      const ipVersion = isIP(data.ip ?? '')
      if (!data.ip || (ipVersion !== 4 && ipVersion !== 6)) throw new Error('IP 检测结果无效')
      return {
        ok: true,
        ip: data.ip,
        ipVersion,
        latencyMs: Date.now() - startedAt,
        degraded: true,
        warning: `地理信息暂不可用：${[primaryError, secondaryError].map((error) => error instanceof Error ? error.message : String(error ?? '')).filter(Boolean).join('；')}`,
        geoConfidence: 'single-source',
        geoSources: []
      }
    } catch (ipError) {
      throw new AggregateError([primaryError, secondaryError, ipError], '代理出口检测失败')
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: safeErrorText(error),
      failureKind: classifyProxyFailure(error)
    }
  } finally {
    await dispatcher?.close().catch(() => undefined)
    await closeProxyBridge(localProxy)
  }
}

export async function testProxy(config: ProxyConfig): Promise<ProxyTestResult> {
  const first = await testProxyOnce(config)
  if (first.ok || first.failureKind === 'authentication') return first
  await new Promise((resolve) => setTimeout(resolve, 250))
  const second = await testProxyOnce(config)
  return { ...second, retried: true, latencyMs: first.latencyMs + second.latencyMs + 250 }
}
