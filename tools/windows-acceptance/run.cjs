#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { verifyWindowsPackage } = require('../packaging/verify-windows-package.cjs')

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const ACCEPTANCE_TOOL_VERSION = 5
const PROFILE_LAUNCH_CONTRACT = 'fingerprint-websocket-fresh-port-v3'

function parseArguments(argv) {
  const options = {
    unpacked: '',
    output: resolve('windows-acceptance.json'),
    keepData: false,
    proVersion: ''
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--unpacked') options.unpacked = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--keep-data') options.keepData = true
    else if (argument === '--pro-version') options.proVersion = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.unpacked) {
    throw new Error('Usage: node tools/windows-acceptance/run.cjs --unpacked <release\\win-unpacked> [--output <report.json>]')
  }
  return options
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function safeDeliverableName(value) {
  return typeof value === 'string'
    && value === basename(value)
    && !value.includes('/')
    && !value.includes('\\')
    && /\.(?:exe|msi|zip)$/i.test(value)
}

async function verifyReleaseArtifacts(releaseRoot) {
  const checksumPath = join(releaseRoot, 'SHA256SUMS-windows-x64.txt')
  const lines = (await readFile(checksumPath, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) throw new Error('Windows 发布清单没有同时记录安装版和便携版')

  const deliverables = []
  const names = new Set()
  for (const line of lines) {
    const match = line.match(/^([a-f\d]{64})  (.+)$/i)
    if (!match || !safeDeliverableName(match[2]) || names.has(match[2])) {
      throw new Error(`Windows 发布清单行无效：${line}`)
    }
    names.add(match[2])
    const path = join(releaseRoot, match[2])
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) throw new Error(`Windows 发布文件无效：${match[2]}`)
    const actualSha256 = await hashFile(path)
    if (actualSha256 !== match[1].toLowerCase()) throw new Error(`Windows 发布文件 SHA-256 不匹配：${match[2]}`)
    deliverables.push({ name: match[2], size: info.size, sha256: actualSha256 })
  }

  const hasInstaller = deliverables.some((file) => /setup/i.test(file.name) && /\.(?:exe|msi)$/i.test(file.name))
  const hasPortable = deliverables.some((file) => file.name.toLowerCase().endsWith('.exe') && !/setup/i.test(file.name))
  const hasZipFallback = deliverables.some((file) => file.name.toLowerCase().endsWith('.zip'))
  if (!hasInstaller || !hasPortable || !hasZipFallback) {
    throw new Error('Windows 发布清单缺少安装版、便携版或 ZIP 免安装版')
  }
  return deliverables.sort((left, right) => left.name.localeCompare(right.name))
}

class WebSocketCdpConnection {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
  }

  async open() {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('Windows 自动验收需要 Node.js 22 或更新版本')
    }
    let lastError
    for (let attempt = 0; attempt < 20; attempt++) {
      const socket = new WebSocket(this.url)
      try {
        await new Promise((resolveOpen, reject) => {
          const timeout = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), 1_000)
          socket.addEventListener('open', () => {
            clearTimeout(timeout)
            resolveOpen()
          }, { once: true })
          socket.addEventListener('error', () => {
            clearTimeout(timeout)
            reject(new Error('CDP WebSocket connection failed'))
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
          // A socket that failed while still connecting may already be closed.
        }
        await delay(100)
      }
    }
    throw lastError ?? new Error('CDP WebSocket connection failed')
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out waiting for Chromium`))
      }, 30_000)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout)
          resolveCommand(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
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
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
    else pending.resolve(message.result)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

async function waitForWebSocketEndpoint(userDataDir, child, label) {
  const activePortPath = join(userDataDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before CDP startup (code=${child.exitCode ?? '-'}, signal=${child.signalCode ?? '-'})`)
    }
    try {
      const [port, browserPath] = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port) && browserPath?.startsWith('/')) return `ws://127.0.0.1:${port}${browserPath}`
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error(`${label} timed out waiting for DevToolsActivePort`)
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(milliseconds)
  ])
  return child.exitCode !== null || child.signalCode !== null
}

async function terminateChild(child) {
  if (await waitForExit(child, 2_000)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 2_000)) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    await waitForExit(killer, 5_000)
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, 3_000)
}

async function withCdpProcess(executable, userDataDir, extraArguments, label, operation, spawnEnvironment) {
  await mkdir(userDataDir, { recursive: true })
  // Chromium leaves this random-port rendezvous file in persistent profiles.
  // Reusing it on the next launch races the new browser and connects to a dead port.
  await rm(join(userDataDir, 'DevToolsActivePort'), { force: true })
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    ...extraArguments
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: spawnEnvironment ? { ...process.env, ...spawnEnvironment } : process.env
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
  let connection
  try {
    connection = new WebSocketCdpConnection(await waitForWebSocketEndpoint(userDataDir, child, label))
    await connection.open()
    return await operation(connection)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}${stderr ? `\n${label} stderr:\n${stderr}` : ''}`)
  } finally {
    if (connection) {
      await Promise.race([
        connection.send('Browser.close').catch(() => undefined),
        delay(1_000)
      ])
      connection.close()
    }
    await terminateChild(child)
  }
}

async function attachTarget(connection, targetId) {
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
  await connection.send('Runtime.enable', {}, sessionId)
  return sessionId
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed')
  }
  return result.result.value
}

async function waitForDocument(connection, sessionId, expectedUrl) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const page = await evaluate(connection, sessionId, `({
      readyState: document.readyState,
      href: location.href
    })`).catch(() => null)
    if (page?.readyState === 'complete' && (!expectedUrl || page.href === expectedUrl)) return
    await delay(100)
  }
  throw new Error(expectedUrl
    ? `Page did not finish navigating to the local isolation origin: ${expectedUrl}`
    : 'Page did not finish loading')
}

async function startIsolationServer() {
  const server = createServer((_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><title>Prism isolation test</title></head><body>Prism isolation test</body></html>')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start local isolation server')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  }
}

function fingerprintLaunchArguments(seed, chromiumVersion) {
  return [
    '--enable-logging=stderr',
    '--v=1',
    '--use-mock-keychain',
    `--fingerprint=${seed}`,
    '--fingerprint-platform=windows',
    '--fingerprint-platform-version=10.0.0',
    '--fingerprint-brand=Chrome',
    `--fingerprint-brand-version=${chromiumVersion}`,
    '--fingerprint-hardware-concurrency=8',
    '--fingerprint-screen-width=1440',
    '--fingerprint-screen-height=900',
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh,en-US,en',
    '--timezone=Asia/Shanghai',
    '--fingerprint-location=31.2304,121.4737,25000',
    '--window-size=1440,900',
    '--disable-non-proxied-udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp'
  ]
}

async function profileSession(browser, userDataDir, url, token, seed, chromiumVersion, write) {
  return withCdpProcess(browser, userDataDir, [
    '--headless=new',
    ...fingerprintLaunchArguments(seed, chromiumVersion),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    'about:blank'
  ], `Bundled Chromium ${basename(userDataDir)} ${write ? 'write' : 'read'}`, async (connection) => {
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
    const sessionId = await attachTarget(connection, targetId)
    await connection.send('Page.enable', {}, sessionId)
    const navigation = await connection.send('Page.navigate', { url }, sessionId)
    if (navigation.errorText) throw new Error(`Could not navigate to the local isolation origin: ${navigation.errorText}`)
    await waitForDocument(connection, sessionId, url)
    if (write) {
      await evaluate(connection, sessionId, `(() => {
        document.cookie = 'prism_acceptance=${token}; Max-Age=604800; SameSite=Lax; Path=/'
        localStorage.setItem('prism_acceptance', ${JSON.stringify(token)})
        return true
      })()`)
    }
    return evaluate(connection, sessionId, `(() => {
      const cookie = document.cookie.split('; ').find(value => value.startsWith('prism_acceptance='))
      return {
        cookie: cookie ? cookie.slice('prism_acceptance='.length) : null,
        localStorage: localStorage.getItem('prism_acceptance')
      }
    })()`)
  })
}

async function verifyProfileIsolation(browser, root, chromiumVersion) {
  const server = await startIsolationServer()
  const profileA = join(root, 'profile-a')
  const profileB = join(root, 'profile-b')
  const tokenA = `a-${randomUUID()}`
  const tokenB = `b-${randomUUID()}`
  try {
    const firstA = await profileSession(browser, profileA, server.url, tokenA, 810001, chromiumVersion, true)
    const firstB = await profileSession(browser, profileB, server.url, tokenB, 810002, chromiumVersion, true)
    const repeatA = await profileSession(browser, profileA, server.url, tokenA, 810001, chromiumVersion, false)
    const repeatB = await profileSession(browser, profileB, server.url, tokenB, 810002, chromiumVersion, false)
    const persistedA = firstA.cookie === tokenA && firstA.localStorage === tokenA
      && repeatA.cookie === tokenA && repeatA.localStorage === tokenA
    const persistedB = firstB.cookie === tokenB && firstB.localStorage === tokenB
      && repeatB.cookie === tokenB && repeatB.localStorage === tokenB
    const isolated = repeatA.cookie !== tokenB && repeatA.localStorage !== tokenB
      && repeatB.cookie !== tokenA && repeatB.localStorage !== tokenA
    if (!persistedA || !persistedB || !isolated) throw new Error('Independent profile storage persistence or isolation failed')
    return {
      profileDirectoriesDistinct: profileA !== profileB,
      cookiePersistence: true,
      localStoragePersistence: true,
      crossProfileIsolation: true,
      launches: 4
    }
  } finally {
    await server.close()
  }
}

async function verifyPrismUi(prismExecutable, userDataDir) {
  return withCdpProcess(prismExecutable, userDataDir, ['--disable-gpu'], 'Prism Browser', async (connection) => {
    let target
    for (let attempt = 0; attempt < 200; attempt++) {
      const { targetInfos } = await connection.send('Target.getTargets')
      target = targetInfos.find((candidate) => candidate.type === 'page' && candidate.url !== 'about:blank')
      if (target) break
      await delay(100)
    }
    if (!target) throw new Error('Prism Browser did not create its management window')
    const sessionId = await attachTarget(connection, target.targetId)
    await waitForDocument(connection, sessionId)
    const page = await evaluate(connection, sessionId, `({
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: (document.body?.innerText || '').trim().length,
      protocol: location.protocol
    })`)
    if (page.title !== 'Prism Browser' || page.readyState !== 'complete' || page.bodyTextLength < 20 || page.protocol !== 'file:') {
      throw new Error('Prism Browser management window did not render correctly')
    }
    return page
  }, {
    PRISM_E2E: '1',
    PRISM_E2E_USER_DATA: userDataDir
  })
}

async function runAcceptance(options) {
  if (process.platform !== 'win32') throw new Error('Windows automatic acceptance must run on Windows 10/11 x64')
  if (process.arch !== 'x64') throw new Error('Windows automatic acceptance requires a Node.js x64 runtime')

  const startedAt = new Date().toISOString()
  const dataRoot = await mkdtemp(join(tmpdir(), 'prism-windows-acceptance-'))
  const releaseRoot = dirname(options.unpacked)
  const prismExecutable = join(options.unpacked, 'Prism Browser.exe')
  const browser = join(options.unpacked, 'resources', 'kernels', 'current', 'chrome.exe')
  const errors = []
  const report = {
    schemaVersion: 1,
    tool: {
      name: 'windows-package-acceptance',
      version: ACCEPTANCE_TOOL_VERSION,
      profileLaunchContract: PROFILE_LAUNCH_CONTRACT
    },
    generatedAt: '',
    platform: { os: process.platform, arch: process.arch, node: process.version },
    input: { unpacked: basename(options.unpacked) },
    package: null,
    deliverables: null,
    appSmoke: null,
    profileIsolation: null,
    result: { passed: false, checks: {} },
    errors
  }

  const capture = async (name, operation) => {
    try {
      return await operation()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const message = raw
        .split(releaseRoot).join('<release>')
        .split(options.unpacked).join('<win-unpacked>')
        .split(dataRoot).join('<temporary-data>')
      errors.push({ stage: name, message })
      return null
    }
  }

  try {
    report.deliverables = await capture('deliverables', () => verifyReleaseArtifacts(releaseRoot))
    report.package = await capture('package', () => verifyWindowsPackage(options.unpacked, {
      requireProKernel: Boolean(options.proVersion),
      proVersion: options.proVersion
    }))
    if (report.package) {
      report.appSmoke = await capture('app-smoke', () => verifyPrismUi(prismExecutable, join(dataRoot, 'prism-app')))
      report.profileIsolation = await capture('profile-isolation', () => verifyProfileIsolation(
        browser,
        join(dataRoot, 'browser-profiles'),
        report.package.chromiumVersion
      ))
    }
    report.result.checks = {
      deliverableHashes: Boolean(report.deliverables?.length >= 2),
      bundledKernelIntegrity: Boolean(report.package?.criticalFiles >= 5),
      ...(options.proVersion ? {
        bundledProKernelIntegrity: Boolean(report.package?.proKernel?.chromiumVersion === options.proVersion
          && report.package?.proKernel?.criticalFiles >= 5)
      } : {}),
      prismManagementWindow: Boolean(report.appSmoke?.title === 'Prism Browser'),
      independentProfilePersistence: Boolean(report.profileIsolation?.cookiePersistence
        && report.profileIsolation?.localStoragePersistence),
      independentProfileIsolation: Boolean(report.profileIsolation?.crossProfileIsolation)
    }
    report.result.passed = errors.length === 0 && Object.values(report.result.checks).every(Boolean)
    report.generatedAt = new Date().toISOString()
    report.durationMs = Date.parse(report.generatedAt) - Date.parse(startedAt)
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  } finally {
    if (!options.keepData) await rm(dataRoot, { recursive: true, force: true })
  }
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
    const report = await runAcceptance(options)
    process.stdout.write(`Windows package acceptance: ${report.result.passed ? 'PASS' : 'FAIL'}\n`)
    for (const [name, passed] of Object.entries(report.result.checks)) {
      process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`)
    }
    process.stdout.write(`Report: ${options.output}\n`)
    if (!report.result.passed) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (options?.output) console.error(`Report may be incomplete: ${options.output}`)
    process.exitCode = 1
  }
}

if (require.main === module) void main()

module.exports = {
  parseArguments,
  safeDeliverableName,
  verifyReleaseArtifacts,
  runAcceptance
}
