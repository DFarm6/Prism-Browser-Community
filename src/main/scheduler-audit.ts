import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface SchedulerAuditEvent {
  action: 'task-create' | 'task-update' | 'task-enable' | 'task-disable' | 'task-remove' | 'task-run' | 'task-skip'
  outcome: 'success' | 'failure' | 'skipped'
  taskId?: string
  profileId?: string
  attempt?: number
  detail?: string
}

export class SchedulerAuditLog {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'logs', 'scheduler-audit.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      if ((await stat(this.path)).size >= 10 * 1024 * 1024) await rename(this.path, `${this.path}.previous`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(this.path, '', { flag: 'a', mode: 0o600 })
  }

  record(event: SchedulerAuditEvent): void {
    const safe = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
      taskId: event.taskId?.slice(0, 100),
      profileId: event.profileId?.slice(0, 100),
      detail: event.detail?.slice(0, 300)
    }
    this.queue = this.queue.then(() => writeFile(this.path, `${JSON.stringify(safe)}\n`, { flag: 'a', encoding: 'utf8', mode: 0o600 }))
      .catch(() => undefined)
  }

  flush(): Promise<void> { return this.queue }
}
