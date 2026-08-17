import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SystemProcess {
  pid: number
  command: string
}

export interface ProcessInspector {
  list(): Promise<SystemProcess[]>
  terminate(pid: number, userDataPath: string): Promise<void>
}

export function parsePosixProcessList(output: string): SystemProcess[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), command: match[2] }]
  })
}

function normalize(value: string): string {
  const result = value.replaceAll('"', '').replaceAll('\\', '/')
  return process.platform === 'win32' ? result.toLowerCase() : result
}

export function commandUsesUserData(command: string, userDataPath: string): boolean {
  const normalizedCommand = normalize(command)
  const marker = `--user-data-dir=${normalize(userDataPath)}`
  let offset = normalizedCommand.indexOf(marker)
  while (offset >= 0) {
    const next = normalizedCommand[offset + marker.length]
    if (next === undefined || /\s/.test(next)) return true
    offset = normalizedCommand.indexOf(marker, offset + 1)
  }
  return false
}

export function findManagedProcess(processes: SystemProcess[], userDataPath: string): SystemProcess | undefined {
  const matches = processes.filter((item) => item.pid !== process.pid && commandUsesUserData(item.command, userDataPath))
  return matches.find((item) => !/(?:^|\s)--type=/.test(item.command)) ?? matches[0]
}

export function processMatchesUserData(
  processes: SystemProcess[],
  pid: number,
  userDataPath: string
): boolean {
  return processes.some((item) => item.pid === pid && commandUsesUserData(item.command, userDataPath))
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForExit(pid: number, durationMs: number): Promise<boolean> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!await processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !await processExists(pid)
}

export class SystemProcessInspector implements ProcessInspector {
  async list(): Promise<SystemProcess[]> {
    if (process.platform === 'win32') {
      const command = "$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir=*' } | Select-Object ProcessId,CommandLine; @($items) | ConvertTo-Json -Compress"
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { maxBuffer: 8 * 1024 * 1024 })
      if (!stdout.trim()) return []
      const parsed = JSON.parse(stdout) as { ProcessId: number; CommandLine: string | null } | Array<{ ProcessId: number; CommandLine: string | null }>
      const items = Array.isArray(parsed) ? parsed : [parsed]
      return items.filter((item) => item.CommandLine).map((item) => ({ pid: item.ProcessId, command: item.CommandLine! }))
    }
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 })
    return parsePosixProcessList(stdout)
  }

  async terminate(pid: number, userDataPath: string): Promise<void> {
    if (!processMatchesUserData(await this.list(), pid, userDataPath)) {
      throw new Error('遗留进程已经退出或 PID 已被其他进程复用，已取消终止操作')
    }
    if (process.platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T']).catch(() => undefined)
      if (!await waitForExit(pid, 5000)) {
        if (!processMatchesUserData(await this.list(), pid, userDataPath)) return
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
      }
      return
    }
    process.kill(pid, 'SIGTERM')
    if (!await waitForExit(pid, 5000)) {
      if (!processMatchesUserData(await this.list(), pid, userDataPath)) return
      process.kill(pid, 'SIGKILL')
    }
  }
}
