export interface RenderBundleReadiness {
  passed: boolean
  mode: 'legacy-differentiated-v1' | 'conservative-native-v2' | 'coherent-seeded-v3' | 'coherent-fixed-template-v3' | 'coherent-native-locale-v4' | 'coherent-fixed-native-locale-v4'
  rendererVaries: boolean
  rendererPolicy: 'vary-by-seed' | 'stable-fixed-template'
  rendererMatchesPolicy: boolean
  pixelsVary: boolean
  audioVaries: boolean
  audioNativeCalibrationStable: boolean
  canvasVaries: boolean
  creepCanvasVaries: boolean
  rectVaries: boolean
  fontSetVaries: boolean
  highEntropyVariation: Record<string, boolean>
  highEntropyDifferenceCount: number
  minimumHighEntropyDifferences: number
  nativeReadbacksStable: boolean
  postProcessingRiskFields: string[]
  crossSeedCollisionFields: string[]
  unexpectedCollisionFields: string[]
  canvasReadbackCoherent: boolean
  canvasReadbackChecks: Array<{
    sample: string
    coherent: boolean
    paths: Record<string, string | null> | null
  }>
  webglReadbackCoherent: boolean
  webglReadbackChecks: Array<{
    sample: string
    supported: boolean
    coherent: boolean
    paths: Record<string, string | null> | null
  }>
  speechLocaleCoherent: boolean
  speechVoicesAvailable: boolean
  speechPolicy: 'match-profile-locale' | 'immediate-profile-locale-catalog'
  speechPolicyPassed: boolean
  nativeLocaleSurfaces: boolean
  webgpuAvailable: boolean
  webgpuVaries: boolean
  webgpuCoherent: boolean
  webgpuPolicy: 'unavailable' | 'vary-by-seed' | 'shared-native-adapter' | 'coherent-gpu-template' | 'stable-fixed-template' | 'incoherent-gpu-template'
  webgpuPolicyPassed: boolean
  webgpuNeedsKernelCoverage: boolean
  webgpuCoherenceChecks: Array<{
    sample: string
    available: boolean
    expected: { vendor: string; architecture?: string } | null
    actual: { vendor: string; architecture: string } | null
    matched: boolean
  }>
  speechLocaleChecks: Array<{
    sample: string
    supported: boolean
    immediateVoiceCount: number
    voiceCount: number
    localVoiceCount: number
    defaultVoiceCount: number
    metadataComplete: boolean
    languages: string[]
    matched: boolean
    ready: boolean
  }>
}

export function cleanupRetryDelay(attempt: number): number

export function removeTemporaryTree(
  path: string,
  dependencies?: {
    remove?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>
    wait?: (milliseconds: number) => Promise<unknown>
    attempts?: number
  }
): Promise<void>

export function renderBundleReadiness(
  first: Record<string, unknown>,
  different: Record<string, unknown>,
  expectedLanguage: string,
  renderIdentity?: 'v1' | 'v2' | 'v3' | 'v4' | '',
  surfaceMode?: 'native' | 'template' | 'fixed-template'
): RenderBundleReadiness
