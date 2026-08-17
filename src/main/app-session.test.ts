import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSessionTracker } from './app-session'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function vault(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'prism-app-session-'))
  temporaryPaths.push(path)
  return path
}

describe('AppSessionTracker', () => {
  it('removes the active marker after a clean shutdown', async () => {
    const path = await vault()
    const first = new AppSessionTracker(path)
    expect((await first.begin('0.1.0')).uncleanSessionCount).toBe(0)
    await first.complete()
    await expect(access(first.markerPath)).rejects.toThrow()

    const second = new AppSessionTracker(path)
    expect((await second.begin('0.1.0')).previousUnclean).toBeUndefined()
  })

  it('detects and retains an unclean previous session', async () => {
    const path = await vault()
    const first = new AppSessionTracker(path)
    const firstSession = await first.begin('0.1.0')

    const recovered = new AppSessionTracker(path)
    const snapshot = await recovered.begin('0.1.1')

    expect(snapshot.previousUnclean).toMatchObject({
      sessionId: firstSession.current.sessionId,
      appVersion: '0.1.0',
      markerCorrupt: false
    })
    expect(snapshot.uncleanSessionCount).toBe(1)
    expect(JSON.parse(await readFile(recovered.historyPath, 'utf8'))).toHaveLength(1)
  })

  it('preserves a corrupt marker as an unclean-session diagnostic', async () => {
    const path = await vault()
    const tracker = new AppSessionTracker(path)
    await tracker.begin('0.1.0')
    await writeFile(tracker.markerPath, '{broken')

    const recovered = new AppSessionTracker(path)
    expect((await recovered.begin('0.1.1')).previousUnclean).toMatchObject({ markerCorrupt: true })
  })

  it('will not remove a marker owned by a newer session', async () => {
    const path = await vault()
    const tracker = new AppSessionTracker(path)
    await tracker.begin('0.1.0')
    await writeFile(tracker.markerPath, JSON.stringify({
      schemaVersion: 1,
      sessionId: 'newer-session',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      appVersion: '0.1.1',
      platform: process.platform
    }))

    await expect(tracker.complete()).rejects.toThrow('已变化')
    await expect(access(tracker.markerPath)).resolves.toBeUndefined()
  })

  it('bounds retained unclean-session history', async () => {
    const path = await vault()
    let latest: AppSessionTracker | undefined
    for (let index = 0; index < 24; index += 1) {
      latest = new AppSessionTracker(path)
      await latest.begin(`0.1.${index}`)
    }

    expect(latest?.snapshot().uncleanSessionCount).toBe(20)
    expect(JSON.parse(await readFile(latest!.historyPath, 'utf8'))).toHaveLength(20)
  })
})
