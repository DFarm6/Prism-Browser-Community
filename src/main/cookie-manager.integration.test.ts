import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { CookieManager } from './cookie-manager'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CookieManager Chromium integration', () => {
  it.skipIf(!process.env.PRISM_TEST_BROWSER)('imports and exports a Cookie through a real Chromium maintenance session', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-cookie-integration-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize()])
    await settings.update({ browserExecutable: process.env.PRISM_TEST_BROWSER!, fingerprintKernel: true })
    const profile = await profiles.create(defaultProfileDraft())
    const manager = new CookieManager(profiles, settings)

    await manager.importCookies(profile.id, [{
      url: 'https://example.com/',
      name: 'prism_e2e',
      value: 'verified',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax'
    }])
    const exported = await manager.exportCookies(profile.id)

    expect(exported).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prism_e2e', value: 'verified', domain: 'example.com' })
    ]))
  }, 30_000)
})
