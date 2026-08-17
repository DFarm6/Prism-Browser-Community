import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearProfileCache, profileStorageInfo, storageOverview } from './profile-data'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('profile data management', () => {
  it('clears known cache paths without deleting cookies or local storage', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'prism-profile-data-'))
    temporaryPaths.push(userData)
    await Promise.all([
      mkdir(join(userData, 'Default', 'Cache'), { recursive: true }),
      mkdir(join(userData, 'Default', 'Local Storage'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(userData, 'Default', 'Cache', 'cache.bin'), Buffer.alloc(2048)),
      writeFile(join(userData, 'Default', 'Cookies'), 'login-state'),
      writeFile(join(userData, 'Default', 'Local Storage', 'data'), 'site-data')
    ])

    const before = await profileStorageInfo(userData)
    expect(before.cacheBytes).toBeGreaterThanOrEqual(2048)
    const after = await clearProfileCache(userData)

    expect(after.cacheBytes).toBe(0)
    await expect(access(join(userData, 'Default', 'Cookies'))).resolves.toBeUndefined()
    await expect(access(join(userData, 'Default', 'Local Storage', 'data'))).resolves.toBeUndefined()
    await expect(access(join(userData, 'Default', 'Cache'))).rejects.toThrow()
  })

  it('summarizes active profiles, caches, recycle data, kernels, downloads and extensions', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-storage-overview-'))
    temporaryPaths.push(vault)
    const files = [
      ['profiles', 'p1', 'user-data', 'Default', 'Cache', 'cache.bin'],
      ['profiles', 'p1', 'user-data', 'Default', 'Cookies'],
      ['recycle-bin', 'profiles', 'old', 'data.bin'],
      ['kernels', '148.0.0.0', 'chrome.bin'],
      ['downloads', 'kernel.download'],
      ['extensions', 'extension.bin']
    ]
    for (const segments of files) {
      const path = join(vault, ...segments)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, Buffer.alloc(100))
    }

    const overview = await storageOverview(vault)

    expect(overview.profilesBytes).toBe(200)
    expect(overview.cacheBytes).toBe(100)
    expect(overview.recycleBytes).toBe(100)
    expect(overview.kernelsBytes).toBe(100)
    expect(overview.downloadsBytes).toBe(100)
    expect(overview.extensionsBytes).toBe(100)
    expect(overview.totalBytes).toBe(600)
  })
})
