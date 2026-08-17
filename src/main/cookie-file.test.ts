import { describe, expect, it } from 'vitest'
import { parseCookieFile, serializeCookieFile } from './cookie-file'

describe('Cookie file format', () => {
  it('normalizes a common browser-extension Cookie array', () => {
    const cookies = parseCookieFile(JSON.stringify([{
      domain: '.example.com',
      name: 'session',
      value: 'sensitive-value',
      path: '/',
      expirationDate: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction'
    }]))

    expect(cookies).toEqual([{
      domain: '.example.com',
      name: 'session',
      value: 'sensitive-value',
      path: '/',
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    }])
  })

  it('round-trips the Prism format and preserves session cookies', () => {
    const raw = serializeCookieFile('环境 1', [{
      url: 'https://example.com/', name: 'session-only', value: '1', path: '/', session: true
    }])
    const cookies = parseCookieFile(raw)

    expect(cookies[0].url).toBe('https://example.com/')
    expect(cookies[0].expires).toBeUndefined()
    expect(raw).toContain('prism-browser-cookies')
  })

  it('rejects malformed domains and oversized batches', () => {
    expect(() => parseCookieFile(JSON.stringify([{ name: 'a', value: 'b', domain: 'https://example.com' }]))).toThrow('域名无效')
    const oversized = Array.from({ length: 10_001 }, () => ({ name: 'a', value: 'b', domain: 'example.com' }))
    expect(() => parseCookieFile(JSON.stringify(oversized))).toThrow('10000')
  })
})
