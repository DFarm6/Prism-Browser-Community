import { describe, expect, it } from 'vitest'
import { commandUsesUserData, findManagedProcess, parsePosixProcessList, processMatchesUserData } from './process-inspector'

describe('process inspector', () => {
  it('parses POSIX process output and prefers the browser process over renderers', () => {
    const processes = parsePosixProcessList(`
      101 /Applications/Chromium --user-data-dir=/vault/profile-a --type=renderer
      99 /Applications/Chromium --user-data-dir=/vault/profile-a
      invalid
    `)

    expect(processes).toHaveLength(2)
    expect(findManagedProcess(processes, '/vault/profile-a')?.pid).toBe(99)
  })

  it('matches paths containing spaces without accepting prefix collisions', () => {
    expect(commandUsesUserData(
      '/Applications/Chromium --user-data-dir=/Users/wei/Application Support/prism/profiles/a --flag',
      '/Users/wei/Application Support/prism/profiles/a'
    )).toBe(true)
    expect(commandUsesUserData(
      '/Applications/Chromium --user-data-dir=/vault/profile-a-copy --flag',
      '/vault/profile-a'
    )).toBe(false)
  })

  it('matches quoted Windows-style user data arguments', () => {
    expect(commandUsesUserData(
      'C:\\Chromium\\chrome.exe "--user-data-dir=C:\\Users\\Wei\\Prism Data\\profile-1"',
      'C:\\Users\\Wei\\Prism Data\\profile-1'
    )).toBe(true)
  })

  it('requires both the original PID and profile path before a destructive signal', () => {
    const processes = [
      { pid: 400, command: '/Applications/Chromium --user-data-dir=/vault/profile-a' },
      { pid: 401, command: '/Applications/Chromium --user-data-dir=/vault/profile-b' }
    ]
    expect(processMatchesUserData(processes, 400, '/vault/profile-a')).toBe(true)
    expect(processMatchesUserData(processes, 400, '/vault/profile-b')).toBe(false)
    expect(processMatchesUserData([{ pid: 400, command: '/usr/bin/other-process' }], 400, '/vault/profile-a')).toBe(false)
  })
})
