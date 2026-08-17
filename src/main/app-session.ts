import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppRecoveryStatus } from '../shared/types'

interface AppSessionMarker {
  schemaVersion: 1
  sessionId: string
  pid: number
  startedAt: string
  appVersion: string
  platform: NodeJS.Platform
}

export interface UncleanAppSession {
  sessionId?: string
  pid?: number
  startedAt?: string
  appVersion?: string
  platform?: NodeJS.Platform
  detectedAt: string
  markerCorrupt: boolean
}

export interface AppSessionSnapshot {
  current: AppSessionMarker
  previousUnclean?: UncleanAppSession
  uncleanSessionCount: number
}

const MAX_UNCLEAN_SESSIONS = 20

function validMarker(value: unknown): value is AppSessionMarker {
  if (!value || typeof value !== 'object') return false
  const marker = value as Partial<AppSessionMarker>
  return marker.schemaVersion === 1
    && typeof marker.sessionId === 'string'
    && typeof marker.pid === 'number'
    && typeof marker.startedAt === 'string'
    && typeof marker.appVersion === 'string'
    && typeof marker.platform === 'string'
}

function validHistory(value: unknown): UncleanAppSession[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is UncleanAppSession => Boolean(
    entry && typeof entry === 'object'
    && typeof (entry as UncleanAppSession).detectedAt === 'string'
    && typeof (entry as UncleanAppSession).markerCorrupt === 'boolean'
  )).slice(-MAX_UNCLEAN_SESSIONS)
}

export class AppSessionTracker {
  readonly directory: string
  readonly markerPath: string
  readonly historyPath: string
  private snapshotValue?: AppSessionSnapshot

  constructor(vaultPath: string) {
    this.directory = join(vaultPath, 'runtime')
    this.markerPath = join(this.directory, 'app-session.json')
    this.historyPath = join(this.directory, 'unclean-sessions.json')
  }

  async begin(appVersion: string): Promise<AppSessionSnapshot> {
    if (this.snapshotValue) return this.snapshot()
    await mkdir(this.directory, { recursive: true })
    let previousRaw: string | undefined
    try {
      previousRaw = await readFile(this.markerPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    let previousUnclean: UncleanAppSession | undefined
    let history = await this.readHistory()
    if (previousRaw !== undefined) {
      let previous: unknown
      try {
        previous = JSON.parse(previousRaw)
      } catch {
        previous = undefined
      }
      previousUnclean = validMarker(previous)
        ? {
            sessionId: previous.sessionId,
            pid: previous.pid,
            startedAt: previous.startedAt,
            appVersion: previous.appVersion,
            platform: previous.platform,
            detectedAt: new Date().toISOString(),
            markerCorrupt: false
          }
        : {
            detectedAt: new Date().toISOString(),
            markerCorrupt: true
          }
      history = [...history, previousUnclean].slice(-MAX_UNCLEAN_SESSIONS)
      await this.writeAtomic(this.historyPath, history)
    }

    const current: AppSessionMarker = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      appVersion,
      platform: process.platform
    }
    await this.writeAtomic(this.markerPath, current)
    this.snapshotValue = {
      current,
      previousUnclean,
      uncleanSessionCount: history.length
    }
    return this.snapshot()
  }

  snapshot(): AppSessionSnapshot {
    if (!this.snapshotValue) throw new Error('应用会话尚未开始')
    return structuredClone(this.snapshotValue)
  }

  recoveryStatus(): AppRecoveryStatus {
    const snapshot = this.snapshot()
    return {
      previousUnclean: Boolean(snapshot.previousUnclean),
      previousStartedAt: snapshot.previousUnclean?.startedAt,
      markerCorrupt: snapshot.previousUnclean?.markerCorrupt === true,
      uncleanSessionCount: snapshot.uncleanSessionCount
    }
  }

  async complete(): Promise<void> {
    if (!this.snapshotValue) return
    let marker: unknown
    try {
      marker = JSON.parse(await readFile(this.markerPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('应用会话标记损坏，已保留供下次启动诊断')
    }
    if (!validMarker(marker) || marker.sessionId !== this.snapshotValue.current.sessionId) {
      throw new Error('应用会话标记已变化，已拒绝删除')
    }
    await rm(this.markerPath)
  }

  private async readHistory(): Promise<UncleanAppSession[]> {
    try {
      return validHistory(JSON.parse(await readFile(this.historyPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
      throw error
    }
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}
