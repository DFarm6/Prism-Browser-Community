import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import {
  applyHardwareProfile,
  CURATED_WINDOWS_DESKTOP_GPUS,
  effectiveDisabledSpoofing,
  effectiveFingerprintSeed,
  effectiveGpuIdentity,
  HARDWARE_PROFILES,
  hardwareProfile,
  defaultHardwareProfileId,
  refreshSeededGpuIdentity
} from './hardware-profiles'

describe('coherent hardware profiles', () => {
  it('defines complete CPU, memory, GPU, OS and screen contracts', () => {
    expect(HARDWARE_PROFILES.length).toBeGreaterThanOrEqual(8)
    for (const profile of HARDWARE_PROFILES) {
      expect(profile.platformVersion).toMatch(/^\d+(?:\.\d+)+$/)
      expect(profile.hardwareConcurrency).toBeGreaterThanOrEqual(2)
      expect(profile.physicalMemoryGb).toBeGreaterThanOrEqual(profile.browserDeviceMemoryGb)
      expect(profile.gpuModel).not.toBe('')
      expect(['host-native', 'seeded-curated', 'fixed-template']).toContain(profile.renderIdentityMode)
      expect(profile.screenWidth).toBeGreaterThanOrEqual(800)
      expect(profile.screenHeight).toBeGreaterThanOrEqual(600)
    }
  })

  it('applies a preset atomically instead of mixing unrelated values', () => {
    const input = defaultFingerprint(123)
    const result = applyHardwareProfile(input, 'macos-m3-pro')
    const profile = hardwareProfile('macos-m3-pro')!

    expect(result).toMatchObject({
      platform: profile.platform,
      platformVersion: profile.platformVersion,
      hardwareConcurrency: profile.hardwareConcurrency,
      screenWidth: profile.screenWidth,
      screenHeight: profile.screenHeight
    })
  })

  it('keeps every preset seed in the GPU bucket declared by the kernel catalogue', () => {
    for (const profile of HARDWARE_PROFILES.filter((item) => item.gpuBucket !== undefined)) {
      for (const seed of [0, 1, 42, 0xfffffffe, 0xffffffff]) {
        const config = applyHardwareProfile(defaultFingerprint(seed), profile.id)
        expect(effectiveFingerprintSeed(config) % profile.gpuBucketCount!).toBe(profile.gpuBucket)
      }
    }
  })

  it('turns off injected rendering overrides for host-matched profiles', () => {
    const config = applyHardwareProfile(defaultFingerprint(1), 'macos-host')
    expect(effectiveDisabledSpoofing(config)).toEqual(['font', 'audio', 'canvas', 'clientrects', 'gpu'])
  })

  it('enables coherent seed-bound rendering surfaces for simulated profiles', () => {
    const config = applyHardwareProfile(defaultFingerprint(1), 'macos-m3-pro')
    expect(effectiveDisabledSpoofing(config)).toEqual([])
    expect(effectiveFingerprintSeed(config) % hardwareProfile('macos-m3-pro')!.gpuBucketCount!)
      .toBe(hardwareProfile('macos-m3-pro')!.gpuBucket)
    expect(config.renderIdentityVersion).toBe(4)
  })

  it('uses a seed-selected GPU template by default for independent environments', () => {
    expect(defaultHardwareProfileId('windows')).toBe('windows-seeded-nvidia')
    expect(defaultHardwareProfileId('macos')).toBe('macos-seeded-apple')
    const first = applyHardwareProfile(defaultFingerprint(1), 'windows-seeded-nvidia', { refreshSeededGpu: true })
    const second = applyHardwareProfile(defaultFingerprint(2), 'windows-seeded-nvidia', { refreshSeededGpu: true })
    expect(effectiveFingerprintSeed(first) % 57).not.toBe(effectiveFingerprintSeed(second) % 57)
    expect(effectiveGpuIdentity(first)).not.toEqual(effectiveGpuIdentity(second))
    expect(effectiveDisabledSpoofing(first)).toEqual([])
    expect(first.renderIdentityVersion).toBe(4)
    expect(second.renderIdentityVersion).toBe(4)
  })

  it('maps seeded Windows identities only to curated desktop GPUs', () => {
    expect(CURATED_WINDOWS_DESKTOP_GPUS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(CURATED_WINDOWS_DESKTOP_GPUS.map((item) => item.bucket)).size)
      .toBe(CURATED_WINDOWS_DESKTOP_GPUS.length)
    expect(CURATED_WINDOWS_DESKTOP_GPUS.every((item) => (
      item.deviceClass === 'desktop'
      && !/Laptop/i.test(item.model)
      && item.bucket >= 0
      && item.bucket < 57
    ))).toBe(true)

    for (const seed of [0, 1, 42, 100001, 200003, 0xfffffffe, 0xffffffff]) {
      const config = applyHardwareProfile(defaultFingerprint(seed), 'windows-seeded-nvidia', { refreshSeededGpu: true })
      const identity = effectiveGpuIdentity(config)!
      expect(effectiveFingerprintSeed(config) % 57).toBe(identity.bucket)
    }
  })

  it('does not silently remap an existing seeded profile without a pinned bucket', () => {
    const legacySeeded = {
      ...defaultFingerprint(42),
      hardwareProfileId: 'windows-seeded-nvidia' as const,
      platform: 'windows' as const,
      gpuBucket: undefined,
      renderIdentityVersion: undefined
    }

    expect(effectiveFingerprintSeed(legacySeeded)).toBe(42)
    expect(effectiveGpuIdentity(legacySeeded)).toBeUndefined()
  })

  it('migrates stored render identity contracts to v4 without changing the pinned GPU bucket', () => {
    const legacy = {
      ...applyHardwareProfile(defaultFingerprint(42), 'windows-seeded-nvidia', { refreshSeededGpu: true }),
      renderIdentityVersion: 1 as const
    }
    const pinnedBucket = legacy.gpuBucket

    expect(applyHardwareProfile(legacy, legacy.hardwareProfileId)).toMatchObject({
      renderIdentityVersion: 4,
      gpuBucket: pinnedBucket
    })
    expect(refreshSeededGpuIdentity(legacy).renderIdentityVersion).toBe(4)
  })
})
