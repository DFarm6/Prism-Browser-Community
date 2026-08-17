interface FingerprintMatrixCase {
  id: string
  surfaceMode: 'native' | 'template' | 'fixed-template'
  seededGpu?: boolean
  platformVersion: string
  hardwareConcurrency: number
  screenWidth: number
  screenHeight: number
  expectedGpu?: string
  gpuBucket?: number
  gpuBucketCount?: number
  gpuPool?: Array<{
    bucket: number
    model: string
    deviceId?: string
  }>
  disableSpoofing?: string
  renderIdentity?: 'v1' | 'v2' | 'v3' | 'v4'
}

export function alignedSeed(seed: number, bucket: number, bucketCount: number): number
export function profileCases(platform: 'windows' | 'macos'): FingerprintMatrixCase[]
