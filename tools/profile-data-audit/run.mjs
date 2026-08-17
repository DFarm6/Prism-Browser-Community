#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const PROFILE_DATA_AUDIT_TOOL_VERSION = 3
const CDP_LAUNCH_CONTRACT = 'websocket-http-navigation-v2'

function parseArguments(argv) {
  const options = {
    browser: '',
    output: resolve('profile-data-audit.json'),
    keepData: false,
    allowNoSandbox: false,
    debugTransport: 'auto'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--browser') options.browser = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--keep-data') options.keepData = true
    else if (argument === '--allow-no-sandbox') options.allowNoSandbox = true
    else if (argument === '--debug-transport') options.debugTransport = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.browser) {
    throw new Error('Usage: node tools/profile-data-audit/run.mjs --browser /path/to/Chromium [--output report.json] [--keep-data]')
  }
  if (!['auto', 'pipe', 'websocket'].includes(options.debugTransport)) {
    throw new Error('--debug-transport must be auto, pipe or websocket')
  }
  return options
}

function resolvedDebugTransport(options) {
  if (options.debugTransport !== 'auto') return options.debugTransport
  return process.platform === 'win32' ? 'websocket' : 'pipe'
}

async function startAuditServer() {
  const serviceWorker = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
`
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.setHeader('Cache-Control', 'no-store')
    if (pathname === '/profile-data-audit-sw.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      response.setHeader('Service-Worker-Allowed', '/')
      response.end(serviceWorker)
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><title>Prism profile data audit</title></head><body>audit</body></html>')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start local profile data audit server')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeIdleConnections()
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    }
  }
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.sequence = 0
    this.pending = new Map()
    this.socket = undefined
  }

  async open() {
    if (typeof globalThis.WebSocket !== 'function') throw new Error('Profile data audit requires Node.js 22 or newer')
    let lastError
    for (let attempt = 0; attempt < 20; attempt++) {
      const socket = new WebSocket(this.url)
      try {
        await new Promise((resolveOpen, reject) => {
          const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 1_000)
          socket.addEventListener('open', () => {
            clearTimeout(timer)
            resolveOpen()
          }, { once: true })
          socket.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('CDP connection failed'))
          }, { once: true })
        })
        this.socket = socket
        this.socket.addEventListener('message', (event) => this.onMessage(event.data))
        this.socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed')))
        return
      } catch (error) {
        lastError = error
        try {
          socket.close()
        } catch {
          // A socket that failed while connecting may already be closed.
        }
        await delay(100)
      }
    }
    throw lastError ?? new Error('CDP connection failed')
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveCommand(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.socket.send(JSON.stringify(message))
    })
  }

  close() {
    this.socket?.close()
    this.rejectPending(new Error('CDP connection closed'))
  }

  onMessage(data) {
    let message
    try {
      message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    } catch (error) {
      this.rejectPending(error)
      return
    }
    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
    else pending.resolve(message.result)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

class CdpPipeClient {
  constructor(readable, writable) {
    this.readable = readable
    this.writable = writable
    this.sequence = 0
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.readable.on('data', (chunk) => this.onData(chunk))
    this.readable.on('error', (error) => this.rejectPending(error))
    this.readable.on('close', () => this.rejectPending(new Error('CDP pipe closed')))
  }

  async open() {
    // Chromium consumes commands from descriptor 3 and writes responses to 4.
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveCommand(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.writable.write(`${JSON.stringify(message)}\0`)
    })
  }

  close() {
    this.writable.end()
    this.readable.destroy()
    this.rejectPending(new Error('CDP connection closed'))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const delimiter = this.buffer.indexOf(0)
      if (delimiter < 0) return
      const payload = this.buffer.subarray(0, delimiter).toString('utf8')
      this.buffer = this.buffer.subarray(delimiter + 1)
      if (!payload) continue
      let message
      try {
        message = JSON.parse(payload)
      } catch (error) {
        this.rejectPending(error)
        continue
      }
      if (!message.id) continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
      else pending.resolve(message.result)
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

async function waitForEndpoint(userDataDir, child) {
  const activePort = join(userDataDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chromium exited during startup (code=${child.exitCode ?? '-'}, signal=${child.signalCode ?? '-'})`)
    }
    try {
      const [port, browserPath] = (await readFile(activePort, 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port) && browserPath?.startsWith('/')) return `ws://127.0.0.1:${port}${browserPath}`
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Chromium DevTools endpoint')
}

const STORAGE_EXPRESSION = String.raw`
(async (token, writeValues) => {
  const databaseValue = async (write) => new Promise((resolve, reject) => {
    const request = indexedDB.open('prism-profile-data-audit', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('values')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('values', write ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('values')
      if (write) store.put(token, 'profile-token')
      const getRequest = store.get('profile-token')
      getRequest.onerror = () => reject(getRequest.error)
      getRequest.onsuccess = () => {
        const value = getRequest.result ?? null
        transaction.oncomplete = () => {
          database.close()
          resolve(value)
        }
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })

  const originFileValue = async (write) => {
    if (!navigator.storage?.getDirectory) return { supported: false, value: null }
    const root = await navigator.storage.getDirectory()
    if (write) {
      const handle = await root.getFileHandle('prism-profile-token.txt', { create: true })
      const writable = await handle.createWritable()
      await writable.write(token)
      await writable.close()
    }
    try {
      const handle = await root.getFileHandle('prism-profile-token.txt')
      return { supported: true, value: await (await handle.getFile()).text() }
    } catch (error) {
      if (error?.name === 'NotFoundError') return { supported: true, value: null }
      throw error
    }
  }

  if (writeValues) {
    document.cookie = 'prism_profile_token=' + encodeURIComponent(token) + '; path=/; max-age=31536000; SameSite=Lax'
    localStorage.setItem('prism-profile-token', token)
    const cache = await caches.open('prism-profile-data-audit')
    await cache.put('/profile-data-audit-cache-value', new Response(token))
    await navigator.serviceWorker.register('/profile-data-audit-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
  }

  const cookie = document.cookie.split(';').map(value => value.trim())
    .find(value => value.startsWith('prism_profile_token='))
  const cache = await caches.open('prism-profile-data-audit')
  const cacheResponse = await cache.match('/profile-data-audit-cache-value')
  const registrations = await navigator.serviceWorker.getRegistrations()
  return {
    cookie: cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : null,
    localStorage: localStorage.getItem('prism-profile-token'),
    indexedDB: await databaseValue(writeValues),
    cacheStorage: cacheResponse ? await cacheResponse.text() : null,
    serviceWorker: registrations.some(registration => registration.scope === location.origin + '/'),
    originFileSystem: await originFileValue(writeValues)
  }
})`

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(milliseconds)
  ])
  return child.exitCode !== null || child.signalCode !== null
}

async function collect(options, userDataDir, auditUrl, token, writeValues, phase) {
  await mkdir(userDataDir, { recursive: true })
  const debugTransport = resolvedDebugTransport(options)
  if (debugTransport === 'websocket') {
    // The random debugging port file persists in a reused profile. Remove it
    // before every launch so this run cannot connect to the previous dead port.
    await rm(join(userDataDir, 'DevToolsActivePort'), { force: true })
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    // Audit profiles are disposable and must never pause on the interactive
    // macOS Safe Storage keychain dialog. Product profiles keep their normal
    // credential-storage policy; this flag is scoped to this local audit.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only'
  ]
  if (debugTransport === 'pipe') args.push('--remote-debugging-pipe')
  else args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0')
  if (options.allowNoSandbox) args.push('--no-sandbox')
  args.push('about:blank')
  const child = spawn(options.browser, args, {
    stdio: debugTransport === 'pipe'
      ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env }
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
  let client
  try {
    client = debugTransport === 'pipe'
      ? new CdpPipeClient(child.stdio[4], child.stdio[3])
      : new CdpClient(await waitForEndpoint(userDataDir, child))
    await client.open()
    // Some Chromium releases can create a target before the requested HTTP navigation
    // commits. Attach to a deterministic about:blank target, enable Page, then
    // explicitly navigate so storage is never evaluated in the opaque initial
    // document and navigation failures remain observable.
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Page.enable', {}, sessionId)
    const navigation = await client.send('Page.navigate', { url: auditUrl }, sessionId)
    if (navigation.errorText) throw new Error(`Could not navigate to the local audit origin: ${navigation.errorText}`)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await client.send('Runtime.evaluate', {
        expression: 'location.href.startsWith("http://127.0.0.1:") && document.readyState === "complete"',
        returnByValue: true
      }, sessionId)
      if (ready.result?.value === true) break
      if (attempt === 99) throw new Error('Audit page did not finish loading')
      await delay(100)
    }
    const result = await client.send('Runtime.evaluate', {
      expression: `${STORAGE_EXPRESSION}(${JSON.stringify(token)}, ${writeValues})`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Storage expression failed')
    }
    return result.result.value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${phase}: ${message}${stderr ? `\nChromium stderr:\n${stderr}` : ''}`)
  } finally {
    if (client) {
      await Promise.race([client.send('Browser.close').catch(() => undefined), delay(1_000)])
      client.close()
    }
    if (!await waitForExit(child, 5_000)) child.kill('SIGTERM')
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL')
    await waitForExit(child, 2_000)
  }
}

function emptySnapshot(snapshot) {
  return snapshot.cookie === null
    && snapshot.localStorage === null
    && snapshot.indexedDB === null
    && snapshot.cacheStorage === null
    && snapshot.serviceWorker === false
    && snapshot.originFileSystem?.supported === true
    && snapshot.originFileSystem.value === null
}

function matchesToken(snapshot, token) {
  return snapshot.cookie === token
    && snapshot.localStorage === token
    && snapshot.indexedDB === token
    && snapshot.cacheStorage === token
    && snapshot.serviceWorker === true
    && snapshot.originFileSystem?.supported === true
    && snapshot.originFileSystem.value === token
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await access(options.browser)
  const server = await startAuditServer()
  const root = await mkdtemp(join(tmpdir(), 'prism-profile-data-audit-'))
  const profileA = join(root, 'profile-a')
  const profileB = join(root, 'profile-b')
  try {
    const aBefore = await collect(options, profileA, server.url, 'profile-a-value', false, 'profile-a initial-read')
    const aWritten = await collect(options, profileA, server.url, 'profile-a-value', true, 'profile-a write')
    const bBefore = await collect(options, profileB, server.url, 'profile-b-value', false, 'profile-b initial-read')
    const bWritten = await collect(options, profileB, server.url, 'profile-b-value', true, 'profile-b write')
    const aRestarted = await collect(options, profileA, server.url, 'profile-a-value', false, 'profile-a restart-read')
    const bRestarted = await collect(options, profileB, server.url, 'profile-b-value', false, 'profile-b restart-read')
    const checks = {
      profileAStartedEmpty: emptySnapshot(aBefore),
      profileBStartedEmptyAfterAWroteData: emptySnapshot(bBefore),
      profileAWriteReadable: matchesToken(aWritten, 'profile-a-value'),
      profileBWriteReadable: matchesToken(bWritten, 'profile-b-value'),
      profileAPersistsAfterRestart: matchesToken(aRestarted, 'profile-a-value'),
      profileBPersistsAfterRestart: matchesToken(bRestarted, 'profile-b-value'),
      crossProfileIsolation: matchesToken(aRestarted, 'profile-a-value')
        && matchesToken(bRestarted, 'profile-b-value')
        && JSON.stringify(aRestarted) !== JSON.stringify(bRestarted)
    }
    const report = {
      schemaVersion: 1,
      tool: {
        name: 'profile-data-audit',
        version: PROFILE_DATA_AUDIT_TOOL_VERSION,
        cdpLaunchContract: CDP_LAUNCH_CONTRACT
      },
      checkedAt: new Date().toISOString(),
      browser: options.browser,
      passed: Object.values(checks).every(Boolean),
      checks,
      snapshots: { aBefore, aWritten, bBefore, bWritten, aRestarted, bRestarted },
      retainedDataPath: options.keepData ? root : undefined
    }
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(report, null, 2))
    console.log(`Profile data audit: ${report.passed ? 'PASS' : 'FAIL'}`)
    for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
    console.log(`Report: ${options.output}`)
    if (!report.passed) process.exitCode = 1
  } finally {
    await server.close()
    if (!options.keepData) await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
