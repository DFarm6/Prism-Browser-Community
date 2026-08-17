import { availableParallelism, release } from 'node:os'
import type { BrowserPlatform } from '../shared/types'

export interface HostHardwareSnapshot {
  platform: BrowserPlatform
  platformVersion: string
  hardwareConcurrency: number
}

export function hostPlatformVersion(platform: BrowserPlatform, operatingSystemRelease: string): string {
  if (platform === 'windows') return '10.0.0'
  const darwinMajor = Number(operatingSystemRelease.split('.')[0])
  if (!Number.isInteger(darwinMajor)) return '15.0.0'
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`
  return darwinMajor >= 20 ? `${darwinMajor - 9}.0.0` : '15.0.0'
}

export function hostHardwareSnapshot(): HostHardwareSnapshot {
  const platform: BrowserPlatform = process.platform === 'win32' ? 'windows' : 'macos'
  return {
    platform,
    platformVersion: hostPlatformVersion(platform, release()),
    hardwareConcurrency: Math.max(2, Math.min(64, availableParallelism()))
  }
}
