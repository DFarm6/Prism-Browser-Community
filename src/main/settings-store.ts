import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'

export class SettingsStore {
  private settings: AppSettings = { browserExecutable: '', fingerprintKernel: false, enginePreference: 'auto', recycleRetentionDays: 0 }
  private readonly path: string

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'settings.json')
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8')) as Partial<AppSettings>
      this.settings = {
        browserExecutable: typeof stored.browserExecutable === 'string' ? stored.browserExecutable : '',
        fingerprintKernel: stored.fingerprintKernel === true,
        enginePreference: stored.enginePreference === 'bundled' || stored.enginePreference === 'system' ? stored.enginePreference : 'auto',
        recycleRetentionDays: stored.recycleRetentionDays === 7 || stored.recycleRetentionDays === 30 || stored.recycleRetentionDays === 90
          ? stored.recycleRetentionDays
          : 0
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    return this.get()
  }

  async hasConfiguredExecutable(): Promise<boolean> {
    if (!this.settings.browserExecutable) return false
    try {
      await access(this.settings.browserExecutable, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
