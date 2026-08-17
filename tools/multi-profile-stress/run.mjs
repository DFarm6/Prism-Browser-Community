#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { analyzeStressRun } from './analysis.mjs'

const execFileAsync = promisify(execFile)
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function parseArguments(argv) {
  const options = {
    browser: '',
    output: resolve('multi-profile-stress.json'),
    profiles: 12,
    concurrency: 3,
    durationSeconds: 120,
    sampleIntervalSeconds: 5,
    keepData: false,
    visible: false,
    debugTransport: 'auto'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--browser') options.browser = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--profiles') options.profiles = parseInteger(argv[++index], '--profiles', 1, 30)
    else if (argument === '--concurrency') options.concurrency = parseInteger(argv[++index], '--concurrency', 1, 10)
    else if (argument === '--duration-seconds') options.durationSeconds = parseInteger(argv[++index], '--duration-seconds', 5, 43_200)
    else if (argument === '--sample-interval-seconds') options.sampleIntervalSeconds = parseInteger(argv[++index], '--sample-interval-seconds', 1, 300)
    else if (argument === '--keep-data') options.keepData = true
    else if (argument === '--visible') options.visible = true
    else if (argument === '--debug-transport') options.debugTransport = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.browser) throw new Error('Usage: npm run audit:stress -- --browser /path/to/Chromium [options]')
  if (!['auto', 'pipe', 'websocket'].includes(options.debugTransport)) {
    throw new Error('--debug-transport must be auto, pipe or websocket')
  }
  return options
}

function transport(options) {
  return options.debugTransport === 'auto'
    ? process.platform === 'win32' ? 'websocket' : 'pipe'
    : options.debugTransport
}

async function startServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html><body><canvas id="surface" width="640" height="360"></canvas><script>
      const stable = Array.from({ length: 2000 }, (_, index) => ({ index, value: 'prism-' + index }))
      const canvas = document.querySelector('#surface')
      const context = canvas.getContext('2d')
      let frame = 0
      setInterval(() => {
        context.fillStyle = 'hsl(' + (frame++ % 360) + ' 60% 45%)'
        context.fillRect(0, 0, 640, 360)
        context.fillStyle = '#fff'
        context.font = '24px sans-serif'
        context.fillText('Prism stability ' + location.search, 20, 48)
        localStorage.setItem('heartbeat', String(Date.now()))
      }, 250)
      window.__prismStressReady = stable.length === 2000
    </script></body></html>`)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind local stress server')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeIdleConnections()
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    }
  }
}

class PipeCdp {
  constructor(readable, writable) {
    this.readable = readable
    this.writable = writable
    this.sequence = 0
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    readable.on('data', (chunk) => this.onData(chunk))
    readable.on('close', () => this.rejectAll(new Error('CDP pipe closed')))
    readable.on('error', (error) => this.rejectAll(error))
  }
  async open() {}
  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveCommand(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.writable.write(`${JSON.stringify(payload)}\0`)
    })
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const delimiter = this.buffer.indexOf(0)
      if (delimiter < 0) return
      const text = this.buffer.subarray(0, delimiter).toString('utf8')
      this.buffer = this.buffer.subarray(delimiter + 1)
      if (!text) continue
      const message = JSON.parse(text)
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
  close() {
    this.writable.end()
    this.readable.destroy()
    this.rejectAll(new Error('CDP connection closed'))
  }
}

class WebSocketCdp {
  constructor(url) {
    this.url = url
    this.sequence = 0
    this.pending = new Map()
  }
  async open() {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket transport requires Node.js 22 or newer')
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => this.onMessage(event.data))
    this.socket.addEventListener('close', () => this.rejectAll(new Error('CDP WebSocket closed')))
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), 15_000)
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed')) }, { once: true })
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveCommand(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify(payload))
    })
  }
  onMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
  close() {
    this.socket?.close()
    this.rejectAll(new Error('CDP connection closed'))
  }
}

async function waitForWebSocket(userDataDir, child) {
  const path = join(userDataDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chromium exited before CDP startup')
    try {
      const [port, browserPath] = (await readFile(path, 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port) && browserPath?.startsWith('/')) return `ws://127.0.0.1:${port}${browserPath}`
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Chromium DevToolsActivePort')
}

async function launchProfile(options, root, serverUrl, index, state) {
  const userDataDir = join(root, `profile-${String(index + 1).padStart(2, '0')}`)
  await mkdir(userDataDir, { recursive: true })
  const selectedTransport = transport(options)
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only'
  ]
  if (!options.visible) args.push('--headless=new')
  if (selectedTransport === 'pipe') args.push('--remote-debugging-pipe')
  else args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0')
  args.push('about:blank')
  const child = spawn(options.browser, args, {
    stdio: selectedTransport === 'pipe'
      ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env }
  })
  const session = { index, userDataDir, child, client: undefined, expectedExit: false, closed: false, stderr: '' }
  state.sessions.push(session)
  child.stderr.on('data', (chunk) => { session.stderr = `${session.stderr}${chunk}`.slice(-8192) })
  child.once('exit', (code, signal) => {
    if (!session.expectedExit) state.unexpectedExits.push({ profile: index + 1, code, signal })
  })
  try {
    session.client = selectedTransport === 'pipe'
      ? new PipeCdp(child.stdio[4], child.stdio[3])
      : new WebSocketCdp(await waitForWebSocket(userDataDir, child))
    await session.client.open()
    await session.client.send('Browser.getVersion')
    const { targetId } = await session.client.send('Target.createTarget', { url: `${serverUrl}?profile=${index + 1}` })
    const { sessionId } = await session.client.send('Target.attachToTarget', { targetId, flatten: true })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await session.client.send('Runtime.evaluate', {
        expression: 'window.__prismStressReady === true',
        returnByValue: true
      }, sessionId)
      if (ready.result?.value === true) return session
      if (attempt === 99) throw new Error('Stress page did not become ready')
      await delay(100)
    }
    return session
  } catch (error) {
    session.expectedExit = true
    child.kill('SIGKILL')
    throw new Error(`${error instanceof Error ? error.message : String(error)}${session.stderr ? `; stderr: ${session.stderr}` : ''}`)
  }
}

async function mapLimit(items, limit, operation, state) {
  let cursor = 0
  async function worker() {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      state.activeLaunches += 1
      state.maxObservedLaunches = Math.max(state.maxObservedLaunches, state.activeLaunches)
      try {
        await operation(items[index])
      } finally {
        state.activeLaunches -= 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

async function listProcesses() {
  if (process.platform === 'win32') {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { maxBuffer: 16 * 1024 * 1024 })
    const parsed = JSON.parse(stdout)
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId),
      rssBytes: Number(item.WorkingSetSize),
      cpuPercent: null,
      command: typeof item.CommandLine === 'string' ? item.CommandLine : ''
    }))
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)
    return match ? [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      command: match[5]
    }] : []
  })
}

function commandUsesUserData(command, userDataPath) {
  const normalizedCommand = command.replaceAll('"', '').replaceAll('\\', '/')
  const normalizedPath = userDataPath.replaceAll('\\', '/')
  const marker = `--user-data-dir=${process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath}`
  const haystack = process.platform === 'win32' ? normalizedCommand.toLowerCase() : normalizedCommand
  let offset = haystack.indexOf(marker)
  while (offset >= 0) {
    const next = haystack[offset + marker.length]
    if (next === undefined || /\s/.test(next)) return true
    offset = haystack.indexOf(marker, offset + 1)
  }
  return false
}

async function sampleProcesses(rootPids) {
  const processes = await listProcesses()
  const selected = new Set(rootPids)
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (!selected.has(item.pid) && selected.has(item.ppid)) {
        selected.add(item.pid)
        changed = true
      }
    }
  }
  const relevant = processes.filter((item) => selected.has(item.pid))
  return {
    capturedAt: new Date().toISOString(),
    capturedAtMs: Date.now(),
    activeRootPids: rootPids.filter((pid) => processes.some((item) => item.pid === pid)).length,
    processCount: relevant.length,
    rssBytes: relevant.reduce((sum, item) => sum + item.rssBytes, 0),
    cpuPercent: relevant.some((item) => item.cpuPercent === null)
      ? null
      : relevant.reduce((sum, item) => sum + item.cpuPercent, 0)
  }
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(milliseconds)])
  return child.exitCode !== null || child.signalCode !== null
}

async function closeSession(session) {
  if (session.closed) return
  session.closed = true
  session.expectedExit = true
  if (session.client) {
    await Promise.race([session.client.send('Browser.close').catch(() => undefined), delay(1000)])
    session.client.close()
  }
  if (!await waitForExit(session.child, 5000)) session.child.kill('SIGTERM')
  if (!await waitForExit(session.child, 2000)) session.child.kill('SIGKILL')
  await waitForExit(session.child, 2000)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await access(options.browser)
  const server = await startServer()
  const root = await mkdtemp(join(tmpdir(), 'prism-multi-profile-stress-'))
  const state = { sessions: [], unexpectedExits: [], activeLaunches: 0, maxObservedLaunches: 0 }
  const launchFailures = []
  const samples = []
  try {
    await mapLimit(Array.from({ length: options.profiles }, (_, index) => index), options.concurrency, async (index) => {
      try {
        await launchProfile(options, root, server.url, index, state)
      } catch (error) {
        launchFailures.push({ profile: index + 1, error: error instanceof Error ? error.message : String(error) })
      }
    }, state)
    const launched = state.sessions.filter((session) => session.client && !session.expectedExit)
    const rootPids = launched.map((session) => session.child.pid).filter(Number.isInteger)
    await delay(2000)
    samples.push(await sampleProcesses(rootPids))
    const deadline = Date.now() + options.durationSeconds * 1000
    while (Date.now() < deadline) {
      await delay(Math.min(options.sampleIntervalSeconds * 1000, Math.max(0, deadline - Date.now())))
      samples.push(await sampleProcesses(rootPids))
    }
    await Promise.allSettled(state.sessions.map(closeSession))
    await delay(500)
    const finalProcesses = await listProcesses()
    const remainingRootPids = rootPids.filter((pid) => finalProcesses.some((item) => item.pid === pid))
    const userDataDirectories = state.sessions.map((session) => session.userDataDir)
    const remainingManagedPids = finalProcesses
      .filter((item) => userDataDirectories.some((path) => commandUsesUserData(item.command, path)))
      .map((item) => item.pid)
    const report = analyzeStressRun({
      profileCount: options.profiles,
      launchedProfiles: launched.length,
      uniqueUserDataDirectories: new Set(state.sessions.map((session) => session.userDataDir)).size,
      launchConcurrency: options.concurrency,
      maxObservedLaunches: state.maxObservedLaunches,
      launchFailures,
      unexpectedExits: state.unexpectedExits,
      remainingRootPids,
      remainingManagedPids,
      samples
    })
    report.browser = options.browser
    report.mode = options.visible ? 'visible' : 'headless'
    report.sampleSeries = samples
    report.retainedDataPath = options.keepData ? root : undefined
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Multi-profile stress audit: ${report.passed ? 'PASS' : 'FAIL'}`)
    for (const [name, passed] of Object.entries(report.checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
    console.log(`Profiles: ${report.launchedProfiles}/${report.profileCount}; peak RSS: ${(report.memory.peakRssBytes / 1024 / 1024).toFixed(1)} MiB`)
    console.log(`Report: ${options.output}`)
    if (!report.passed) process.exitCode = 1
  } finally {
    await Promise.allSettled(state.sessions.map((session) => closeSession(session)))
    await server.close()
    if (!options.keepData) await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
