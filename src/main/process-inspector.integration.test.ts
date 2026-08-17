import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findManagedProcess, SystemProcessInspector } from './process-inspector'

const temporaryPaths: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function waitUntil<T>(operation: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await operation()
    if (result !== undefined) return result
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('SystemProcessInspector real process integration', () => {
  it('finds a real managed process, rejects a mismatched directory and safely terminates the match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism process recovery '))
    temporaryPaths.push(root)
    const userDataPath = join(root, 'profile data')
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
      '--',
      `--user-data-dir=${userDataPath}`
    ], { stdio: 'ignore', windowsHide: true })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const inspector = new SystemProcessInspector()

    const matched = await waitUntil(async () => findManagedProcess(await inspector.list(), userDataPath))
    expect(matched.pid).toBe(child.pid)
    await expect(inspector.terminate(matched.pid, `${userDataPath}-other`)).rejects.toThrow('已取消终止操作')
    expect(child.exitCode).toBeNull()

    await inspector.terminate(matched.pid, userDataPath)
    await exited
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
  }, 15_000)
})
