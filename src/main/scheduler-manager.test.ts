import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskDraft } from '../shared/types'
import { SchedulerAuditLog } from './scheduler-audit'
import { SchedulerManager } from './scheduler-manager'
import { SchedulerStore } from './scheduler-store'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function once(runAt: Date, overrides: Partial<ScheduledTaskDraft> = {}): ScheduledTaskDraft {
  return {
    name: '启动一次', profileId: 'profile-1', action: 'launch',
    schedule: { kind: 'once', runAt: runAt.toISOString() }, enabled: true,
    missedPolicy: 'run_once', maxRetries: 0, retryDelayMinutes: 1,
    ...overrides
  }
}

async function fixture(now: Date) {
  const root = await mkdtemp(join(tmpdir(), 'prism-scheduler-manager-')); roots.push(root)
  let clock = new Date(now)
  const store = new SchedulerStore(root, () => new Date(clock))
  const audit = new SchedulerAuditLog(root); await audit.initialize()
  const launcher = { launch: vi.fn(async () => ({ status: 'running' })), close: vi.fn(async () => ({ status: 'closed' })) }
  const profiles = { get: vi.fn((id: string) => ({ id })) }
  const licensing = { has: vi.fn(() => true) }
  const manager = new SchedulerManager(store, profiles as never, launcher as never, licensing, audit, () => undefined, undefined, () => new Date(clock), 60 * 60_000)
  await manager.initialize()
  return { store, audit, launcher, profiles, licensing, manager, setNow: (value: Date) => { clock = new Date(value) } }
}

describe('SchedulerManager', () => {
  it('runs a due task through BrowserLauncher and disables a completed one-time task', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    const task = await item.manager.create(once(new Date(start.getTime() + 60_000)))
    item.setNow(new Date(start.getTime() + 70_000))
    await item.manager.tick()
    await vi.waitFor(() => expect(item.launcher.launch).toHaveBeenCalledWith('profile-1'))
    await vi.waitFor(() => expect(item.store.get(task.id).lastOutcome).toBe('success'))
    expect(item.store.get(task.id)).toMatchObject({ enabled: false, lastAttempts: 1 })
    await item.manager.shutdown()
  })

  it('skips an overdue task when the user selected skip', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    const task = await item.manager.create(once(new Date(start.getTime() + 60_000), { missedPolicy: 'skip' }))
    item.setNow(new Date(start.getTime() + 10 * 60_000))
    await item.manager.tick()
    expect(item.launcher.launch).not.toHaveBeenCalled()
    expect(item.store.get(task.id)).toMatchObject({ enabled: false, lastOutcome: 'skipped', lastAttempts: 0 })
    await item.manager.shutdown()
  })

  it('preserves the original next run when Run Now is used manually', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    const task = await item.manager.create(once(new Date(start.getTime() + 60 * 60_000)))
    await item.manager.runNow(task.id)
    expect(item.store.get(task.id)).toMatchObject({ enabled: true, nextRunAt: task.nextRunAt, lastOutcome: 'success' })
    await item.manager.shutdown()
  })

  it('keeps tasks but blocks mutations when the scheduler entitlement is absent', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    const existing = await item.manager.create(once(new Date(start.getTime() + 60_000)))
    item.licensing.has.mockReturnValue(false)
    item.manager.refreshEntitlement()
    await expect(item.manager.create(once(new Date(start.getTime() + 60_000)))).rejects.toThrow('需要 Prism Pro')
    await expect(item.manager.setEnabled(existing.id, false)).resolves.toMatchObject({ enabled: false })
    await expect(item.manager.setEnabled(existing.id, true)).rejects.toThrow('需要 Prism Pro')
    await expect(item.manager.remove(existing.id)).resolves.toBeUndefined()
    expect(item.store.list()).toEqual([])
    await item.manager.shutdown()
  })

  it('retries a failed action using the configured local retry delay', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    item.launcher.launch.mockRejectedValueOnce(new Error('temporary launch failure')).mockResolvedValueOnce({ status: 'running' })
    const task = await item.manager.create(once(new Date(start.getTime() + 60 * 60_000), { maxRetries: 1, retryDelayMinutes: 1 }))
    const running = item.manager.runNow(task.id)
    await vi.advanceTimersByTimeAsync(1)
    expect(item.launcher.launch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(running).resolves.toMatchObject({ lastOutcome: 'success', lastAttempts: 2 })
    await item.manager.shutdown()
  })

  it('limits simultaneous manual executions to two tasks', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    const resolvers: Array<() => void> = []
    item.launcher.launch.mockImplementation(() => new Promise((resolve) => resolvers.push(() => resolve({ status: 'running' }))))
    const tasks = await Promise.all(['profile-1', 'profile-2', 'profile-3'].map((profileId) => item.manager.create(once(
      new Date(start.getTime() + 60 * 60_000), { profileId, name: profileId }
    ))))
    const first = item.manager.runNow(tasks[0].id)
    const second = item.manager.runNow(tasks[1].id)
    expect(() => item.manager.runNow(tasks[2].id)).toThrow('2 个计划任务')
    resolvers.splice(0).forEach((resolve) => resolve())
    await Promise.all([first, second])
    await item.manager.shutdown()
  })

  it('redacts reusable secrets from task state and scheduler audit logs', async () => {
    const start = new Date('2026-08-10T00:00:00.000Z')
    const item = await fixture(start)
    item.launcher.launch.mockRejectedValue(new Error('failed http://alice:secret@proxy.test/path?token=reusable'))
    const task = await item.manager.create(once(new Date(start.getTime() + 60 * 60_000)))
    await expect(item.manager.runNow(task.id)).rejects.toThrow()
    expect(item.store.get(task.id).lastMessage).not.toContain('secret')
    expect(item.store.get(task.id).lastMessage).not.toContain('reusable')
    await item.manager.shutdown()
    const audit = await readFile(item.audit.path, 'utf8')
    expect(audit).not.toContain('secret')
    expect(audit).not.toContain('reusable')
  })
})
