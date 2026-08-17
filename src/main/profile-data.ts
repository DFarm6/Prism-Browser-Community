import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProfileStorageInfo, StorageOverview } from '../shared/types'

const CACHE_PATHS = [
  ['Default', 'Cache'],
  ['Default', 'Code Cache'],
  ['Default', 'GPUCache'],
  ['Default', 'Service Worker', 'CacheStorage'],
  ['ShaderCache'],
  ['GrShaderCache'],
  ['GraphiteDawnCache'],
  ['component_crx_cache'],
  ['Crashpad']
] as const

export async function safePathSize(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path)) total += await safePathSize(join(path, entry))
  return total
}

export async function profileStorageInfo(userDataPath: string): Promise<ProfileStorageInfo> {
  const cachePaths = CACHE_PATHS.map((segments) => join(userDataPath, ...segments))
  const [totalBytes, cacheParts] = await Promise.all([
    safePathSize(userDataPath),
    Promise.all(cachePaths.map(safePathSize))
  ])
  return {
    path: userDataPath,
    totalBytes,
    cacheBytes: cacheParts.reduce((total, size) => total + size, 0)
  }
}

export async function clearProfileCache(userDataPath: string): Promise<ProfileStorageInfo> {
  for (const segments of CACHE_PATHS) {
    await rm(join(userDataPath, ...segments), { recursive: true, force: true })
  }
  return profileStorageInfo(userDataPath)
}

export async function storageOverview(vaultPath: string): Promise<StorageOverview> {
  const profilesRoot = join(vaultPath, 'profiles')
  let profileEntries: string[] = []
  try {
    profileEntries = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const [profilesBytes, recycleBytes, kernelsBytes, downloadsBytes, extensionsBytes, cacheParts] = await Promise.all([
    safePathSize(profilesRoot),
    safePathSize(join(vaultPath, 'recycle-bin')),
    safePathSize(join(vaultPath, 'kernels')),
    safePathSize(join(vaultPath, 'downloads')),
    safePathSize(join(vaultPath, 'extensions')),
    Promise.all(profileEntries.flatMap((id) => CACHE_PATHS.map((segments) => safePathSize(join(profilesRoot, id, 'user-data', ...segments)))))
  ])
  return {
    profilesBytes,
    cacheBytes: cacheParts.reduce((sum, size) => sum + size, 0),
    recycleBytes,
    kernelsBytes,
    downloadsBytes,
    extensionsBytes,
    totalBytes: profilesBytes + recycleBytes + kernelsBytes + downloadsBytes + extensionsBytes
  }
}
