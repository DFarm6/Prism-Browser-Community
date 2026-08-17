import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ScheduledTask, ScheduledTaskDraft, ScheduledTaskSchedule } from '../shared/types'

interface StoredSchedulerData {
  schemaVersion: 1
  tasks: ScheduledTask[]
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'
}

function validSchedule(value: unknown): value is ScheduledTaskSchedule {
  const schedule = value as Partial<ScheduledTaskSchedule>
  if (!schedule || typeof schedule !== 'object') return false
  if (schedule.kind === 'once') return typeof schedule.runAt === 'string' && Number.isFinite(Date.parse(schedule.runAt))
  if ((schedule.kind === 'daily' || schedule.kind === 'weekly') && typeof schedule.time === 'string' && TIME_PATTERN.test(schedule.time)) {
    if (schedule.kind === 'daily') return true
    const weekdays = (schedule as Partial<Extract<ScheduledTaskSchedule, { kind: 'weekly' }>>).weekdays
    return Array.isArray(weekdays) && weekdays.length > 0 && weekdays.length <= 7
      && new Set(weekdays).size === weekdays.length
      && weekdays.every((day: number) => Number.isInteger(day) && day >= 0 && day <= 6)
  }
  return false
}

export function validateScheduledTaskDraft(value: unknown): ScheduledTaskDraft {
  const draft = value as Partial<ScheduledTaskDraft>
  if (!draft || typeof draft !== 'object' || typeof draft.name !== 'string' || !draft.name.trim() || draft.name.trim().length > 80
    || typeof draft.profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(draft.profileId)
    || !['launch', 'close'].includes(draft.action ?? '') || !validSchedule(draft.schedule)
    || typeof draft.enabled !== 'boolean' || !['run_once', 'skip'].includes(draft.missedPolicy ?? '')
    || !Number.isInteger(draft.maxRetries) || draft.maxRetries! < 0 || draft.maxRetries! > 3
    || !Number.isInteger(draft.retryDelayMinutes) || draft.retryDelayMinutes! < 1 || draft.retryDelayMinutes! > 60) {
    throw new Error('计划任务配置无效')
  }
  return {
    name: draft.name.trim(),
    profileId: draft.profileId,
    action: draft.action as ScheduledTaskDraft['action'],
    schedule: structuredClone(draft.schedule),
    enabled: draft.enabled,
    missedPolicy: draft.missedPolicy as ScheduledTaskDraft['missedPolicy'],
    maxRetries: draft.maxRetries!,
    retryDelayMinutes: draft.retryDelayMinutes!
  }
}

export function nextScheduledRun(schedule: ScheduledTaskSchedule, after: Date): string | undefined {
  if (schedule.kind === 'once') {
    const runAt = Date.parse(schedule.runAt)
    return runAt > after.getTime() ? new Date(runAt).toISOString() : undefined
  }
  const [hour, minute] = schedule.time.split(':').map(Number)
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(after)
    candidate.setSeconds(0, 0)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() <= after.getTime()) continue
    if (schedule.kind === 'daily' || schedule.weekdays.includes(candidate.getDay())) return candidate.toISOString()
  }
  return undefined
}

function validateStoredTask(value: unknown): ScheduledTask {
  const task = value as Partial<ScheduledTask>
  const draft = validateScheduledTaskDraft(task)
  if (typeof task.id !== 'string' || !/^[a-f\d-]{36}$/i.test(task.id)
    || typeof task.timezone !== 'string' || !task.timezone || task.timezone.length > 100
    || typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt))
    || typeof task.updatedAt !== 'string' || !Number.isFinite(Date.parse(task.updatedAt))
    || task.nextRunAt !== undefined && (typeof task.nextRunAt !== 'string' || !Number.isFinite(Date.parse(task.nextRunAt)))
    || task.lastRunAt !== undefined && (typeof task.lastRunAt !== 'string' || !Number.isFinite(Date.parse(task.lastRunAt)))
    || task.lastOutcome !== undefined && !['success', 'failure', 'skipped'].includes(task.lastOutcome)
    || task.lastMessage !== undefined && (typeof task.lastMessage !== 'string' || task.lastMessage.length > 500)
    || task.lastAttempts !== undefined && (!Number.isInteger(task.lastAttempts) || task.lastAttempts < 0 || task.lastAttempts > 4)) {
    throw new Error('计划任务文件包含无效记录')
  }
  return { ...draft, ...task, schedule: structuredClone(draft.schedule) } as ScheduledTask
}

export class SchedulerStore {
  readonly path: string
  readonly backupPath: string
  private tasks = new Map<string, ScheduledTask>()
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(vaultPath: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(vaultPath, 'scheduler', 'tasks.json')
    this.backupPath = `${this.path}.backup`
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await this.load(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await this.load(this.backupPath)
          await this.persist(false)
        } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw backupError
          await this.persist()
        }
        return
      }
      await this.load(this.backupPath)
      await this.persist(false)
    }
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()]
      .sort((first, second) => (first.nextRunAt ?? 'z').localeCompare(second.nextRunAt ?? 'z') || first.createdAt.localeCompare(second.createdAt))
      .map((task) => structuredClone(task))
  }

  get(id: string): ScheduledTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error('计划任务不存在')
    return structuredClone(task)
  }

  create(input: ScheduledTaskDraft): Promise<ScheduledTask> {
    return this.mutate(async () => {
      const draft = validateScheduledTaskDraft(input)
      const now = this.now()
      const nextRunAt = draft.enabled ? nextScheduledRun(draft.schedule, now) : undefined
      if (draft.enabled && !nextRunAt) throw new Error('启用的一次性任务必须安排在未来')
      const timestamp = now.toISOString()
      const task: ScheduledTask = {
        ...draft,
        id: randomUUID(),
        timezone: localTimezone(),
        createdAt: timestamp,
        updatedAt: timestamp,
        nextRunAt
      }
      this.tasks.set(task.id, task)
      await this.persist()
      return structuredClone(task)
    })
  }

  update(id: string, input: ScheduledTaskDraft): Promise<ScheduledTask> {
    return this.mutate(async () => {
      const current = this.tasks.get(id)
      if (!current) throw new Error('计划任务不存在')
      const draft = validateScheduledTaskDraft(input)
      const now = this.now()
      const nextRunAt = draft.enabled ? nextScheduledRun(draft.schedule, now) : undefined
      if (draft.enabled && !nextRunAt) throw new Error('启用的一次性任务必须安排在未来')
      const task: ScheduledTask = { ...current, ...draft, timezone: localTimezone(), updatedAt: now.toISOString(), nextRunAt }
      this.tasks.set(id, task)
      await this.persist()
      return structuredClone(task)
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    const current = this.get(id)
    return this.update(id, { ...current, enabled })
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.tasks.delete(id)) throw new Error('计划任务不存在')
      await this.persist()
    })
  }

  recordResult(id: string, result: {
    outcome: ScheduledTask['lastOutcome']
    message: string
    attempts: number
    scheduledAt?: string
    disable?: boolean
    advanceSchedule?: boolean
  }): Promise<ScheduledTask> {
    return this.mutate(async () => {
      const current = this.tasks.get(id)
      if (!current) throw new Error('计划任务不存在')
      const now = this.now()
      const enabled = result.disable ? false : current.enabled
      const nextRunAt = !enabled ? undefined
        : result.advanceSchedule === false ? current.nextRunAt
          : nextScheduledRun(current.schedule, new Date(Math.max(now.getTime(), Date.parse(result.scheduledAt ?? current.nextRunAt ?? now.toISOString()))))
      const task: ScheduledTask = {
        ...current,
        enabled: enabled && Boolean(nextRunAt),
        nextRunAt,
        lastRunAt: now.toISOString(),
        lastOutcome: result.outcome,
        lastMessage: result.message.slice(0, 500),
        lastAttempts: result.attempts,
        updatedAt: now.toISOString()
      }
      this.tasks.set(id, task)
      await this.persist()
      return structuredClone(task)
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(operation, operation)
    this.mutation = current.then(() => undefined, () => undefined)
    return current
  }

  private async load(path: string): Promise<void> {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredSchedulerData>
    if (value.schemaVersion !== 1 || !Array.isArray(value.tasks) || value.tasks.length > 500) throw new Error('计划任务文件格式无效')
    const tasks = value.tasks.map(validateStoredTask)
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('计划任务 ID 重复')
    this.tasks = new Map(tasks.map((task) => [task.id, task]))
  }

  private async persist(backupExisting = true): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    if (backupExisting) {
      try { await access(this.path); await copyFile(this.path, this.backupPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const temporary = `${this.path}.tmp`
    const data: StoredSchedulerData = { schemaVersion: 1, tasks: this.list() }
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}
