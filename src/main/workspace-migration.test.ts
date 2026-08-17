import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { ExtensionStore } from './extension-store'
import { ProfileStore } from './profile-store'
import { WorkspaceMigrationManager } from './workspace-migration'

const roots: string[] = []
const password = 'correct horse battery staple'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function repository(prefix: string): Promise<{ root: string; profiles: ProfileStore; extensions: ExtensionStore }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const profiles = new ProfileStore(root)
  const extensions = new ExtensionStore(root)
  await Promise.all([profiles.initialize(), extensions.initialize()])
  return { root, profiles, extensions }
}

async function sourceFixture() {
  const source = await repository('prism-migration-source-')
  const unpacked = await mkdtemp(join(tmpdir(), 'prism-extension-source-'))
  roots.push(unpacked)
  await writeFile(join(unpacked, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '迁移测试扩展', version: '1.0.0' }))
  await writeFile(join(unpacked, 'background.js'), 'console.log("extension-secret")')
  const extension = await source.extensions.importDirectory(unpacked)
  const firstDraft = defaultProfileDraft()
  firstDraft.name = '工作环境'
  firstDraft.extensionIds = [extension.id]
  firstDraft.proxy = { protocol: 'http', host: 'proxy.example.test', port: 8080, username: 'alice', password: 'proxy-super-secret' }
  const secondDraft = defaultProfileDraft()
  secondDraft.name = '第二环境'
  const [first, second] = await source.profiles.createMany([firstDraft, secondDraft])
  await source.profiles.setFavorite(first.id, true)
  await mkdir(join(source.profiles.profileDataPath(first.id), 'Default', 'Local Storage'), { recursive: true })
  await writeFile(join(source.profiles.profileDataPath(first.id), 'Default', 'Cookies'), 'cookie-secret-value')
  await writeFile(join(source.profiles.profileDataPath(first.id), 'Default', 'Local Storage', 'data.log'), 'local-storage-value')
  await writeFile(join(source.profiles.profileDataPath(second.id), 'Preferences'), '{"theme":"dark"}')
  return source
}

describe('WorkspaceMigrationManager', () => {
  it('encrypts and restores all profiles, proxy credentials, browser data and referenced extensions', async () => {
    const source = await sourceFixture()
    const output = await mkdtemp(join(tmpdir(), 'prism-migration-output-'))
    roots.push(output)
    const archive = join(output, 'all.prism-migration')
    const exported = await new WorkspaceMigrationManager(source.profiles, source.extensions, '0.2.0').exportAll(archive, password)
    expect(exported).toMatchObject({ profileCount: 2, extensionCount: 1 })
    const raw = await readFile(archive)
    expect(raw.includes(Buffer.from('proxy-super-secret'))).toBe(false)
    expect(raw.includes(Buffer.from('cookie-secret-value'))).toBe(false)
    expect(raw.includes(Buffer.from('工作环境'))).toBe(false)

    const target = await repository('prism-migration-target-')
    const existingDraft = defaultProfileDraft()
    existingDraft.name = '工作环境'
    await target.profiles.create(existingDraft)
    const imported = await new WorkspaceMigrationManager(target.profiles, target.extensions, '0.2.0').importAll(archive, password, 'rename')
    expect(imported).toMatchObject({ profileCount: 2, importedCount: 2, renamedCount: 1, skippedCount: 0, extensionCount: 1 })
    const profiles = target.profiles.list()
    const migrated = profiles.find((profile) => profile.name.startsWith('工作环境（迁移）'))!
    expect(migrated.proxy.password).toBe('proxy-super-secret')
    expect(migrated.favorite).toBe(true)
    expect(migrated.extensionIds).toHaveLength(1)
    expect(target.extensions.list().map((extension) => extension.id)).toContain(migrated.extensionIds[0])
    await expect(readFile(join(target.profiles.profileDataPath(migrated.id), 'Default', 'Cookies'), 'utf8')).resolves.toBe('cookie-secret-value')
  })

  it('rejects a wrong password or tampered archive before creating any profile', async () => {
    const source = await sourceFixture()
    const output = await mkdtemp(join(tmpdir(), 'prism-migration-corrupt-'))
    roots.push(output)
    const archive = join(output, 'all.prism-migration')
    await new WorkspaceMigrationManager(source.profiles, source.extensions, '0.2.0').exportAll(archive, password)
    const target = await repository('prism-migration-empty-')
    const manager = new WorkspaceMigrationManager(target.profiles, target.extensions, '0.2.0')
    await expect(manager.importAll(archive, 'this password is wrong', 'rename')).rejects.toThrow('密码错误')
    expect(target.profiles.list()).toHaveLength(0)

    const bytes = await readFile(archive)
    bytes[bytes.length - 1] ^= 0xff
    const tampered = join(output, 'tampered.prism-migration')
    await writeFile(tampered, bytes)
    await expect(manager.importAll(tampered, password, 'rename')).rejects.toThrow(/损坏|认证|authenticate/)
    expect(target.profiles.list()).toHaveLength(0)
    expect((await readdir(target.root)).filter((name) => name.startsWith('.migration-import-'))).toEqual([])
  })

  it('rejects export targets inside profile data, including paths reached through a symlink', async () => {
    const source = await sourceFixture()
    const first = source.profiles.list()[0]
    const dataRoot = source.profiles.profileDataPath(first.id)
    const manager = new WorkspaceMigrationManager(source.profiles, source.extensions, '0.2.0')

    await expect(manager.exportAll(join(dataRoot, 'recursive.prism-migration'), password)).rejects.toThrow('不能保存在')
    await expect(readFile(join(dataRoot, 'recursive.prism-migration'))).rejects.toMatchObject({ code: 'ENOENT' })

    const links = await mkdtemp(join(tmpdir(), 'prism-migration-links-'))
    roots.push(links)
    const alias = join(links, 'profile-data')
    await symlink(dataRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(manager.exportAll(join(alias, 'linked.prism-migration'), password)).rejects.toThrow('不能保存在')
    await expect(readFile(join(dataRoot, 'linked.prism-migration'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('supports skip-on-name-conflict and rolls back profiles and extensions after a commit failure', async () => {
    const source = await sourceFixture()
    const output = await mkdtemp(join(tmpdir(), 'prism-migration-rollback-'))
    roots.push(output)
    const archive = join(output, 'all.prism-migration')
    await new WorkspaceMigrationManager(source.profiles, source.extensions, '0.2.0').exportAll(archive, password)

    const skipTarget = await repository('prism-migration-skip-')
    const conflict = defaultProfileDraft(); conflict.name = '工作环境'
    await skipTarget.profiles.create(conflict)
    const skipped = await new WorkspaceMigrationManager(skipTarget.profiles, skipTarget.extensions, '0.2.0').importAll(archive, password, 'skip')
    expect(skipped).toMatchObject({ importedCount: 1, skippedCount: 1, renamedCount: 0, extensionCount: 0 })

    const rollbackTarget = await repository('prism-migration-rollback-target-')
    vi.spyOn(rollbackTarget.profiles, 'assertProfileDataIdentity').mockRejectedValueOnce(new Error('simulated commit failure'))
    await expect(new WorkspaceMigrationManager(rollbackTarget.profiles, rollbackTarget.extensions, '0.2.0').importAll(archive, password, 'rename')).rejects.toThrow('simulated commit failure')
    expect(rollbackTarget.profiles.list()).toHaveLength(0)
    expect(rollbackTarget.extensions.list()).toHaveLength(0)
    expect(await rollbackTarget.profiles.listTrash()).toHaveLength(0)
  })
})
