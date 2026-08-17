import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { effectiveNetworkIdentity, hasCompleteProxyIdentity, localeForCountry, proxyLaunchError } from './network-identity'

describe('proxy-derived network identity', () => {
  it('maps common exit countries to realistic locale headers', () => {
    expect(localeForCountry('JP')).toEqual({ language: 'ja-JP', acceptLanguages: 'ja-JP,ja,en-US,en' })
    expect(localeForCountry('US')).toEqual({ language: 'en-US', acceptLanguages: 'en-US,en' })
  })

  it('uses verified proxy geography as one atomic identity', () => {
    const fingerprint = defaultFingerprint(1)
    const identity = effectiveNetworkIdentity(fingerprint, {
      ok: true,
      latencyMs: 20,
      ip: '203.0.113.10',
      countryCode: 'JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.6762,
      longitude: 139.6503
    })
    expect(identity).toMatchObject({
      source: 'proxy',
      language: 'ja-JP',
      acceptLanguages: 'ja-JP,ja,en-US,en',
      timezone: 'Asia/Tokyo',
      latitude: 35.6762,
      longitude: 139.6503
    })
  })

  it('keeps legacy manual identity unchanged', () => {
    const fingerprint = defaultFingerprint(1)
    fingerprint.networkIdentityMode = 'manual'
    expect(effectiveNetworkIdentity(fingerprint, { ok: true, latencyMs: 1, countryCode: 'US', timezone: 'America/New_York' })).toMatchObject({
      source: 'manual', language: 'zh-CN', timezone: 'Asia/Shanghai'
    })
  })

  it('never creates a partially proxy-derived identity from degraded lookup data', () => {
    const fingerprint = defaultFingerprint(1)
    const incomplete = { ok: true as const, latencyMs: 10, countryCode: 'US', timezone: 'America/New_York' }
    expect(hasCompleteProxyIdentity(incomplete)).toBe(false)
    expect(effectiveNetworkIdentity(fingerprint, incomplete)).toMatchObject({
      source: 'manual',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai'
    })
  })

  it('rejects automatic identity when GeoIP providers disagree', () => {
    const fingerprint = defaultFingerprint(1)
    const conflict = {
      ok: true as const,
      latencyMs: 10,
      ip: '104.251.237.13',
      countryCode: 'JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.68,
      longitude: 139.76,
      geoConfidence: 'conflict' as const
    }
    expect(hasCompleteProxyIdentity(conflict)).toBe(false)
    expect(effectiveNetworkIdentity(fingerprint, conflict).source).toBe('manual')
    expect(hasCompleteProxyIdentity(conflict, { allowGeoConflict: true })).toBe(true)
    expect(effectiveNetworkIdentity(fingerprint, conflict, { allowGeoConflict: true })).toMatchObject({
      source: 'proxy',
      language: 'ja-JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.68,
      longitude: 139.76
    })
  })

  it('blocks authentication failures and changed exits under strict policy', () => {
    expect(proxyLaunchError({ ok: false, latencyMs: 1, failureKind: 'authentication' }, 'block')).toContain('认证失败')
    expect(proxyLaunchError({ ok: true, latencyMs: 1, ip: '2.2.2.2', previousIp: '1.1.1.1', exitChanged: true }, 'block')).toContain('出口已从')
    expect(proxyLaunchError({ ok: true, latencyMs: 1, exitChanged: true }, 'warn')).toBeUndefined()
  })
})
