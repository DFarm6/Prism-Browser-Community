import type { BrowserPlatform, FingerprintConfig, HardwareProfileId } from './types'
import windowsGpuCatalog from './windows-gpu-catalog.json'

export interface GpuIdentity {
  bucket: number
  model: string
  deviceId?: string
  deviceClass: 'desktop' | 'integrated'
}

interface WindowsGpuCatalog {
  schemaVersion: number
  kernelCatalogSize: number
  curatedDesktop: Array<Omit<GpuIdentity, 'deviceClass'>>
}

const WINDOWS_GPU_CATALOG = windowsGpuCatalog as WindowsGpuCatalog

export const CURATED_WINDOWS_DESKTOP_GPUS: readonly GpuIdentity[] =
  WINDOWS_GPU_CATALOG.curatedDesktop.map((identity) => ({
    ...identity,
    deviceClass: 'desktop' as const
  }))

export const CURATED_MACOS_GPUS: readonly GpuIdentity[] = [
  'Apple M1',
  'Apple M1 Pro',
  'Apple M2',
  'Apple M2 Max',
  'Apple M2 Pro',
  'Apple M3',
  'Apple M3 Max',
  'Apple M3 Pro',
  'Apple M4',
  'Apple M4 Max',
  'Apple M4 Pro'
].map((model, bucket) => ({
  bucket,
  model,
  deviceClass: 'integrated' as const
}))

export interface HardwareProfile {
  id: Exclude<HardwareProfileId, 'legacy-custom'>
  label: string
  description: string
  platform: BrowserPlatform
  platformVersion: string
  hardwareConcurrency: number
  physicalMemoryGb: number
  browserDeviceMemoryGb: 8
  screenWidth: number
  screenHeight: number
  gpuModel: string
  gpuBucket?: number
  gpuBucketCount?: number
  gpuPool?: readonly GpuIdentity[]
  renderIdentityMode: 'host-native' | 'seeded-curated' | 'fixed-template'
  hostMatched: boolean
}

/**
 * These presets match the GPU ordering in fingerprint patch 011-gpu-info.
 * Keep the bucket values in sync when the kernel GPU catalogue changes.
 */
export const HARDWARE_PROFILES: readonly HardwareProfile[] = [
  {
    id: 'macos-host',
    label: 'macOS · 本机硬件（推荐）',
    description: '保留本机 GPU、字体、Canvas 和 Audio，避免渲染信号互相矛盾。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: '本机 GPU',
    renderIdentityMode: 'host-native',
    hostMatched: true
  },
  {
    id: 'macos-seeded-apple',
    label: 'macOS · 种子独立 Apple GPU（推荐多环境）',
    description: '8 核 CPU、16GB 内存、1440×900；GPU 型号由环境种子固定选择。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: '种子固定的 Apple GPU',
    gpuBucketCount: 11,
    gpuPool: CURATED_MACOS_GPUS,
    renderIdentityMode: 'seeded-curated',
    hostMatched: false
  },
  {
    id: 'macos-m1',
    label: 'macOS · Apple M1 · 8GB',
    description: '8 核 CPU、Apple M1 GPU、1440×900。',
    platform: 'macos',
    platformVersion: '13.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 8,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: 'Apple M1',
    gpuBucket: 0,
    gpuBucketCount: 11,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'macos-m3-pro',
    label: 'macOS · Apple M3 Pro · 18GB',
    description: '12 核 CPU、Apple M3 Pro GPU、1512×982。',
    platform: 'macos',
    platformVersion: '14.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 18,
    browserDeviceMemoryGb: 8,
    screenWidth: 1512,
    screenHeight: 982,
    gpuModel: 'Apple M3 Pro',
    gpuBucket: 7,
    gpuBucketCount: 11,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'macos-m4-pro',
    label: 'macOS · Apple M4 Pro · 24GB',
    description: '12 核 CPU、Apple M4 Pro GPU、1512×982。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 24,
    browserDeviceMemoryGb: 8,
    screenWidth: 1512,
    screenHeight: 982,
    gpuModel: 'Apple M4 Pro',
    gpuBucket: 10,
    gpuBucketCount: 11,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-host',
    label: 'Windows · 本机硬件（推荐）',
    description: '保留本机 GPU、字体、Canvas 和 Audio，避免渲染信号互相矛盾。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: '本机 GPU',
    renderIdentityMode: 'host-native',
    hostMatched: true
  },
  {
    id: 'windows-seeded-nvidia',
    label: 'Windows · 种子独立 NVIDIA GPU（推荐多环境）',
    description: '8 核 CPU、16GB 内存、1920×1080；RTX 30/40 系列 GPU 由环境种子固定选择。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: '种子固定的 NVIDIA RTX GPU',
    gpuBucketCount: WINDOWS_GPU_CATALOG.kernelCatalogSize,
    gpuPool: CURATED_WINDOWS_DESKTOP_GPUS,
    renderIdentityMode: 'seeded-curated',
    hostMatched: false
  },
  {
    id: 'windows-10-rtx3060',
    label: 'Windows 10 · RTX 3060 · 16GB',
    description: '8 核 CPU、NVIDIA RTX 3060、1920×1080。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: 'NVIDIA GeForce RTX 3060',
    gpuBucket: 5,
    gpuBucketCount: 57,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-11-rtx4060',
    label: 'Windows 11 · RTX 4060 · 16GB',
    description: '12 核 CPU、NVIDIA RTX 4060、1920×1080；Windows UA 仍使用 NT 10.0。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: 'NVIDIA GeForce RTX 4060',
    gpuBucket: 29,
    gpuBucketCount: 57,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-11-rtx4070',
    label: 'Windows 11 · RTX 4070 · 32GB',
    description: '16 核 CPU、NVIDIA RTX 4070、2560×1440；Windows UA 仍使用 NT 10.0。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 16,
    physicalMemoryGb: 32,
    browserDeviceMemoryGb: 8,
    screenWidth: 2560,
    screenHeight: 1440,
    gpuModel: 'NVIDIA GeForce RTX 4070',
    gpuBucket: 34,
    gpuBucketCount: 57,
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  }
]

export function hardwareProfile(id: HardwareProfileId): HardwareProfile | undefined {
  return HARDWARE_PROFILES.find((profile) => profile.id === id)
}

export function defaultHardwareProfileId(platform: BrowserPlatform): HardwareProfileId {
  return platform === 'windows' ? 'windows-seeded-nvidia' : 'macos-seeded-apple'
}

export interface ApplyHardwareProfileOptions {
  refreshSeededGpu?: boolean
}

export function applyHardwareProfile(
  config: FingerprintConfig,
  id: HardwareProfileId,
  options: ApplyHardwareProfileOptions = {}
): FingerprintConfig {
  const profile = hardwareProfile(id)
  if (!profile) {
    return {
      ...config,
      hardwareProfileId: id,
      gpuBucket: undefined,
      renderIdentityVersion: undefined
    }
  }
  const seededIdentity = profile.gpuPool?.length && options.refreshSeededGpu
    ? profile.gpuPool[(config.seed >>> 0) % profile.gpuPool.length]
    : undefined
  const preservedSeededBucket = profile.renderIdentityMode === 'seeded-curated'
    && config.hardwareProfileId === id
    && Number.isInteger(config.gpuBucket)
    ? config.gpuBucket
    : undefined
  const gpuBucket = seededIdentity?.bucket
    ?? preservedSeededBucket
    ?? (profile.renderIdentityMode === 'fixed-template' ? profile.gpuBucket : undefined)
  return {
    ...config,
    hardwareProfileId: profile.id,
    gpuBucket,
    renderIdentityVersion: gpuBucket === undefined
      ? undefined
      : 4,
    platform: profile.platform,
    platformVersion: profile.platformVersion,
    hardwareConcurrency: profile.hardwareConcurrency,
    screenWidth: profile.screenWidth,
    screenHeight: profile.screenHeight
  }
}

export function effectiveFingerprintSeed(config: FingerprintConfig): number {
  const seed = config.seed >>> 0
  const profile = hardwareProfile(config.hardwareProfileId)
  if (!profile?.gpuBucketCount) return seed
  const bucket = profile.renderIdentityMode === 'fixed-template'
    ? profile.gpuBucket
    : Number.isInteger(config.gpuBucket)
      ? config.gpuBucket
      : undefined
  if (bucket === undefined) return seed
  const remainder = seed % profile.gpuBucketCount
  const candidate = seed - remainder + bucket
  return candidate <= 0xffffffff ? candidate : candidate - profile.gpuBucketCount
}

export function effectiveGpuIdentity(
  config: Pick<FingerprintConfig, 'seed' | 'hardwareProfileId' | 'gpuBucket'>
): GpuIdentity | undefined {
  const profile = hardwareProfile(config.hardwareProfileId)
  if (!profile) return undefined
  if (profile.gpuPool?.length && Number.isInteger(config.gpuBucket)) {
    return profile.gpuPool.find((identity) => identity.bucket === config.gpuBucket)
  }
  if (profile.gpuBucket === undefined) return undefined
  return {
    bucket: profile.gpuBucket,
    model: profile.gpuModel,
    deviceClass: profile.platform === 'windows' ? 'desktop' : 'integrated'
  }
}

export function refreshSeededGpuIdentity(config: FingerprintConfig): FingerprintConfig {
  return applyHardwareProfile(config, config.hardwareProfileId, { refreshSeededGpu: true })
}

export function effectiveDisabledSpoofing(config: FingerprintConfig): FingerprintConfig['disabledSpoofing'] {
  const selected = new Set(config.disabledSpoofing)
  const profile = hardwareProfile(config.hardwareProfileId)
  if (profile?.hostMatched) {
    for (const surface of ['font', 'audio', 'canvas', 'clientrects'] as const) selected.add(surface)
    selected.add('gpu')
  }
  return [...selected]
}

export function hardwareProfileSummary(id: HardwareProfileId): string {
  if (id === 'legacy-custom') return '旧版自定义硬件配置'
  const profile = hardwareProfile(id)
  if (!profile) return '未知硬件模板'
  if (profile.hostMatched) return `本机 CPU · 本机内存 · 本机 GPU · ${profile.screenWidth}×${profile.screenHeight}`
  return `${profile.hardwareConcurrency} 核 · ${profile.physicalMemoryGb}GB · ${profile.gpuModel} · ${profile.screenWidth}×${profile.screenHeight}`
}
