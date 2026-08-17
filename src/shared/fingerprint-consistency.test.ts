import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from './defaults'
import { assertFingerprintKernelCompatibility, fingerprintVersionWarning } from './fingerprint-consistency'
import type { BrowserProfile, EngineStatus } from './types'

const engine: EngineStatus = {
  executable: '/vault/kernels/148.0.7778.215/Chromium',
  source: 'configured',
  fingerprintKernel: true,
  label: 'Fingerprint Chromium',
  version: '148.0.7778.215'
}

describe('fingerprint and kernel consistency', () => {
  it('accepts an empty or exact brand version', () => {
    expect(fingerprintVersionWarning('', engine)).toBeUndefined()
    expect(fingerprintVersionWarning('148.0.7778.215', engine)).toBeUndefined()
  })

  it('normalizes same-major patch drift to the actual engine version', () => {
    expect(fingerprintVersionWarning('148.0.1.2', engine)).toContain('统一为实际内核版本')
  })

  it('warns when major versions differ', () => {
    expect(fingerprintVersionWarning('147.0.0.0', engine)).toContain('主版本不一致')
  })

  it('blocks launch for a conflicting fingerprint kernel version', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.brandVersion = '147'
    const profile = { ...draft, id: 'profile', createdAt: '', updatedAt: '', status: 'closed' } as BrowserProfile
    expect(() => assertFingerprintKernelCompatibility(profile, engine)).toThrow('148.0.7778.215')
  })

  it('does not constrain compatibility-mode system browsers', () => {
    const systemEngine = { ...engine, fingerprintKernel: false, version: undefined }
    expect(fingerprintVersionWarning('120', systemEngine)).toBeUndefined()
  })

  it('requires Chromium 144 for the disable-spoofing switch', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.disabledSpoofing = ['gpu']
    const profile = { ...draft, id: 'profile', createdAt: '', updatedAt: '', status: 'closed' } as BrowserProfile
    expect(() => assertFingerprintKernelCompatibility(profile, { ...engine, version: '142.0.7444.175' })).toThrow('144')
    expect(() => assertFingerprintKernelCompatibility(profile, { ...engine, version: '144.0.7559.132' })).not.toThrow()
  })

  it('allows older kernels when no Chromium 144-only switch is requested', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.hardwareProfileId = 'legacy-custom'
    draft.fingerprint.disabledSpoofing = []
    const profile = { ...draft, id: 'profile', createdAt: '', updatedAt: '', status: 'closed' } as BrowserProfile
    expect(() => assertFingerprintKernelCompatibility(profile, { ...engine, version: '142.0.7444.175' })).not.toThrow()
  })
})
