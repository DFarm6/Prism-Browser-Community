import type { EngineStatus, KernelRelease } from '../shared/types'

/**
 * The copy shipped with Prism is authoritative for a bundled version. A stale
 * user-imported copy with the same version must not hide it in the UI.
 */
export function mergeKernelCatalog(managed: KernelRelease[], bundled: EngineStatus[]): KernelRelease[] {
  const byVersion = new Map(managed.map((kernel) => [kernel.version, kernel]))
  for (const engine of bundled) {
    if (!engine.version || !engine.executable) continue
    byVersion.set(engine.version, {
      version: engine.version,
      publishedAt: '',
      assetName: 'bundled-with-prism',
      downloadUrl: '',
      size: 0,
      sha256: '',
      installed: true,
      remoteAvailable: false,
      origin: 'bundled',
      executable: engine.executable
    })
  }
  return [...byVersion.values()]
    .sort((first, second) => second.version.localeCompare(first.version, undefined, { numeric: true }))
}
