import type { ScheduledTask, ScheduledTaskDraft } from '../shared/types'
import type { Logger } from './app-logger'
import type { BrowserLauncher } from './browser-launcher'
import type { ProfileStore } from './profile-store'
import type { SchedulerAuditLog } from './scheduler-audit'
import type { SchedulerStore } from './scheduler-store'
import { safeErrorText } from './redaction'

interface SchedulerLicenseAuthority {
  has(entitlement: 'scheduler'): boolean
}

const POLL_INTERVAL_MS = 15_000
const MAX_MISSED_AGE_MS = 24 * 60 * 60_000
const MISSED_SKIP_GRACE_MS = 5 * 60_000

export class SchedulerManager {
  private pollTimer?: NodeJS.Timeout
  private readonly executing = new Map<string, Promise<ScheduledTask>>()
  private readonly retryWaiters = new Set<{ timer: NodeJS.Timeout; resolve: (continueRunning: boolean) => void }>()
  private active = false

  constructor(
    private readonly store: SchedulerStore,
    private readonly profiles: ProfileStore,
    private readonly launcher: BrowserLauncher,
    private readonly licensing: SchedulerLicenseAuthority,
    private readonly audit: SchedulerAuditLog,
    private readonly onChanged: (tasks: ScheduledTask[]) => void,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
    private readonly maxConcurrent = 2
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 5) throw new Error('计划任务并发数必须在 1 到 5 之间')
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    this.refreshEntitlement()
  }

  list(): ScheduledTask[] { return this.store.list() }

  profileTasks(profileId: string): ScheduledTask[] {
    return this.store.list().filter((task) => task.profileId === profileId)
  }

  async create(draft: ScheduledTaskDraft): Promise<ScheduledTask> {
    this.requireEntitlement()
    this.profiles.get(draft.profileId)
    const task = await this.store.create(draft)
    this.audit.record({ action: 'task-create', outcome: 'success', taskId: task.id, profileId: task.profileId })
    this.changed()
    return task
  }

  async update(id: string, draft: ScheduledTaskDraft): Promise<ScheduledTask> {
    this.requireEntitlement()
    this.assertNotExecuting(id)
    this.profiles.get(draft.profileId)
    const task = await this.store.update(id, draft)
    this.audit.record({ action: 'task-update', outcome: 'success', taskId: id, profileId: task.profileId })
    this.changed()
    return task
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    if (enabled) this.requireEntitlement()
    this.assertNotExecuting(id)
    const task = this.store.get(id)
    this.profiles.get(task.profileId)
    const updated = await this.store.setEnabled(id, enabled)
    this.audit.record({ action: enabled ? 'task-enable' : 'task-disable', outcome: 'success', taskId: id, profileId: task.profileId })
    this.changed()
    return updated
  }

  async remove(id: string): Promise<void> {
    this.assertNotExecuting(id)
    const task = this.store.get(id)
    await this.store.remove(id)
    this.audit.record({ action: 'task-remove', outcome: 'success', taskId: id, profileId: task.profileId })
    this.changed()
  }

  runNow(id: string): Promise<ScheduledTask> {
    this.requireEntitlement()
    if (this.executing.size >= this.maxConcurrent && !this.executing.has(id)) throw new Error(`已有 ${this.maxConcurrent} 个计划任务正在执行，请稍后重试`)
    return this.execute(this.store.get(id), undefined)
  }

  refreshEntitlement(): void {
    const entitled = this.licensing.has('scheduler')
    if (entitled && !this.active) {
      this.active = true
      void this.tick()
      this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs)
      this.pollTimer.unref()
    } else if (!entitled && this.active) {
      this.active = false
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.cancelRetryWaiters()
    }
  }

  async tick(): Promise<void> {
    if (!this.active || !this.licensing.has('scheduler')) return
    const now = this.now().getTime()
    const due = this.store.list().filter((task) => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= now)
    for (const task of due) {
      if (this.executing.has(task.id)) continue
      const scheduledAt = task.nextRunAt!
      if (now - Date.parse(scheduledAt) > MAX_MISSED_AGE_MS || task.missedPolicy === 'skip' && now - Date.parse(scheduledAt) > MISSED_SKIP_GRACE_MS) {
        await this.store.recordResult(task.id, {
          outcome: 'skipped', message: '设备离线或应用关闭期间错过执行时间', attempts: 0, scheduledAt,
          disable: task.schedule.kind === 'once', advanceSchedule: true
        })
        this.audit.record({ action: 'task-skip', outcome: 'skipped', taskId: task.id, profileId: task.profileId, detail: 'missed schedule' })
        this.changed()
        continue
      }
      if (this.executing.size >= this.maxConcurrent) break
      void this.execute(task, scheduledAt).catch(() => undefined)
    }
  }

  async shutdown(): Promise<void> {
    this.active = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.cancelRetryWaiters()
    await Promise.allSettled([...this.executing.values()])
    await this.audit.flush()
  }

  private execute(task: ScheduledTask, scheduledAt?: string): Promise<ScheduledTask> {
    const existing = this.executing.get(task.id)
    if (existing) return existing
    const operation = this.executeInternal(task, scheduledAt)
    this.executing.set(task.id, operation)
    void operation.finally(() => this.executing.delete(task.id)).catch(() => undefined)
    return operation
  }

  private async executeInternal(task: ScheduledTask, scheduledAt?: string): Promise<ScheduledTask> {
    let lastError: unknown
    let attempts = 0
    for (let attempt = 1; attempt <= task.maxRetries + 1; attempt++) {
      attempts = attempt
      try {
        if (task.action === 'launch') await this.launcher.launch(task.profileId)
        else await this.launcher.close(task.profileId)
        const updated = await this.store.recordResult(task.id, {
          outcome: 'success', message: task.action === 'launch' ? '环境已启动' : '环境已关闭', attempts: attempt, scheduledAt,
          disable: scheduledAt !== undefined && task.schedule.kind === 'once', advanceSchedule: scheduledAt !== undefined
        })
        this.audit.record({ action: 'task-run', outcome: 'success', taskId: task.id, profileId: task.profileId, attempt })
        this.changed()
        return updated
      } catch (error) {
        lastError = error
        this.audit.record({
          action: 'task-run', outcome: 'failure', taskId: task.id, profileId: task.profileId, attempt,
          detail: safeErrorText(error)
        })
        if (attempt <= task.maxRetries && await this.waitForRetry(task.retryDelayMinutes * 60_000)) continue
        break
      }
    }
    const message = safeErrorText(lastError ?? '执行失败')
    const updated = await this.store.recordResult(task.id, {
      outcome: 'failure', message, attempts, scheduledAt,
      disable: scheduledAt !== undefined && task.schedule.kind === 'once', advanceSchedule: scheduledAt !== undefined
    })
    this.logger?.error('本地计划任务执行失败', { taskId: task.id, profileId: task.profileId, error: message })
    this.changed()
    throw Object.assign(new Error(message), { task: updated })
  }

  private waitForRetry(milliseconds: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(false)
    return new Promise((resolvePromise) => {
      const waiter = {
        timer: setTimeout(() => { this.retryWaiters.delete(waiter); resolvePromise(true) }, milliseconds),
        resolve: resolvePromise
      }
      waiter.timer.unref()
      this.retryWaiters.add(waiter)
    })
  }

  private cancelRetryWaiters(): void {
    for (const waiter of this.retryWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.retryWaiters.clear()
  }

  private requireEntitlement(): void {
    if (!this.licensing.has('scheduler')) throw new Error('本地计划任务需要 Prism Pro 授权')
  }

  private assertNotExecuting(id: string): void {
    if (this.executing.has(id)) throw new Error('计划任务正在执行，请稍后再修改')
  }

  private changed(): void { this.onChanged(this.store.list()) }
}
