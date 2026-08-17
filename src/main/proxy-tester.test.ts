import { describe, expect, it } from 'vitest'
import { classifyProxyFailure, mergeGeoLookups, parseGeoLookup, parseSecondaryGeoLookup } from './proxy-tester'

describe('proxy geolocation result', () => {
  it('maps location, network and security fields', () => {
    const result = parseGeoLookup({
      success: true,
      ip: '203.0.113.8',
      country: 'United States',
      country_code: 'US',
      region: 'California',
      city: 'Los Angeles',
      latitude: 34.0522,
      longitude: -118.2437,
      timezone: { id: 'America/Los_Angeles' },
      connection: { asn: 64500, org: 'Example Network', isp: 'Example ISP' },
      security: { proxy: true, hosting: true }
    }, 87)

    expect(result).toMatchObject({
      ok: true,
      ip: '203.0.113.8',
      latencyMs: 87,
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      asn: 64500,
      networkRisk: 'proxy'
    })
    expect(result).toMatchObject({ latitude: 34.0522, longitude: -118.2437, accuracyMeters: 25000, ipVersion: 4 })
  })

  it('classifies authentication, timeout and connection failures', () => {
    expect(classifyProxyFailure(new Error('Proxy responded with 407 authentication required'))).toBe('authentication')
    expect(classifyProxyFailure(new Error('headers timeout'))).toBe('timeout')
    expect(classifyProxyFailure(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe('connection')
    expect(classifyProxyFailure(new Error('upstream returned 590 Non Successful'))).toBe('connection')
    expect(classifyProxyFailure(new Error('TLS certificate verify failed'))).toBe('connection')
  })

  it('rejects failed and incomplete responses', () => {
    expect(() => parseGeoLookup({ success: false, message: 'rate limited' }, 1)).toThrow('rate limited')
    expect(() => parseGeoLookup({ success: true }, 1)).toThrow('结果无效')
    expect(() => parseGeoLookup({ success: true, ip: 'not-an-ip' }, 1)).toThrow('无效的出口地址')
    expect(() => parseGeoLookup({ success: true, ip: '203.0.113.8', timezone: { id: 'Mars/Olympus' } }, 1))
      .toThrow('无效的时区')
  })

  it('prioritizes Tor over other risk flags', () => {
    const result = parseGeoLookup({ ip: '203.0.113.9', security: { tor: true, vpn: true, proxy: true } }, 1)
    expect(result.networkRisk).toBe('tor')
  })

  it('parses the secondary provider and accepts matching country and timezone data', () => {
    const primary = parseGeoLookup({
      ip: '163.5.13.30',
      country_code: 'FR',
      timezone: { id: 'Europe/Paris' },
      latitude: 48.85,
      longitude: 2.35
    }, 10)
    const secondary = parseSecondaryGeoLookup({
      ip: '163.5.13.30',
      country_code: 'FR',
      timezone: 'Europe/Paris',
      latitude: 48.85,
      longitude: 2.35,
      asn: 'AS216138'
    }, 10)

    expect(secondary.asn).toBe(216138)
    expect(mergeGeoLookups(primary, secondary)).toMatchObject({
      geoConfidence: 'consensus',
      geoSources: ['ipwho.is', 'ipapi.co']
    })
  })

  it('marks conflicting GeoIP countries and timezones as unsafe for automatic identity', () => {
    const primary = parseGeoLookup({
      ip: '104.251.237.13',
      country_code: 'JP',
      timezone: { id: 'Asia/Tokyo' },
      latitude: 35.68,
      longitude: 139.76
    }, 10)
    const secondary = parseSecondaryGeoLookup({
      ip: '104.251.237.13',
      country_code: 'US',
      timezone: 'America/New_York',
      latitude: 39.8,
      longitude: -75.45
    }, 10)

    expect(mergeGeoLookups(primary, secondary)).toMatchObject({
      geoConfidence: 'conflict',
      degraded: true,
      geoConflict: expect.stringContaining('国家：JP / US'),
      warning: expect.stringContaining('启动时将要求用户确认')
    })
  })
})
