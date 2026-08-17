import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SettingsStore', () => {
  it('defaults legacy settings to no automatic recycle cleanup and persists an explicit policy', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-settings-'))
    temporaryPaths.push(vault)
    await writeFile(join(vault, 'settings.json'), JSON.stringify({ browserExecutable: '', fingerprintKernel: false }))
    const settings = new SettingsStore(vault)
    await settings.initialize()
    expect(settings.get().recycleRetentionDays).toBe(0)
    expect(settings.get().enginePreference).toBe('auto')

    await settings.update({ recycleRetentionDays: 30, enginePreference: 'system' })
    const reopened = new SettingsStore(vault)
    await reopened.initialize()
    expect(reopened.get().recycleRetentionDays).toBe(30)
    expect(reopened.get().enginePreference).toBe('system')
  })
})
