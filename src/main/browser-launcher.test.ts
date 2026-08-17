import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { BrowserLauncher } from './browser-launcher'
import { ExtensionStore } from './extension-store'
import type { ProcessInspector, SystemProcess } from './process-inspector'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeProcessInspector implements ProcessInspector {
  terminated: number[] = []
  constructor(private processes: SystemProcess[]) {}
  async list(): Promise<SystemProcess[]> { return this.processes }
  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid)
    this.processes = this.processes.filter((item) => item.pid !== pid)
  }
}

class FailingProcessInspector implements ProcessInspector {
  async list(): Promise<SystemProcess[]> { throw new Error('process scan failed') }
  async terminate(): Promise<void> { throw new Error('not available') }
}

class StickyProcessInspector implements ProcessInspector {
  terminateCalls = 0
  constructor(private readonly process: SystemProcess) {}
  async list(): Promise<SystemProcess[]> { return [this.process] }
  async terminate(): Promise<void> {
    this.terminateCalls += 1
    throw new Error('permission denied')
  }
}

class FakeBrowserProcess extends EventEmitter {
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  start(): void {
    if (this.exitCode === null && this.signalCode === null) this.emit('spawn')
  }

  crash(code = 1): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signals.push(signal)
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return
      this.exitCode = 0
      this.signalCode = signal
      this.emit('exit', 0, signal)
    })
    return true
  }
}

class FakeSpawnController {
  readonly children: FakeBrowserProcess[] = []
  readonly arguments: string[][] = []
  private nextPid = 10_000

  readonly spawn = ((_executable: string, args?: readonly string[]): ChildProcess => {
    const child = new FakeBrowserProcess(this.nextPid++)
    this.children.push(child)
    this.arguments.push([...(args ?? [])])
    return child as unknown as ChildProcess
  }) as typeof spawn

  startPending(): void {
    for (const child of this.children) {
      if (child.listenerCount('spawn')) child.start()
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function launchFixture(profileCount: number, concurrency = 3): Promise<{
  profiles: ProfileStore
  launcher: BrowserLauncher
  controller: FakeSpawnController
  ids: string[]
}> {
  const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
  temporaryPaths.push(vault)
  const profiles = new ProfileStore(vault)
  const settings = new SettingsStore(vault)
  const extensions = new ExtensionStore(vault)
  await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
  await settings.update({ browserExecutable: process.execPath, fingerprintKernel: false, enginePreference: 'auto' })
  const drafts = Array.from({ length: profileCount }, (_, index) => {
    const draft = defaultProfileDraft(index + 1)
    draft.name = `并发环境 ${index + 1}`
    return draft
  })
  const created = await profiles.createMany(drafts)
  const controller = new FakeSpawnController()
  const launcher = new BrowserLauncher(
    profiles,
    settings,
    () => undefined,
    extensions,
    undefined,
    new FakeProcessInspector([]),
    async () => ({ ok: true, latencyMs: 1, checkedAt: new Date().toISOString() }),
    concurrency,
    controller.spawn
  )
  return { profiles, launcher, controller, ids: created.map((profile) => profile.id) }
}

describe('BrowserLauncher orphan recovery', () => {
  it('adopts a process using the profile directory and safely closes it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    const profile = await profiles.create(defaultProfileDraft())
    const inspector = new FakeProcessInspector([{
      pid: 4242,
      command: `/Applications/Chromium --user-data-dir=${profiles.profileDataPath(profile.id)}`
    }])
    const launcher = new BrowserLauncher(profiles, settings, () => undefined, extensions, undefined, inspector)

    await launcher.initialize()
    expect(profiles.get(profile.id).status).toBe('orphaned')
    expect(launcher.isRunning(profile.id)).toBe(true)

    await launcher.close(profile.id)
    expect(inspector.terminated).toEqual([4242])
    expect(profiles.get(profile.id).status).toBe('closed')
    expect(launcher.isRunning(profile.id)).toBe(false)
  })

  it('stops close-all after bounded retries when an orphan cannot be terminated', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    const profile = await profiles.create(defaultProfileDraft())
    const inspector = new StickyProcessInspector({
      pid: 4343,
      command: `/Applications/Chromium --user-data-dir=${profiles.profileDataPath(profile.id)}`
    })
    const launcher = new BrowserLauncher(profiles, settings, () => undefined, extensions, undefined, inspector)
    await launcher.initialize()

    await expect(launcher.closeAll()).rejects.toThrow('无法关闭')

    expect(inspector.terminateCalls).toBe(2)
    expect(launcher.runtimeSnapshot()).toMatchObject({ orphanProcesses: 1, closingAll: false })
    expect(profiles.get(profile.id).status).toBe('orphaned')
  })

  it('returns a redacted preflight report when no browser engine is configured', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'top-secret' }
    const profile = await profiles.create(draft)
    await profiles.setProxyCheck(profile.id, {
      ok: false,
      latencyMs: 20,
      checkedAt: new Date().toISOString(),
      error: 'http://user:top-secret@proxy.example.com:8080 failed'
    })
    const launcher = new BrowserLauncher(profiles, settings, () => undefined, extensions, undefined, new FakeProcessInspector([]))

    const report = await launcher.diagnose(profile.id)

    expect(report.ready).toBe(false)
    expect(report.checks.some((check) => check.key === 'engine')).toBe(true)
    expect(report.checks.some((check) => check.status === 'error')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('top-secret')
  })

  it('reports a missing profile-pinned kernel without falling back to another browser', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    const draft = defaultProfileDraft()
    draft.kernelVersion = '144.0.7559.132'
    const profile = await profiles.create(draft)
    const launcher = new BrowserLauncher(profiles, settings, () => undefined, extensions, undefined, new FakeProcessInspector([]))

    const report = await launcher.diagnose(profile.id)

    expect(report.ready).toBe(false)
    expect(report.checks.find((check) => check.key === 'engine')).toMatchObject({
      status: 'error',
      message: expect.stringContaining('144.0.7559.132')
    })
  })

  it('recovers a persisted running state when no process still owns the data directory', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const stored = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([stored.initialize(), settings.initialize(), extensions.initialize()])
    const profile = await stored.create(defaultProfileDraft())
    await stored.setRuntime(profile.id, {
      status: 'running',
      lastOpenedAt: new Date().toISOString(),
      lastError: undefined
    })
    await writeFile(join(stored.profileRuntimePath(profile.id), 'process.json'), JSON.stringify({
      pid: 9999,
      userDataDir: stored.profileDataPath(profile.id)
    }))
    const reopened = new ProfileStore(vault)
    await reopened.initialize()
    const launcher = new BrowserLauncher(reopened, settings, () => undefined, extensions, undefined, new FakeProcessInspector([]))

    await launcher.initialize()

    expect(reopened.get(profile.id).status).toBe('error')
    expect(reopened.get(profile.id).lastError).toContain('未正常结束')
  })

  it('moves transient profiles to a recoverable error state when process scanning fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    const profile = await profiles.create(defaultProfileDraft())
    await writeFile(join(profiles.profileRuntimePath(profile.id), 'process.json'), JSON.stringify({
      pid: 9999,
      userDataDir: profiles.profileDataPath(profile.id)
    }))
    const reopened = new ProfileStore(vault)
    await reopened.initialize()
    const launcher = new BrowserLauncher(reopened, settings, () => undefined, extensions, undefined, new FailingProcessInspector())

    await launcher.initialize()

    expect(reopened.get(profile.id).status).toBe('error')
    expect(reopened.get(profile.id).lastError).toContain('无法扫描系统进程')
  })
})

describe('BrowserLauncher concurrent lifecycle', () => {
  it('deduplicates simultaneous launches of the same profile', async () => {
    const { profiles, launcher, controller, ids } = await launchFixture(1)
    const launches = [launcher.launch(ids[0]), launcher.launch(ids[0]), launcher.launch(ids[0])]
    await waitUntil(() => controller.children.length === 1)
    controller.startPending()

    await expect(Promise.all(launches)).resolves.toHaveLength(3)
    expect(controller.children).toHaveLength(1)
    expect(profiles.get(ids[0]).status).toBe('running')

    await launcher.closeAll()
    expect(profiles.get(ids[0]).status).toBe('closed')
    expect(launcher.runtimeSnapshot()).toEqual({
      managedProcesses: 0,
      orphanProcesses: 0,
      launchOperations: 0,
      closeOperations: 0,
      activeLaunches: 0,
      queuedLaunches: 0,
      closingAll: false
    })
  })

  it('limits concurrent startup work and releases all lifecycle bookkeeping after stress', async () => {
    const { launcher, controller, ids } = await launchFixture(12, 3)
    const launches = ids.map((id) => launcher.launch(id))

    await waitUntil(() => controller.children.length === 3)
    expect(launcher.runtimeSnapshot()).toMatchObject({ activeLaunches: 3, queuedLaunches: 9 })
    controller.startPending()
    await waitUntil(() => controller.children.length === 6)
    controller.startPending()
    await waitUntil(() => controller.children.length === 9)
    controller.startPending()
    await waitUntil(() => controller.children.length === 12)
    controller.startPending()
    await Promise.all(launches)

    expect(new Set(controller.arguments.map((args) =>
      args.find((argument) => argument.startsWith('--user-data-dir='))))).toHaveLength(12)
    expect(launcher.runtimeSnapshot()).toMatchObject({
      managedProcesses: 12,
      launchOperations: 0,
      activeLaunches: 0,
      queuedLaunches: 0
    })

    await launcher.closeAll()
    expect(launcher.runtimeSnapshot()).toEqual({
      managedProcesses: 0,
      orphanProcesses: 0,
      launchOperations: 0,
      closeOperations: 0,
      activeLaunches: 0,
      queuedLaunches: 0,
      closingAll: false
    })
  })

  it('serializes close requests that arrive while a profile is still starting', async () => {
    const { profiles, launcher, controller, ids } = await launchFixture(1)
    const launch = launcher.launch(ids[0])
    await waitUntil(() => controller.children.length === 1)
    const close = launcher.close(ids[0])
    controller.startPending()

    await launch
    await close

    expect(controller.children).toHaveLength(1)
    expect(controller.children[0].signals).toContain('SIGTERM')
    expect(profiles.get(ids[0]).status).toBe('closed')
    expect(launcher.hasRunning()).toBe(false)
  })

  it('blocks new launches while close-all drains a profile that is still starting', async () => {
    const { profiles, launcher, controller, ids } = await launchFixture(2)
    const launch = launcher.launch(ids[0])
    await waitUntil(() => controller.children.length === 1)
    const closeAll = launcher.closeAll()

    await expect(launcher.launch(ids[1])).rejects.toThrow('正在关闭全部')
    expect(launcher.runtimeSnapshot().closingAll).toBe(true)
    controller.startPending()
    await launch
    await closeAll

    expect(profiles.get(ids[0]).status).toBe('closed')
    expect(profiles.get(ids[1]).status).toBe('closed')
    expect(launcher.runtimeSnapshot().closingAll).toBe(false)
  })

  it('records an unexpected browser crash and releases the managed-process entry', async () => {
    const { profiles, launcher, controller, ids } = await launchFixture(1)
    const launch = launcher.launch(ids[0])
    await waitUntil(() => controller.children.length === 1)
    controller.startPending()
    await launch

    controller.children[0].crash(23)
    await waitUntil(() => profiles.get(ids[0]).status === 'error')

    expect(profiles.get(ids[0]).lastError).toContain('code=23')
    await expect(launcher.crashHistory(ids[0])).resolves.toEqual([
      expect.objectContaining({ code: 23, phase: 'running', pid: controller.children[0].pid })
    ])
    expect(launcher.runtimeSnapshot().managedProcesses).toBe(0)
    expect(launcher.hasRunning()).toBe(false)
  })

  it('retains only the latest 20 browser crash records per profile', async () => {
    const { profiles, launcher, controller, ids } = await launchFixture(1)
    for (let index = 1; index <= 22; index += 1) {
      const launch = launcher.launch(ids[0])
      await waitUntil(() => controller.children.length === index)
      controller.startPending()
      await launch
      controller.children[index - 1].crash(index)
      await waitUntil(() => profiles.get(ids[0]).status === 'error')
    }

    const history = await launcher.crashHistory(ids[0])
    expect(history).toHaveLength(20)
    expect(history[0].code).toBe(3)
    expect(history[19].code).toBe(22)
  })

  it('rechecks a running proxy exit and fails closed when the pinned IP changes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    await settings.update({ browserExecutable: process.execPath, fingerprintKernel: false, enginePreference: 'auto' })
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: '127.0.0.1', port: 9, username: '', password: '' }
    draft.fingerprint.networkIdentityMode = 'proxy'
    draft.fingerprint.proxyExitPolicy = 'block'
    const profile = await profiles.create(draft)
    const controller = new FakeSpawnController()
    let checks = 0
    const launcher = new BrowserLauncher(
      profiles,
      settings,
      () => undefined,
      extensions,
      undefined,
      new FakeProcessInspector([]),
      async () => ({
        ok: true,
        latencyMs: 1,
        ip: checks++ === 0 ? '203.0.113.10' : '203.0.113.11',
        countryCode: 'US',
        timezone: 'America/Los_Angeles',
        latitude: 34.0522,
        longitude: -118.2437
      }),
      3,
      controller.spawn,
      20
    )

    const launch = launcher.launch(profile.id)
    await waitUntil(() => controller.children.length === 1)
    controller.startPending()
    await launch
    await waitUntil(() => profiles.get(profile.id).lastError?.includes('已停止该环境的代理网络') === true)

    expect(profiles.get(profile.id)).toMatchObject({
      status: 'running',
      proxyCheck: {
        ip: '203.0.113.11',
        previousIp: '203.0.113.10',
        exitChanged: true
      }
    })
    expect(controller.children[0].signals).toEqual([])
    await launcher.close(profile.id)
    expect(profiles.get(profile.id).status).toBe('closed')
  })

  it('requires confirmation for conflicting GeoIP data and launches after explicit approval', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-launcher-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    await settings.update({ browserExecutable: process.execPath, fingerprintKernel: false, enginePreference: 'auto' })
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: '127.0.0.1', port: 9, username: '', password: '' }
    draft.fingerprint.networkIdentityMode = 'proxy'
    const profile = await profiles.create(draft)
    const controller = new FakeSpawnController()
    const launcher = new BrowserLauncher(
      profiles,
      settings,
      () => undefined,
      extensions,
      undefined,
      new FakeProcessInspector([]),
      async () => ({
        ok: true,
        latencyMs: 1,
        ip: '104.251.237.13',
        countryCode: 'JP',
        timezone: 'Asia/Tokyo',
        latitude: 35.68,
        longitude: 139.76,
        geoConfidence: 'conflict',
        geoConflict: 'GeoIP 数据源冲突（国家：JP / US；时区：Asia/Tokyo / America/New_York）'
      }),
      3,
      controller.spawn
    )

    await expect(launcher.launch(profile.id)).rejects.toThrow('PRISM_GEOIP_CONFLICT_CONFIRMATION_REQUIRED')
    expect(controller.children).toHaveLength(0)
    expect(profiles.get(profile.id).status).toBe('closed')

    const approvedLaunch = launcher.launch(profile.id, { allowGeoConflict: true })
    await waitUntil(() => controller.children.length === 1)
    controller.startPending()
    await expect(approvedLaunch).resolves.toMatchObject({ status: 'running' })
    expect(controller.children).toHaveLength(1)
    expect(controller.arguments[0]).toContain('--fingerprint-language=ja-JP')
    expect(controller.arguments[0]).toContain('--timezone=Asia/Tokyo')
    expect(controller.arguments[0]).toContain('--fingerprint-location=35.68,139.76,25000')
    await launcher.close(profile.id)
  })
})
