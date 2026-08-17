import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { proxyForTest, publicProfile } from './profile-secrets'

function profile(): BrowserProfile {
  const draft = defaultProfileDraft()
  draft.proxy = {
    protocol: 'http',
    host: 'proxy.example.com',
    port: 8080,
    username: 'operator',
    password: 'top-secret'
  }
  return {
    ...draft,
    id: 'profile-1',
    serialNumber: 1,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    favorite: false,
    status: 'closed'
  }
}

describe('profile secret boundary', () => {
  it('removes proxy passwords from profiles exposed to the renderer', () => {
    const stored = profile()
    stored.lastError = 'failed via http://user:pass@proxy.example.com'
    const exposed = publicProfile(stored)
    expect(exposed.proxy.password).toBe('')
    expect(exposed.proxy.passwordStored).toBe(true)
    expect(exposed.lastError).not.toContain('user:pass')
  })

  it('reuses a stored password only for the same proxy identity', () => {
    const stored = profile()
    const exposed = publicProfile(stored)
    expect(proxyForTest(exposed.proxy, stored).password).toBe('top-secret')

    exposed.proxy.host = 'attacker.example.com'
    expect(proxyForTest(exposed.proxy, stored).password).toBe('')
  })

  it('uses an explicitly entered replacement password', () => {
    const stored = profile()
    const exposed = publicProfile(stored)
    expect(proxyForTest({ ...exposed.proxy, password: 'replacement' }, stored).password).toBe('replacement')
  })
})
