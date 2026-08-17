import type { BrowserProfile, BrowserProfileView, ProxyConfig } from '../shared/types'
import { redactSensitiveText } from './redaction'

export function sameProxyIdentity(first: ProxyConfig, second: ProxyConfig): boolean {
  return first.protocol === second.protocol
    && first.host.trim() === second.host.trim()
    && first.port === second.port
    && first.username === second.username
}

export function privateProxyConfig(proxy: ProxyConfig): ProxyConfig {
  const { passwordStored: _passwordStored, ...privateConfig } = proxy
  return privateConfig
}

export function publicProfile(profile: BrowserProfile): BrowserProfileView {
  return {
    ...profile,
    lastError: profile.lastError ? redactSensitiveText(profile.lastError) : undefined,
    tags: [...profile.tags],
    extensionIds: [...profile.extensionIds],
    startUrls: [...profile.startUrls],
    proxy: {
      ...profile.proxy,
      password: '',
      passwordStored: Boolean(profile.proxy.password)
    },
    fingerprint: {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
  }
}

export function proxyForTest(input: ProxyConfig, profile?: BrowserProfile): ProxyConfig {
  const candidate = privateProxyConfig(input)
  if (candidate.password || !input.passwordStored || !profile || !sameProxyIdentity(candidate, profile.proxy)) return candidate
  return { ...candidate, password: profile.proxy.password }
}
