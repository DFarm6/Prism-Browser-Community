#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const RETRYABLE_CLEANUP_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

function cleanupRetryDelay(attempt) {
  return Math.min(2_000, 100 * (2 ** attempt))
}

async function removeTemporaryTree(path, dependencies = {}) {
  const remove = dependencies.remove ?? rm
  const wait = dependencies.wait ?? delay
  const attempts = dependencies.attempts ?? 12
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await remove(path, { recursive: true, force: true })
      return
    } catch (error) {
      const retryable = RETRYABLE_CLEANUP_CODES.has(error?.code)
      if (!retryable || attempt === attempts - 1) throw error
      await wait(cleanupRetryDelay(attempt))
    }
  }
}

function currentPlatformVersion(platform) {
  if (platform === 'windows') return '10.0.0'
  const darwinMajor = Number(release().split('.')[0])
  if (!Number.isInteger(darwinMajor)) return '15.0.0'
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`
  return darwinMajor >= 20 ? `${darwinMajor - 9}.0.0` : '15.0.0'
}

function parseArguments(argv) {
  const result = {
    browser: '',
    output: resolve('fingerprint-audit.json'),
    keepData: false,
    platform: process.platform === 'win32' ? 'windows' : 'macos',
    allowNoSandbox: false,
    debugTransport: 'auto',
    surfaceMode: 'template',
    version: '144.0.7559.132',
    platformVersion: '',
    hardwareConcurrency: 8,
    screenWidth: 1440,
    screenHeight: 900,
    language: 'en-US',
    acceptLanguages: 'en-US,en',
    timezone: 'America/Los_Angeles',
    latitude: 34.0522,
    longitude: -118.2437,
    locationAccuracy: 25000,
    seedA: 100001,
    seedB: 200003,
    disableSpoofing: '',
    expectedGpu: '',
    renderIdentity: '',
    proxyServer: '',
    expectedPublicIp: ''
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--browser') result.browser = resolve(argv[++index] ?? '')
    else if (argument === '--output') result.output = resolve(argv[++index] ?? '')
    else if (argument === '--keep-data') result.keepData = true
    else if (argument === '--platform') result.platform = argv[++index] ?? ''
    else if (argument === '--surface-mode') result.surfaceMode = argv[++index] ?? ''
    else if (argument === '--version') result.version = argv[++index] ?? ''
    else if (argument === '--platform-version') result.platformVersion = argv[++index] ?? ''
    else if (argument === '--hardware-concurrency') result.hardwareConcurrency = Number(argv[++index])
    else if (argument === '--screen-width') result.screenWidth = Number(argv[++index])
    else if (argument === '--screen-height') result.screenHeight = Number(argv[++index])
    else if (argument === '--language') result.language = argv[++index] ?? ''
    else if (argument === '--accept-languages') result.acceptLanguages = argv[++index] ?? ''
    else if (argument === '--timezone') result.timezone = argv[++index] ?? ''
    else if (argument === '--latitude') result.latitude = Number(argv[++index])
    else if (argument === '--longitude') result.longitude = Number(argv[++index])
    else if (argument === '--location-accuracy') result.locationAccuracy = Number(argv[++index])
    else if (argument === '--seed-a') result.seedA = Number(argv[++index])
    else if (argument === '--seed-b') result.seedB = Number(argv[++index])
    else if (argument === '--disable-spoofing') result.disableSpoofing = argv[++index] ?? ''
    else if (argument === '--expected-gpu') result.expectedGpu = argv[++index] ?? ''
    else if (argument === '--render-identity') result.renderIdentity = argv[++index] ?? ''
    else if (argument === '--proxy-server') result.proxyServer = argv[++index] ?? ''
    else if (argument === '--expected-public-ip') result.expectedPublicIp = argv[++index] ?? ''
    else if (argument === '--allow-no-sandbox') result.allowNoSandbox = true
    else if (argument === '--debug-transport') result.debugTransport = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!result.browser) throw new Error('Usage: node tools/fingerprint-audit/run.mjs --browser /path/to/Chromium [--platform macos|windows] [--surface-mode native|template|fixed-template] [--version 144.0.7559.132] [--output report.json]')
  if (!['macos', 'windows'].includes(result.platform)) throw new Error('--platform must be macos or windows')
  if (!result.platformVersion) result.platformVersion = currentPlatformVersion(result.platform)
  if (!['native', 'template', 'fixed-template'].includes(result.surfaceMode)) throw new Error('--surface-mode must be native, template or fixed-template')
  if (!['auto', 'pipe', 'websocket'].includes(result.debugTransport)) throw new Error('--debug-transport must be auto, pipe or websocket')
  if (!/^\d+(?:\.\d+){3}$/.test(result.version)) throw new Error('--version must be an exact four-part Chromium version')
  if (!/^\d+(?:\.\d+){2,3}$/.test(result.platformVersion)) throw new Error('--platform-version must be a three- or four-part version')
  for (const [name, value] of [
    ['--hardware-concurrency', result.hardwareConcurrency],
    ['--screen-width', result.screenWidth],
    ['--screen-height', result.screenHeight]
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  }
  for (const [name, value] of [
    ['--latitude', result.latitude],
    ['--longitude', result.longitude],
    ['--location-accuracy', result.locationAccuracy]
  ]) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  }
  for (const [name, value] of [['--seed-a', result.seedA], ['--seed-b', result.seedB]]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${name} must be an unsigned 32-bit integer`)
  }
  if (!result.language || !result.acceptLanguages || !result.timezone) {
    throw new Error('--language, --accept-languages and --timezone must not be empty')
  }
  if (Boolean(result.proxyServer) !== Boolean(result.expectedPublicIp)) {
    throw new Error('--proxy-server and --expected-public-ip must be provided together')
  }
  if (result.proxyServer) {
    const proxyUrl = new URL(result.proxyServer)
    if (!['http:', 'https:', 'socks5:'].includes(proxyUrl.protocol)) {
      throw new Error('--proxy-server must use http, https or socks5')
    }
    if (isIP(result.expectedPublicIp) === 0) throw new Error('--expected-public-ip must be a valid IPv4 or IPv6 address')
  }
  if (result.surfaceMode === 'native' && !result.disableSpoofing) {
    result.disableSpoofing = 'font,audio,canvas,clientrects,gpu'
  } else if (
    result.surfaceMode === 'fixed-template'
    && !result.disableSpoofing
    && !['v3', 'v4'].includes(result.renderIdentity)
  ) {
    result.disableSpoofing = 'font,audio,canvas,clientrects'
  }
  return result
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function resolvedDebugTransport(options) {
  return options.debugTransport === 'websocket'
    || (options.debugTransport === 'auto' && process.platform === 'win32')
    ? 'websocket'
    : 'pipe'
}

const CONTEXT_COLLECTOR_SOURCE = String.raw`
async function prismHexDigest(scope, value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer())
  const digest = await scope.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function prismCollectContext(scope, kind) {
  const nav = scope.navigator
  const highEntropy = nav.userAgentData
    ? await nav.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'platformVersion', 'uaFullVersion'])
    : null
  const requestHeaders = await scope.fetch('/headers?context=' + encodeURIComponent(kind), { cache: 'no-store' })
    .then(response => response.json()).catch(() => null)
  let offscreenCanvas = { supported: false }
  try {
    if (typeof scope.OffscreenCanvas === 'function') {
      const canvas = new scope.OffscreenCanvas(96, 48)
      const context = canvas.getContext('2d')
      context.fillStyle = '#16324f'
      context.fillRect(0, 0, 96, 48)
      context.font = '17px Arial'
      context.fillStyle = '#f5f7ff'
      context.fillText('Prism 😀', 7.25, 29.5)
      const canvasSha256 = await prismHexDigest(scope, await canvas.convertToBlob({ type: 'image/png' }))
      const webglCanvas = new scope.OffscreenCanvas(32, 32)
      const gl = webglCanvas.getContext('webgl')
      let webgl = null
      if (gl) {
        gl.clearColor(0.123, 0.456, 0.789, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        const pixels = new Uint8Array(32 * 32 * 4)
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        const debug = gl.getExtension('WEBGL_debug_renderer_info')
        webgl = {
          vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          pixelsSha256: await prismHexDigest(scope, pixels)
        }
      }
      offscreenCanvas = { supported: true, canvasSha256, webgl }
    }
  } catch (error) {
    offscreenCanvas = { supported: false, error: error && error.name ? error.name : String(error) }
  }
  return {
    kind,
    userAgent: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    languages: Array.from(nav.languages || []),
    intlLocale: scope.Intl.DateTimeFormat().resolvedOptions().locale,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    timezone: scope.Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new scope.Date().getTimezoneOffset(),
    userAgentData: nav.userAgentData ? {
      brands: nav.userAgentData.brands,
      mobile: nav.userAgentData.mobile,
      platform: nav.userAgentData.platform
    } : null,
    userAgentDataHighEntropy: highEntropy,
    requestHeaders,
    screen: scope.screen ? {
      width: scope.screen.width,
      height: scope.screen.height,
      availWidth: scope.screen.availWidth,
      availHeight: scope.screen.availHeight,
      devicePixelRatio: scope.devicePixelRatio
    } : null,
    offscreenCanvas
  }
}
`

const DEDICATED_WORKER_SOURCE = `${CONTEXT_COLLECTOR_SOURCE}\nprismCollectContext(self, 'dedicatedWorker').then(postMessage)`
const SHARED_WORKER_SOURCE = `${CONTEXT_COLLECTOR_SOURCE}\nonconnect = event => { const port = event.ports[0]; prismCollectContext(self, 'sharedWorker').then(value => port.postMessage(value)) }`
const SERVICE_WORKER_SOURCE = `${CONTEXT_COLLECTOR_SOURCE}\nself.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('message', event => { event.waitUntil(prismCollectContext(self, 'serviceWorker').then(value => event.ports[0].postMessage(value))) })`
const AUDIO_WORKLET_SOURCE = String.raw`
class PrismAuditProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.port.postMessage({ supported: true, sampleRate, currentFrame, currentTime, hasNavigator: typeof navigator !== 'undefined' })
  }
  process() { return false }
}
registerProcessor('prism-audit-processor', PrismAuditProcessor)
`

async function startAuditServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness')
    if (request.url?.startsWith('/headers')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(request.headers))
      return
    }
    const scripts = new Map([
      ['/dedicated-worker.js', DEDICATED_WORKER_SOURCE],
      ['/shared-worker.js', SHARED_WORKER_SOURCE],
      ['/service-worker.js', SERVICE_WORKER_SOURCE],
      ['/audio-worklet.js', AUDIO_WORKLET_SOURCE]
    ])
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const script = scripts.get(pathname)
    if (script) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      response.setHeader('Service-Worker-Allowed', '/')
      response.end(script)
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><title>Prism audit</title></head><body></body></html>')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start local audit server')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  }
}

class CdpConnection {
  constructor(readable, writable) {
    this.readable = readable
    this.writable = writable
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.readable.on('data', (chunk) => this.onData(chunk))
    this.readable.on('error', (error) => this.rejectPending(error))
    this.readable.on('close', () => this.rejectPending(new Error('CDP pipe closed')))
  }

  async open() {
    // Chromium owns file descriptors 3 (commands) and 4 (responses). They are
    // available immediately; Chromium consumes queued commands after startup.
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out waiting for Chromium`))
      }, 45_000)
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
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
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
      throw new Error('Windows CDP audit requires Node.js 22 or newer with WebSocket support')
    }
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => this.onMessage(event.data))
    this.socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed')))
    await new Promise((resolveOpen, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), 15_000)
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolveOpen()
      }, { once: true })
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('CDP WebSocket connection failed'))
      }, { once: true })
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out waiting for Chromium`))
      }, 45_000)
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

async function waitForWebSocketEndpoint(userDataDir, child) {
  const activePortPath = join(userDataDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chromium exited before CDP startup (code=${child.exitCode ?? '-'}, signal=${child.signalCode ?? '-'})`)
    }
    try {
      const [port, browserPath] = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port) && browserPath?.startsWith('/')) return `ws://127.0.0.1:${port}${browserPath}`
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Chromium DevToolsActivePort')
}

const fingerprintExpression = String.raw`(async () => {
  ${CONTEXT_COLLECTOR_SOURCE}
  const mainContext = await prismCollectContext(self, 'window')
  const userAgentDataHighEntropy = mainContext.userAgentDataHighEntropy
  const requestHeaders = mainContext.requestHeaders
  const canvas = document.createElement('canvas')
  canvas.width = 420
  canvas.height = 120
  const context = canvas.getContext('2d')
  const gradient = context.createLinearGradient(0, 0, 420, 120)
  gradient.addColorStop(0, '#f60')
  gradient.addColorStop(0.5, '#069')
  gradient.addColorStop(1, '#6c3')
  context.fillStyle = gradient
  context.fillRect(0, 0, 420, 120)
  context.font = '20px Arial'
  context.fillStyle = 'rgba(255,255,255,0.87)'
  context.fillText('Prism fingerprint 144 😀', 12.25, 52.75)
  context.strokeStyle = '#102030'
  context.arc(310.5, 58.5, 34.25, 0, Math.PI * 1.7)
  context.stroke()
  const canvasFirst = canvas.toDataURL()
  const canvasSecond = canvas.toDataURL()

  // A masking detector can compare the same opaque canvas through independent
  // readback paths. The decoded pixels must agree across getImageData(),
  // toDataURL(), toBlob() and OffscreenCanvas; changing only one serialization
  // path is directly observable even when each individual hash is stable.
  const canvasReadbackElement = document.createElement('canvas')
  canvasReadbackElement.width = 128
  canvasReadbackElement.height = 64
  const canvasReadbackContext = canvasReadbackElement.getContext('2d', {
    willReadFrequently: true
  })
  canvasReadbackContext.fillStyle = '#18324f'
  canvasReadbackContext.fillRect(0, 0, 128, 64)
  const canvasReadbackGradient = canvasReadbackContext.createLinearGradient(0, 0, 128, 64)
  canvasReadbackGradient.addColorStop(0, '#f16a24')
  canvasReadbackGradient.addColorStop(1, '#49c279')
  canvasReadbackContext.fillStyle = canvasReadbackGradient
  canvasReadbackContext.fillRect(5, 5, 118, 54)
  canvasReadbackContext.font = '19px Arial, sans-serif'
  canvasReadbackContext.fillStyle = '#ffffff'
  canvasReadbackContext.fillText('Prism A/B 👾', 9.25, 39.5)
  const canvasReadbackDirectBytes = new Uint8Array(
    canvasReadbackContext.getImageData(0, 0, 128, 64).data.buffer
  )
  const canvasReadbackDataUrl = canvasReadbackElement.toDataURL('image/png')
  const canvasReadbackDataUrlBlob = await fetch(canvasReadbackDataUrl).then(response => response.blob())
  const canvasReadbackBlob = await new Promise((resolve, reject) => {
    canvasReadbackElement.toBlob(value => value ? resolve(value) : reject(new Error('CanvasToBlobFailed')), 'image/png')
  })
  const decodedCanvasPixels = async (blob, width = 128, height = 64) => {
    const bitmap = await createImageBitmap(blob)
    try {
      const decoded = document.createElement('canvas')
      decoded.width = width
      decoded.height = height
      const decodedContext = decoded.getContext('2d', { willReadFrequently: true })
      decodedContext.drawImage(bitmap, 0, 0)
      return new Uint8Array(decodedContext.getImageData(0, 0, width, height).data.buffer)
    } finally {
      bitmap.close()
    }
  }
  const decodedCanvasPixelDigest = async (blob, width = 128, height = 64) => (
    prismHexDigest(self, await decodedCanvasPixels(blob, width, height))
  )
  const canvasReadbackDirectSha256 = await prismHexDigest(self, canvasReadbackDirectBytes)
  const canvasReadbackDataUrlSha256 = await decodedCanvasPixelDigest(canvasReadbackDataUrlBlob)
  const canvasReadbackBlobSha256 = await decodedCanvasPixelDigest(canvasReadbackBlob)
  let canvasReadbackOffscreenSha256 = null
  if (typeof OffscreenCanvas === 'function') {
    const offscreen = new OffscreenCanvas(128, 64)
    offscreen.getContext('2d').drawImage(canvasReadbackElement, 0, 0)
    canvasReadbackOffscreenSha256 = await decodedCanvasPixelDigest(
      await offscreen.convertToBlob({ type: 'image/png' })
    )
  }
  const canvasReadbackHashes = {
    getImageData: canvasReadbackDirectSha256,
    toDataURL: canvasReadbackDataUrlSha256,
    toBlob: canvasReadbackBlobSha256,
    offscreen: canvasReadbackOffscreenSha256
  }
  const canvasReadbackComparableHashes = Object.values(canvasReadbackHashes).filter(Boolean)
  const canvasReadbackConsistency = {
    hashes: canvasReadbackHashes,
    allDecodedMatch: new Set(canvasReadbackComparableHashes).size === 1,
    dataUrlMatchesDirect: canvasReadbackDataUrlSha256 === canvasReadbackDirectSha256,
    blobMatchesDirect: canvasReadbackBlobSha256 === canvasReadbackDirectSha256,
    offscreenMatchesDirect: canvasReadbackOffscreenSha256 == null
      || canvasReadbackOffscreenSha256 === canvasReadbackDirectSha256
  }

  // Mirror the high-entropy paths used by CreepJS instead of relying on a
  // single text-heavy canvas. The previous audit could pass while CreepJS's
  // gradient/arc bundle collided because text offsets only carried a small
  // fraction of the profile seed.
  const drawCreepCanvas = (targetCanvas, targetContext, includeText) => {
    const area = { width: 75, height: 75 }
    const offset = 2001000001
    let state = 500 % offset
    const next = () => (state = (15000 * state) % offset)
    const pick = (maximum, floating = false) => {
      const value = (((next() - 1) / offset) * maximum) || 0
      return floating ? value : Math.floor(value)
    }
    const colors = [
      '#FF6633', '#FFB399', '#FF33FF', '#FFFF99', '#00B3E6',
      '#E6B333', '#3366E6', '#999966', '#99FF99', '#B34D4D',
      '#80B300', '#809900', '#E6B3B3', '#6680B3', '#66991A',
      '#FF99E6', '#CCFF1A', '#FF1A66', '#E6331A', '#33FFCC'
    ]
    targetCanvas.width = area.width
    targetCanvas.height = area.height
    targetContext.clearRect(0, 0, area.width, area.height)
    for (let round = 0; round < 10; round++) {
      const gradient = targetContext.createRadialGradient(
        pick(area.width), pick(area.height), pick(area.width),
        pick(area.width), pick(area.height), pick(area.width)
      )
      gradient.addColorStop(0, colors[pick(colors.length)])
      gradient.addColorStop(1, colors[pick(colors.length)])
      targetContext.fillStyle = gradient
      targetContext.shadowBlur = pick(50, true)
      targetContext.shadowColor = colors[pick(colors.length)]
      targetContext.beginPath()
      if (includeText && round === 9) {
        targetContext.font = '25px Arial, sans-serif'
        targetContext.strokeText('👾A', pick(area.width), pick(area.height), pick(area.width))
      } else if (round % 2 === 0) {
        targetContext.arc(
          pick(area.width), pick(area.height), pick(area.width),
          pick(2 * Math.PI, true), pick(2 * Math.PI, true)
        )
      } else {
        targetContext.moveTo(pick(area.width), pick(area.height))
        targetContext.quadraticCurveTo(
          pick(area.width), pick(area.height), pick(area.width), pick(area.height)
        )
      }
      targetContext.fill()
    }
    return targetCanvas.toDataURL()
  }
  const creepCanvasElement = document.createElement('canvas')
  const creepCanvasContext = creepCanvasElement.getContext('2d')
  const creepCanvasCpuElement = document.createElement('canvas')
  const creepCanvasCpuContext = creepCanvasCpuElement.getContext('2d', {
    desynchronized: true,
    willReadFrequently: true
  })
  const creepCanvasFirst = {
    combined: drawCreepCanvas(creepCanvasElement, creepCanvasContext, true),
    paintGpu: drawCreepCanvas(creepCanvasElement, creepCanvasContext, false),
    paintCpu: drawCreepCanvas(creepCanvasCpuElement, creepCanvasCpuContext, false)
  }
  creepCanvasElement.width = 50
  creepCanvasElement.height = 50
  creepCanvasContext.font = '50px Arial, sans-serif'
  creepCanvasContext.fillText('A', 7, 37)
  creepCanvasFirst.text = creepCanvasElement.toDataURL()
  creepCanvasElement.width = 50
  creepCanvasElement.height = 50
  creepCanvasContext.font = '35px Arial, sans-serif'
  creepCanvasContext.fillText('👾', 0, 37)
  creepCanvasFirst.emoji = creepCanvasElement.toDataURL()
  const creepCanvasRepeat = {
    combined: drawCreepCanvas(creepCanvasElement, creepCanvasContext, true),
    paintGpu: drawCreepCanvas(creepCanvasElement, creepCanvasContext, false),
    paintCpu: drawCreepCanvas(creepCanvasCpuElement, creepCanvasCpuContext, false)
  }

  // CreepJS classifies this 2x2 arc as a low-entropy rasterizer signature.
  // It must stay on a known native Blink pattern and must never inherit a
  // per-profile canvas identity.
  const creepCanvasLowEntropyProbe = (() => {
    const calibration = document.createElement('canvas')
    calibration.width = 2
    calibration.height = 2
    const calibrationContext = calibration.getContext('2d', { willReadFrequently: true })
    calibrationContext.fillStyle = '#000'
    calibrationContext.fillRect(0, 0, calibration.width, calibration.height)
    calibrationContext.fillStyle = '#fff'
    calibrationContext.fillRect(2, 2, 1, 1)
    calibrationContext.beginPath()
    calibrationContext.arc(0, 0, 2, 0, 1, true)
    calibrationContext.closePath()
    calibrationContext.fill()
    const rgba = Array.from(calibrationContext.getImageData(0, 0, 2, 2).data)
    const signature = rgba.join('')
    const knownBlinkSignatures = [
      '255255255255178178178255246246246255555555255',
      '255255255255192192192255240240240255484848255',
      '255255255255177177177255246246246255535353255',
      '255255255255128128128255191191191255646464255',
      '255255255255178178178255247247247255565656255',
      '255255255255174174174255242242242255474747255',
      '255255255255229229229255127127127255686868255',
      '255255255255192192192255244244244255535353255'
    ]
    return { passed: knownBlinkSignatures.includes(signature), signature, rgba }
  })()

  const emptyTextMetrics = context.measureText('')
  const textMetrics = {
    emptyIntegers: [
      emptyTextMetrics.actualBoundingBoxAscent,
      emptyTextMetrics.actualBoundingBoxDescent,
      emptyTextMetrics.actualBoundingBoxLeft,
      emptyTextMetrics.actualBoundingBoxRight,
      emptyTextMetrics.fontBoundingBoxAscent,
      emptyTextMetrics.fontBoundingBoxDescent
    ].every((value) => Number.isInteger(value || 0)),
    sampleWidth: context.measureText('Prism fingerprint 144').width
  }

  const drawWebGlProbe = (gl) => {
    gl.clear(gl.COLOR_BUFFER_BIT)
    const vertexPosBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexPosBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.9, -0.7, 0, 0.8, -0.7, 0, 0, 0.5, 0]),
      gl.STATIC_DRAW
    )
    const program = gl.createProgram()
    const vertexShader = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vertexShader, 'attribute vec2 attrVertex; varying vec2 varyinTexCoordinate; uniform vec2 uniformOffset; void main(){ varyinTexCoordinate = attrVertex + uniformOffset; gl_Position = vec4(attrVertex, 0, 1); }')
    gl.compileShader(vertexShader)
    gl.attachShader(program, vertexShader)
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fragmentShader, 'precision mediump float; varying vec2 varyinTexCoordinate; void main(){ gl_FragColor = vec4(varyinTexCoordinate, 1, 1); }')
    gl.compileShader(fragmentShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.useProgram(program)
    const vertexPosition = gl.getAttribLocation(program, 'attrVertex')
    gl.enableVertexAttribArray(vertexPosition)
    gl.vertexAttribPointer(vertexPosition, 3, gl.FLOAT, false, 0, 0)
    gl.uniform2f(gl.getUniformLocation(program, 'uniformOffset'), 1, 1)
    gl.drawArrays(gl.LINE_LOOP, 0, 3)
  }

  const collectWebGlProbe = (contextType) => {
    const probeCanvas = document.createElement('canvas')
    probeCanvas.width = 256
    probeCanvas.height = 256
    const context = probeCanvas.getContext(contextType)
    if (!context) return null
    drawWebGlProbe(context)
    const readWidth = Math.floor(context.drawingBufferWidth / 15)
    const readHeight = Math.floor(context.drawingBufferHeight / 6)
    const pixels = new Uint8Array(readWidth * readHeight * 4)
    context.readPixels(0, 0, readWidth, readHeight, context.RGBA, context.UNSIGNED_BYTE, pixels)
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    return {
      vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
      renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER),
      image: probeCanvas.toDataURL(),
      pixels: Array.from(pixels)
    }
  }

  const webgl1 = collectWebGlProbe('webgl')
  const webgl2 = collectWebGlProbe('webgl2')
  const webgl = webgl1 ? {
    vendor: webgl1.vendor,
    renderer: webgl1.renderer,
    images: [webgl1.image, webgl2?.image ?? null],
    pixels: [webgl1.pixels, webgl2?.pixels ?? null]
  } : null

  let webglReadbackConsistency = { supported: false }
  try {
    const readbackCanvas = document.createElement('canvas')
    readbackCanvas.width = 64
    readbackCanvas.height = 64
    const readbackGl = readbackCanvas.getContext('webgl', {
      preserveDrawingBuffer: true
    })
    if (readbackGl) {
      readbackGl.clearColor(0.125, 0.375, 0.625, 1)
      readbackGl.clear(readbackGl.COLOR_BUFFER_BIT)
      readbackGl.finish()
      const direct = new Uint8Array(64 * 64 * 4)
      readbackGl.readPixels(0, 0, 64, 64, readbackGl.RGBA, readbackGl.UNSIGNED_BYTE, direct)
      const directTopLeft = new Uint8Array(direct.length)
      const webglRowBytes = 64 * 4
      for (let row = 0; row < 64; row++) {
        directTopLeft.set(
          direct.subarray((63 - row) * webglRowBytes, (64 - row) * webglRowBytes),
          row * webglRowBytes
        )
      }
      const dataUrlBlob = await fetch(readbackCanvas.toDataURL('image/png')).then(response => response.blob())
      const directSha256 = await prismHexDigest(self, directTopLeft)
      const dataUrlPixels = await decodedCanvasPixels(dataUrlBlob, 64, 64)
      const dataUrlSha256 = await prismHexDigest(self, dataUrlPixels)
      webglReadbackConsistency = {
        supported: true,
        hashes: { readPixels: directSha256, toDataURL: dataUrlSha256 },
        firstPixels: {
          readPixels: Array.from(directTopLeft.slice(0, 16)),
          toDataURL: Array.from(dataUrlPixels.slice(0, 16))
        },
        match: directSha256 === dataUrlSha256
      }
    }
  } catch (error) {
    webglReadbackConsistency = {
      supported: false,
      error: error && error.name ? error.name : String(error)
    }
  }

  // Reproduce the public authenticity calibrations used by Pixelscan's
  // FingerprintMaskingComponent. These are deliberately low-entropy reference
  // surfaces: profile identity must not alter their exact native output.
  const pixelscanMaskingProbe = {
    expectedRedWebglSha256: 'bf9da7959d914298f9ce9e41a480fd66f76fac5c6f5e0a9b5a99b18cfc6fd997',
    canvas: { passed: false },
    webgl: { passed: false }
  }
  try {
    const colors = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
      [255, 0, 255], [0, 255, 255], [1, 1, 1], [254, 254, 254],
      [0, 0, 0], [51, 51, 51], [102, 102, 102], [153, 153, 153],
      [204, 204, 204], [255, 255, 255]
    ]
    const renderCanvasCalibration = async () => {
      const calibration = document.createElement('canvas')
      document.body.append(calibration)
      try {
        const nativeSource = calibration.toDataURL.toString()
        calibration.width = 5 * colors.length
        calibration.height = 5
        const calibrationContext = calibration.getContext('2d')
        colors.forEach((rgb, index) => {
          calibrationContext.fillStyle = '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('')
          calibrationContext.fillRect(5 * index, 0, 5 * (index + 1), 5)
        })
        const dataUrl = calibration.toDataURL()
        const image = new Image()
        await new Promise((resolve, reject) => {
          image.onload = resolve
          image.onerror = reject
          image.src = dataUrl
        })
        const decoded = document.createElement('canvas')
        decoded.width = calibration.width
        decoded.height = calibration.height
        const decodedContext = decoded.getContext('2d', { willReadFrequently: true })
        decodedContext.drawImage(image, 0, 0)
        const colorsExact = colors.every((rgb, index) => {
          const pixels = decodedContext.getImageData(5 * index, 0, 5, 5).data
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] !== rgb[0] || pixels[offset + 1] !== rgb[1]
              || pixels[offset + 2] !== rgb[2] || pixels[offset + 3] !== 255) return false
          }
          return true
        })
        return {
          dataUrl,
          colorsExact,
          nativeFunction: /native code/.test(nativeSource),
          functionSourceLength: nativeSource.length
        }
      } finally {
        calibration.remove()
      }
    }
    const firstCalibration = await renderCanvasCalibration()
    const secondCalibration = await renderCanvasCalibration()
    pixelscanMaskingProbe.canvas = {
      passed: firstCalibration.colorsExact
        && secondCalibration.colorsExact
        && firstCalibration.nativeFunction
        && secondCalibration.nativeFunction
        && firstCalibration.dataUrl === secondCalibration.dataUrl,
      colorsExact: firstCalibration.colorsExact && secondCalibration.colorsExact,
      repeatStable: firstCalibration.dataUrl === secondCalibration.dataUrl,
      nativeFunction: firstCalibration.nativeFunction && secondCalibration.nativeFunction,
      functionSourceLength: firstCalibration.functionSourceLength
    }
  } catch (error) {
    pixelscanMaskingProbe.canvas = {
      passed: false,
      error: error && error.name ? error.name : String(error)
    }
  }
  try {
    const calibration = document.createElement('canvas')
    calibration.width = 256
    calibration.height = 24
    const gl = calibration.getContext('webgl', { preserveDrawingBuffer: true })
    if (gl) {
      const indices = [3, 2, 1, 3, 1, 0]
      const vertexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -0.75, 0.75, 0, -0.75, -0.75, 0, 0.75, -0.75, 0, 0.75, 0.75, 0
      ]), gl.STATIC_DRAW)
      const indexBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW)
      const vertexShader = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(vertexShader, 'attribute vec3 coordinates;void main(void) { gl_Position = vec4(coordinates, 1.0);}')
      gl.compileShader(vertexShader)
      const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(fragmentShader, 'void main(void) { gl_FragColor = vec4(255, 0, 0, 1);}')
      gl.compileShader(fragmentShader)
      const program = gl.createProgram()
      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragmentShader)
      gl.linkProgram(program)
      gl.useProgram(program)
      const coordinates = gl.getAttribLocation(program, 'coordinates')
      gl.vertexAttribPointer(coordinates, 3, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(coordinates)
      gl.clearColor(0, 0, 0, 0)
      gl.enable(gl.DEPTH_TEST)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.viewport(0, 0, calibration.width, calibration.height)
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
      gl.finish()
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      const sha256 = await prismHexDigest(self, pixels)
      pixelscanMaskingProbe.webgl = {
        passed: sha256 === pixelscanMaskingProbe.expectedRedWebglSha256,
        sha256
      }
    }
  } catch (error) {
    pixelscanMaskingProbe.webgl = {
      passed: false,
      error: error && error.name ? error.name : String(error)
    }
  }

  const withTimeout = (promise, label) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ supported: false, error: label + 'Timeout' }), 8000))
  ])

  const webgpu = navigator.gpu
    ? await withTimeout((async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return { supported: true, adapterAvailable: false }
        const adapterInfo = adapter.info || (
          typeof adapter.requestAdapterInfo === 'function'
            ? await adapter.requestAdapterInfo()
            : null
        )
        const info = adapterInfo ? Object.fromEntries([
          'vendor',
          'architecture',
          'device',
          'description',
          'subgroupMinSize',
          'subgroupMaxSize'
        ].map(key => [key, adapterInfo[key] ?? null])) : null
        const limitNames = [
          'maxTextureDimension1D',
          'maxTextureDimension2D',
          'maxTextureDimension3D',
          'maxTextureArrayLayers',
          'maxBindGroups',
          'maxBindingsPerBindGroup',
          'maxBufferSize',
          'maxStorageBufferBindingSize',
          'maxComputeWorkgroupStorageSize',
          'maxComputeInvocationsPerWorkgroup'
        ]
        const limits = Object.fromEntries(limitNames.map(key => [key, Number(adapter.limits[key] ?? 0)]))
        return {
          supported: true,
          adapterAvailable: true,
          info,
          features: Array.from(adapter.features || []).sort(),
          limits
        }
      } catch (error) {
        return { supported: true, adapterAvailable: false, error: error && error.name ? error.name : String(error) }
      }
    })(), 'WebGPU')
    : { supported: false, adapterAvailable: false, error: 'Unsupported' }

  let audio = null
  let audioConsistency = null
  const AudioContext = self.OfflineAudioContext || self.webkitOfflineAudioContext
  if (AudioContext) {
    const audioContext = new AudioContext(1, 5000, 44100)
    const oscillator = audioContext.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.value = 10000
    const compressor = audioContext.createDynamicsCompressor()
    compressor.threshold.value = -50
    compressor.knee.value = 40
    compressor.ratio.value = 12
    compressor.attack.value = 0
    compressor.release.value = 0.25
    oscillator.connect(compressor)
    compressor.connect(audioContext.destination)
    oscillator.start(0)
    const rendered = await audioContext.startRendering()
    const samples = rendered.getChannelData(0)
    let sum = 0
    for (let index = 0; index < samples.length; index += 17) sum += Math.abs(samples[index])
    let creepSampleSum = 0
    for (let index = 4500; index < samples.length; index++) creepSampleSum += Math.abs(samples[index])
    // Mirror CreepJS' AudioBuffer trap. It first attacks fresh AudioBuffer
    // instances through getChannelData/copyFromChannel/copyToChannel, then
    // falls back to the unique-value sum of the rendered buffer's first 100
    // samples. A non-zero value is treated as injected audio noise.
    const creepAudioTrapValue = 0.3141592653589793
    const creepAudioNoiseFactor = (() => {
      try {
        const length = 2000
        const fromBuffer = new AudioBuffer({ length, sampleRate: 44100 })
        const fromCopy = new Float32Array(length)
        const start = 375
        const middle = start + 10
        const end = start + 20
        fromBuffer.getChannelData(0)[start] = creepAudioTrapValue
        fromBuffer.getChannelData(0)[middle] = creepAudioTrapValue
        fromBuffer.getChannelData(0)[end] = creepAudioTrapValue
        fromBuffer.copyFromChannel(fromCopy, 0)
        const fromValues = [
          ...fromBuffer.getChannelData(0),
          ...fromCopy,
          fromBuffer.getChannelData(0)[start] === 0 ? 0.2718281828459045 : 0,
          fromBuffer.getChannelData(0)[middle] === 0 ? 0.2718281828459045 : 0,
          fromBuffer.getChannelData(0)[end] === 0 ? 0.2718281828459045 : 0
        ].filter(value => value !== 0)

        const toBuffer = new AudioBuffer({ length, sampleRate: 44100 })
        const toCopy = new Float32Array(length)
        toBuffer.copyToChannel(toCopy.map(() => creepAudioTrapValue), 0)
        const frequency = toBuffer.getChannelData(0)[0]
        const toValues = Array.from(toBuffer.getChannelData(0))
          .map(value => value !== frequency || !value ? 0.2718281828459045 : value)
          .filter(value => value !== frequency)
        const result = Array.from(new Set([...fromValues, ...toValues]))
        return +(result.length !== 1 && result.reduce((total, value) => total + Number(value), 0))
      } catch {
        return Number.NaN
      }
    })()
    const creepRenderedNoise = Array.from(new Set(samples.slice(0, 100)))
      .reduce((total, value) => total + value, 0)
    const creepNoise = creepAudioNoiseFactor || creepRenderedNoise
    audio = Number(sum.toFixed(12))
    audioConsistency = {
      requestedSampleRate: 44100,
      contextSampleRate: audioContext.sampleRate,
      renderedSampleRate: rendered.sampleRate,
      creepSampleSum,
      creepAudioNoiseFactor,
      creepRenderedNoise,
      creepNoise,
      creepNoiseTrapPassed: creepNoise === 0,
      sequenceSha256: await prismHexDigest(
        self,
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
      )
    }
  }

  const rectElement = document.createElement('div')
  // This axis-aligned surface verifies that ordinary DOMRect identity still
  // varies by seed. Transformed geometry is covered separately by the fixed
  // CreepJS rotate(45deg) authenticity probe below.
  rectElement.style.cssText = 'display:inline-block;margin:9.19px 0 0 13.37px;width:123.45px;height:67.89px;font:17px Arial'
  rectElement.textContent = 'Prism ClientRects'
  document.body.appendChild(rectElement)
  const rect = rectElement.getBoundingClientRect()
  const range = document.createRange()
  range.selectNode(rectElement)
  const rangeRect = range.getBoundingClientRect()
  const rectMath = (value) => ({
    horizontal: value.right - value.left === value.width && value.right - value.x === value.width,
    vertical: value.bottom - value.top === value.height && value.bottom - value.y === value.height
  })

  // Mirror CreepJS' native DOMRect integrity checks. The 100x100 rotate(45deg)
  // surface is deliberately fixed: Blink at DPR 1 must retain the native
  // 9d9215cc mini hash even when ordinary rects carry a per-profile identity.
  const creepDomRectRoot = document.createElement('div')
  creepDomRectRoot.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none'
  creepDomRectRoot.innerHTML = [
    '<div data-prism-rect="known" style="position:absolute;top:0;left:0;width:100px;height:100px;transform:rotate(45deg)"></div>',
    '<div data-prism-rect="ghost" style="position:absolute;top:0;left:0;width:0;height:0"></div>',
    '<div data-prism-rect="equal-a" style="position:absolute;top:160px;left:160px;width:10px;height:10px;border:2px solid transparent"></div>',
    '<div data-prism-rect="equal-b" style="position:absolute;top:160px;left:160px;width:10px;height:10px;border:2px solid transparent"></div>'
  ].join('')
  document.body.appendChild(creepDomRectRoot)
  const rectNativeObject = (value) => ({
    bottom: value.bottom,
    height: value.height,
    left: value.left,
    right: value.right,
    width: value.width,
    top: value.top,
    x: value.x,
    y: value.y
  })
  const miniHash = (value) => {
    const json = JSON.stringify(value)
    const hash = json.split('').reduce((current, char, index) =>
      Math.imul(31, current) + json.charCodeAt(index) | 0, 0x811c9dc5)
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8)
  }
  const knownRect = rectNativeObject(creepDomRectRoot.querySelector('[data-prism-rect="known"]').getClientRects()[0])
  const ghostRect = rectNativeObject(creepDomRectRoot.querySelector('[data-prism-rect="ghost"]').getClientRects()[0])
  const equalRectA = rectNativeObject(creepDomRectRoot.querySelector('[data-prism-rect="equal-a"]').getClientRects()[0])
  const equalRectB = rectNativeObject(creepDomRectRoot.querySelector('[data-prism-rect="equal-b"]').getClientRects()[0])
  const creepDomRectProbe = {
    expectedKnownHash: devicePixelRatio === 1 ? '9d9215cc' : null,
    knownHash: miniHash(knownRect),
    knownRotationNative: devicePixelRatio !== 1 || miniHash(knownRect) === '9d9215cc',
    ghostZero: Object.values(ghostRect).every(value => value === 0),
    equalElements: equalRectA.right === equalRectB.right && equalRectA.left === equalRectB.left,
    strictMath: [knownRect, ghostRect, equalRectA, equalRectB].every(value =>
      value.right - value.left === value.width
      && value.bottom - value.top === value.height
      && value.right - value.x === value.width
      && value.bottom - value.y === value.height)
  }
  creepDomRectProbe.passed = creepDomRectProbe.knownRotationNative
    && creepDomRectProbe.ghostZero
    && creepDomRectProbe.equalElements
    && creepDomRectProbe.strictMath
  creepDomRectRoot.remove()

  const mediaStyle = document.createElement('style')
  mediaStyle.textContent = '@media (device-width: __PRISM_SCREEN_WIDTH__px) and (device-height: __PRISM_SCREEN_HEIGHT__px) { :root { --prism-device-size: match; } }'
  document.head.appendChild(mediaStyle)
  const screenMedia = {
    matchMedia: matchMedia('(device-width: __PRISM_SCREEN_WIDTH__px) and (device-height: __PRISM_SCREEN_HEIGHT__px)').matches,
    css: getComputedStyle(document.documentElement).getPropertyValue('--prism-device-size').trim() === 'match'
  }

  const fontCandidates = [
    'Arial',
    'Calibri',
    'Cambria',
    'Candara',
    'Consolas',
    'Segoe UI',
    'Times New Roman',
    'Microsoft YaHei',
    'Microsoft JhengHei',
    'Yu Gothic',
    'Meiryo',
    'Malgun Gothic',
    'Nirmala UI'
  ]
  const fontProbeCanvas = document.createElement('canvas')
  const fontProbeContext = fontProbeCanvas.getContext('2d')
  const fontProbeText = 'mmmmmmmmmmlliWW@#0123456789'
  const genericFamilies = ['monospace', 'sans-serif', 'serif']
  const fontBaselines = Object.fromEntries(genericFamilies.map((generic) => {
    fontProbeContext.font = '72px ' + generic
    return [generic, fontProbeContext.measureText(fontProbeText).width]
  }))
  const fontProbeWidths = {}
  const fontFamilies = fontCandidates.filter((family) => {
    const widths = genericFamilies.map((generic) => {
      fontProbeContext.font = '72px "' + family + '",' + generic
      return Number(fontProbeContext.measureText(fontProbeText).width.toFixed(6))
    })
    fontProbeWidths[family] = widths
    return widths.some((width, index) => Math.abs(width - fontBaselines[genericFamilies[index]]) > 0.01)
  })

  const speechVoices = typeof speechSynthesis === 'object'
    ? await withTimeout((async () => {
      const immediateVoices = speechSynthesis.getVoices()
      let voices = immediateVoices
      const deadline = performance.now() + 7000
      while (!voices.length && performance.now() < deadline) {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            speechSynthesis.removeEventListener('voiceschanged', changed)
            resolve()
          }, 250)
          const changed = () => {
            clearTimeout(timeout)
            speechSynthesis.removeEventListener('voiceschanged', changed)
            resolve()
          }
          speechSynthesis.addEventListener('voiceschanged', changed, { once: true })
        })
        voices = speechSynthesis.getVoices()
      }
      return {
        supported: true,
        immediateVoiceCount: immediateVoices.length,
        voices: voices.map(voice => ({
          name: voice.name,
          lang: voice.lang,
          localService: voice.localService,
          default: voice.default,
          voiceURI: voice.voiceURI
        })).sort((left, right) => (
          left.lang.localeCompare(right.lang)
          || left.name.localeCompare(right.name)
          || left.voiceURI.localeCompare(right.voiceURI)
        ))
      }
    })(), 'SpeechVoices')
    : { supported: false, error: 'Unsupported' }

  const iframe = await withTimeout(new Promise((resolve) => {
    const element = document.createElement('iframe')
    element.hidden = true
    element.onload = async () => {
      try { resolve(await prismCollectContext(element.contentWindow, 'iframe')) }
      catch (error) { resolve({ supported: false, error: error && error.name ? error.name : String(error) }) }
      finally { element.remove() }
    }
    element.onerror = () => { element.remove(); resolve({ supported: false, error: 'IframeLoadError' }) }
    element.src = '/iframe.html'
    document.body.appendChild(element)
  }), 'Iframe')

  const dedicatedWorker = await withTimeout(new Promise((resolve) => {
    const instance = new Worker('/dedicated-worker.js')
    instance.onmessage = ({ data }) => { instance.terminate(); resolve(data) }
    instance.onerror = () => { instance.terminate(); resolve({ supported: false, error: 'DedicatedWorkerError' }) }
  }), 'DedicatedWorker')

  const sharedWorker = typeof SharedWorker === 'function'
    ? await withTimeout(new Promise((resolve) => {
      const instance = new SharedWorker('/shared-worker.js', { name: 'prism-audit' })
      instance.port.onmessage = ({ data }) => { instance.port.close(); resolve(data) }
      instance.onerror = () => { instance.port.close(); resolve({ supported: false, error: 'SharedWorkerError' }) }
      instance.port.start()
    }), 'SharedWorker')
    : { supported: false, error: 'Unsupported' }

  const serviceWorker = 'serviceWorker' in navigator
    ? await withTimeout((async () => {
      try {
        const registration = await navigator.serviceWorker.register('/service-worker.js?audit=1', { scope: '/' })
        await navigator.serviceWorker.ready
        const target = registration.active || registration.waiting || registration.installing
        if (!target) return { supported: false, error: 'NoActiveServiceWorker' }
        const value = await new Promise((resolve) => {
          const channel = new MessageChannel()
          channel.port1.onmessage = ({ data }) => resolve(data)
          target.postMessage('collect', [channel.port2])
        })
        await registration.unregister()
        return value
      } catch (error) {
        return { supported: false, error: error && error.name ? error.name : String(error) }
      }
    })(), 'ServiceWorker')
    : { supported: false, error: 'Unsupported' }

  const audioWorklet = await withTimeout((async () => {
    const RealtimeAudioContext = self.AudioContext || self.webkitAudioContext
    if (!RealtimeAudioContext) return { supported: false, error: 'Unsupported' }
    const workletContext = new RealtimeAudioContext({ sampleRate: 44100 })
    try {
      await workletContext.audioWorklet.addModule('/audio-worklet.js')
      const value = await new Promise((resolve) => {
        const node = new AudioWorkletNode(workletContext, 'prism-audit-processor')
        node.port.onmessage = ({ data }) => { node.disconnect(); resolve(data) }
        node.connect(workletContext.destination)
      })
      return value
    } catch (error) {
      return { supported: false, error: error && error.name ? error.name : String(error) }
    } finally {
      await workletContext.close()
    }
  })(), 'AudioWorklet')

  const collectGeolocation = () => withTimeout(new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      }),
      (error) => resolve({ supported: false, error: error.code }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    )
  }), 'Geolocation')
  const geolocationFirst = await collectGeolocation()
  const geolocationRepeat = await collectGeolocation()
  const geolocation = {
    ...geolocationFirst,
    repeatStable: JSON.stringify(geolocationFirst) === JSON.stringify(geolocationRepeat)
  }

  const publicIpAuditUrl = __PRISM_PUBLIC_IP_AUDIT_URL__
  const publicIp = publicIpAuditUrl
    ? await withTimeout(fetch(publicIpAuditUrl, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)))
      .then(value => ({ supported: true, ip: value.ip }))
      .catch(error => ({ supported: false, error: error && error.name ? error.name : String(error) })), 'PublicIp')
    : null

  const webrtc = typeof RTCPeerConnection === 'function'
    ? await withTimeout(new Promise(async (resolve) => {
      const peer = new RTCPeerConnection()
      const candidates = []
      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          peer.close()
          const parsed = candidates.map((value) => {
            const parts = value.split(/\s+/)
            const typeIndex = parts.indexOf('typ')
            return { address: parts[4] || '', type: typeIndex >= 0 ? parts[typeIndex + 1] : '' }
          })
          resolve({
            supported: true,
            candidateTypes: [...new Set(parsed.map((value) => value.type).filter(Boolean))].sort(),
            directIpCandidates: parsed.filter((value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.address) || value.address.includes(':')).length
          })
        } else {
          candidates.push(candidate.candidate)
        }
      }
      try {
        peer.createDataChannel('audit')
        await peer.setLocalDescription(await peer.createOffer())
        setTimeout(() => {
          peer.close()
          resolve({ supported: true, candidateTypes: [], directIpCandidates: 0, gatheringTimedOut: true })
        }, 3000)
      } catch (error) {
        peer.close()
        resolve({ supported: false, error: error && error.name ? error.name : String(error) })
      }
    }), 'WebRTC')
    : { supported: false, error: 'Unsupported' }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    userAgentData: navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform
    } : null,
    userAgentDataHighEntropy,
    requestHeaders,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    language: navigator.language,
    languages: navigator.languages,
    intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    contexts: {
      window: mainContext,
      iframe,
      dedicatedWorker,
      sharedWorker,
      serviceWorker,
      audioWorklet
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availTop: screen.availTop,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth
    },
    screenMedia,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    webdriver: navigator.webdriver,
    plugins: Array.from(navigator.plugins, plugin => plugin.name),
    fontFamilies,
    fontProbeWidths,
    speechVoices,
    canvas: canvasFirst,
    canvasRepeatStable: canvasFirst === canvasSecond,
    canvasReadbackConsistency,
    creepCanvas: creepCanvasFirst,
    creepCanvasRepeatStable: creepCanvasFirst.combined === creepCanvasRepeat.combined
      && creepCanvasFirst.paintGpu === creepCanvasRepeat.paintGpu
      && creepCanvasFirst.paintCpu === creepCanvasRepeat.paintCpu,
    creepCanvasLowEntropyProbe,
    textMetrics,
    webgl,
    webglReadbackConsistency,
    pixelscanMaskingProbe,
    webgpu,
    audio,
    audioConsistency,
    geolocation,
    publicIp,
    webrtc,
    rect: {
      x: Number(rect.x.toFixed(8)),
      y: Number(rect.y.toFixed(8)),
      width: Number(rect.width.toFixed(8)),
      height: Number(rect.height.toFixed(8))
    },
    rectConsistency: {
      element: rectMath(rect),
      range: rectMath(rangeRect)
    },
    creepDomRectProbe
  }
})()`

function buildFingerprintExpression(options) {
  return fingerprintExpression
    .replaceAll('__PRISM_SCREEN_WIDTH__', String(options.screenWidth))
    .replaceAll('__PRISM_SCREEN_HEIGHT__', String(options.screenHeight))
    .replaceAll('__PRISM_PUBLIC_IP_AUDIT_URL__', options.expectedPublicIp ? JSON.stringify('https://api.ipify.org?format=json') : 'null')
}

async function collectSample(options, root, name, seed) {
  const userDataDir = join(root, name)
  await mkdir(userDataDir, { recursive: true })
  const useWebSocketTransport = resolvedDebugTransport(options) === 'websocket'
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--use-mock-keychain',
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${options.platform}`,
    `--fingerprint-platform-version=${options.platformVersion}`,
    `--fingerprint-language=${options.language}`,
    '--fingerprint-brand=Chrome',
    `--fingerprint-brand-version=${options.version}`,
    `--fingerprint-hardware-concurrency=${options.hardwareConcurrency}`,
    `--fingerprint-screen-width=${options.screenWidth}`,
    `--fingerprint-screen-height=${options.screenHeight}`,
    `--lang=${options.language}`,
    `--accept-lang=${options.acceptLanguages}`,
    `--timezone=${options.timezone}`,
    `--fingerprint-location=${options.latitude},${options.longitude},${options.locationAccuracy}`,
    `--window-size=${options.screenWidth},${options.screenHeight}`,
    '--disable-non-proxied-udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-logging=stderr',
    '--disable-background-networking',
    '--disable-component-update',
    'about:blank'
  ]
  if (options.proxyServer) {
    args.splice(args.length - 1, 0,
      '--disable-quic',
      '--dns-prefetch-disable',
      '--no-pings',
      `--proxy-server=${options.proxyServer}`,
      '--proxy-bypass-list=localhost;127.0.0.1')
  }
  if (useWebSocketTransport) {
    args.splice(2, 0, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*')
  } else {
    args.splice(2, 0, '--remote-debugging-pipe')
  }
  if (options.disableSpoofing) {
    args.splice(args.length - 1, 0, `--disable-spoofing=${options.disableSpoofing}`)
  }
  if (options.renderIdentity) {
    args.splice(args.length - 1, 0, `--fingerprint-render-identity=${options.renderIdentity}`)
  }
  // An unsigned local macOS build has no team identity for child-process
  // rendezvous. --allow-no-sandbox is only for fingerprint development; a
  // release acceptance run must omit it and use a signed/notarized bundle.
  if (options.allowNoSandbox) args.splice(3, 0, '--no-sandbox')
  const child = spawn(options.browser, args, {
    stdio: useWebSocketTransport ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
  let connection
  try {
    connection = useWebSocketTransport
      ? new WebSocketCdpConnection(await waitForWebSocketEndpoint(userDataDir, child))
      : new CdpConnection(child.stdio[4], child.stdio[3])
    await connection.open()
    const { targetId } = await connection.send('Target.createTarget', { url: options.auditUrl })
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    await connection.send('Runtime.enable', {}, sessionId)
    await connection.send('Browser.setPermission', {
      permission: { name: 'geolocation' },
      setting: 'granted',
      origin: options.auditUrl
    })
    await delay(500)
    const result = await connection.send('Runtime.evaluate', {
      expression: buildFingerprintExpression(options),
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Fingerprint expression failed')
    const raw = result.result.value
    return {
      name,
      seed,
      userAgent: raw.userAgent,
      platform: raw.platform,
      userAgentData: raw.userAgentData,
      userAgentDataHighEntropy: raw.userAgentDataHighEntropy,
      requestHeaders: raw.requestHeaders,
      hardwareConcurrency: raw.hardwareConcurrency,
      deviceMemory: raw.deviceMemory,
      language: raw.language,
      languages: raw.languages,
      intlLocale: raw.intlLocale,
      timezone: raw.timezone,
      timezoneOffset: raw.timezoneOffset,
      contexts: raw.contexts,
      screen: raw.screen,
      screenMedia: raw.screenMedia,
      viewport: raw.viewport,
      webdriver: raw.webdriver,
      plugins: raw.plugins,
      fontFamilies: raw.fontFamilies,
      fontProbeWidths: raw.fontProbeWidths,
      fontSetSha256: sha256(JSON.stringify({
        families: raw.fontFamilies,
        widths: raw.fontProbeWidths
      })),
      speechVoices: raw.speechVoices,
      speechVoicesSha256: raw.speechVoices?.supported
        ? sha256(JSON.stringify(raw.speechVoices.voices))
        : null,
      canvasSha256: sha256(raw.canvas),
      canvasRepeatStable: raw.canvasRepeatStable,
      canvasReadbackConsistency: raw.canvasReadbackConsistency,
      creepCanvasSha256: sha256(JSON.stringify(raw.creepCanvas)),
      creepCanvasRepeatStable: raw.creepCanvasRepeatStable,
      creepCanvasLowEntropyProbe: raw.creepCanvasLowEntropyProbe,
      textMetrics: raw.textMetrics,
      webglVendor: raw.webgl?.vendor ?? null,
      webglRenderer: raw.webgl?.renderer ?? null,
      webglImageSha256: raw.webgl ? sha256(JSON.stringify(raw.webgl.images)) : null,
      webglPixelsSha256: raw.webgl ? sha256(JSON.stringify(raw.webgl.pixels)) : null,
      webglReadbackConsistency: raw.webglReadbackConsistency,
      pixelscanMaskingProbe: raw.pixelscanMaskingProbe,
      webgpu: raw.webgpu,
      webgpuSha256: raw.webgpu?.adapterAvailable
        ? sha256(JSON.stringify({ info: raw.webgpu.info, features: raw.webgpu.features, limits: raw.webgpu.limits }))
        : null,
      audio: raw.audio,
      audioSha256: raw.audioConsistency?.sequenceSha256 ?? (
        raw.audio === null ? null : sha256(String(raw.audio))
      ),
      audioConsistency: raw.audioConsistency,
      geolocation: raw.geolocation,
      publicIp: raw.publicIp,
      webrtc: raw.webrtc,
      rect: raw.rect,
      rectConsistency: raw.rectConsistency,
      creepDomRectProbe: raw.creepDomRectProbe,
      stderr
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}${stderr ? `\nChromium stderr:\n${stderr}` : ''}`)
  } finally {
    if (connection) {
      await Promise.race([
        connection.send('Browser.close').catch(() => undefined),
        delay(1_000)
      ])
      connection.close()
    }
    const exited = () => child.exitCode !== null || child.signalCode !== null
    const waitForExit = async (milliseconds) => {
      if (exited()) return true
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        delay(milliseconds)
      ])
      return exited()
    }
    if (!await waitForExit(5_000)) child.kill('SIGTERM')
    if (!await waitForExit(2_000)) child.kill('SIGKILL')
    await waitForExit(2_000)
  }
}

function comparable(sample) {
  const { name, stderr, ...rest } = sample
  return rest
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function expectedWebGpuIdentity(webglRenderer) {
  const renderer = String(webglRenderer || '').toLowerCase()
  if (renderer.includes('nvidia')) {
    if (renderer.includes('geforce rtx 30')) return { vendor: 'nvidia', architecture: 'ampere' }
    if (renderer.includes('geforce rtx 40')) return { vendor: 'nvidia', architecture: 'ada' }
    if (renderer.includes('geforce rtx 50')) return { vendor: 'nvidia', architecture: 'blackwell' }
    return { vendor: 'nvidia' }
  }
  if (renderer.includes('apple')) return { vendor: 'apple' }
  return null
}

function webGpuCoherenceCheck(sample) {
  const info = sample.webgpu?.info
  const expected = expectedWebGpuIdentity(sample.webglRenderer)
  const available = sample.webgpu?.adapterAvailable === true
  const actual = available && info
    ? {
        vendor: String(info.vendor || '').toLowerCase(),
        architecture: String(info.architecture || '').toLowerCase()
      }
    : null
  const matched = !expected || Boolean(actual
    && actual.vendor === expected.vendor
    && (!expected.architecture || actual.architecture === expected.architecture))
  return {
    sample: sample.name,
    available,
    expected,
    actual,
    matched
  }
}

function renderBundleReadiness(
  first,
  different,
  expectedLanguage,
  renderIdentity = 'v1',
  surfaceMode = 'template'
) {
  const observableSurfaceFields = [
    'fontSetSha256',
    'canvasSha256',
    'creepCanvasSha256',
    'webglImageSha256',
    'webglPixelsSha256',
    'audioSha256',
    'rect',
    'speechVoicesSha256'
  ]
  const crossSeedCollisionFields = observableSurfaceFields.filter((field) => (
    first[field] !== null
    && first[field] !== undefined
    && different[field] !== null
    && different[field] !== undefined
    && sameValue(first[field], different[field])
  ))
  const expectedLanguageBase = String(expectedLanguage || '').toLowerCase().split(/[-_]/)[0]
  const speechLocaleChecks = [first, different].map((sample) => {
    const voices = sample.speechVoices?.supported === true ? sample.speechVoices.voices : []
    const languages = [...new Set(voices.map((voice) => voice.lang).filter(Boolean))].sort()
    const defaultVoiceCount = voices.filter((voice) => voice.default).length
    const localVoiceCount = voices.filter((voice) => voice.localService).length
    const metadataComplete = voices.every((voice) => (
      Boolean(voice.name) && Boolean(voice.lang) && Boolean(voice.voiceURI)
    ))
    return {
      sample: sample.name,
      supported: sample.speechVoices?.supported === true,
      immediateVoiceCount: sample.speechVoices?.immediateVoiceCount ?? 0,
      voiceCount: voices.length,
      localVoiceCount,
      defaultVoiceCount,
      metadataComplete,
      languages,
      matched: voices.length > 0 && languages.every((language) => (
        language.toLowerCase().split(/[-_]/)[0] === expectedLanguageBase
      )),
      ready: (sample.speechVoices?.immediateVoiceCount ?? 0) >= 3
        && voices.length >= 3
        && localVoiceCount >= 1
        && defaultVoiceCount === 1
        && metadataComplete
    }
  })
  const canvasReadbackChecks = [first, different].map((sample) => ({
    sample: sample.name,
    coherent: sample.canvasReadbackConsistency?.allDecodedMatch === true,
    paths: sample.canvasReadbackConsistency?.hashes ?? null
  }))
  const canvasReadbackCoherent = canvasReadbackChecks.every((check) => check.coherent)
  const webglReadbackChecks = [first, different].map((sample) => ({
    sample: sample.name,
    supported: sample.webglReadbackConsistency?.supported === true,
    coherent: sample.webglReadbackConsistency?.match === true,
    paths: sample.webglReadbackConsistency?.hashes ?? null
  }))
  const webglReadbackCoherent = webglReadbackChecks.every((check) => (
    !check.supported || check.coherent
  ))
  const rendererVaries = !sameValue(first.webglRenderer, different.webglRenderer)
  const imageVaries = !sameValue(first.webglImageSha256, different.webglImageSha256)
  const pixelsVary = !sameValue(first.webglPixelsSha256, different.webglPixelsSha256)
  const audioVaries = !sameValue(first.audioSha256, different.audioSha256)
  const firstCreepSampleSum = first.audioConsistency?.creepSampleSum
  const differentCreepSampleSum = different.audioConsistency?.creepSampleSum
  const audioNativeCalibrationStable = firstCreepSampleSum == null
    && differentCreepSampleSum == null
    ? true
    : firstCreepSampleSum != null
      && differentCreepSampleSum != null
      && firstCreepSampleSum === differentCreepSampleSum
  const canvasVaries = !sameValue(first.canvasSha256, different.canvasSha256)
  const creepCanvasVaries = !sameValue(first.creepCanvasSha256, different.creepCanvasSha256)
  const rectVaries = !sameValue(first.rect, different.rect)
  const fontSetVaries = !sameValue(first.fontSetSha256, different.fontSetSha256)
  const speechLocaleCoherent = speechLocaleChecks.every((check) => check.matched)
  const speechVoicesAvailable = speechLocaleChecks.every((check) => (
    check.supported && check.voiceCount > 0
  ))
  const conservativeNative = renderIdentity === 'v2'
  const coherentSeeded = renderIdentity === 'v3' || renderIdentity === 'v4'
  const nativeLocaleSurfaces = renderIdentity === 'v4'
  const fixedHardwareTemplate = coherentSeeded && surfaceMode === 'fixed-template'
  const speechPolicy = nativeLocaleSurfaces
    ? 'immediate-profile-locale-catalog'
    : 'match-profile-locale'
  const speechPolicyPassed = speechLocaleCoherent && (
    !nativeLocaleSurfaces || speechLocaleChecks.every((check) => check.ready)
  )
  const webgpuAvailable = [first, different].every((sample) => sample.webgpu?.adapterAvailable === true)
  const webgpuVaries = webgpuAvailable && !sameValue(first.webgpuSha256, different.webgpuSha256)
  const webgpuCoherenceChecks = [first, different].map(webGpuCoherenceCheck)
  const webgpuCoherent = webgpuCoherenceChecks.every((check) => check.matched)
  const webgpuPolicyPassed = !nativeLocaleSurfaces || (
    webgpuAvailable
    && webgpuCoherent
    && (!fixedHardwareTemplate || !webgpuVaries)
  )
  const webgpuPolicy = !webgpuAvailable
    ? 'unavailable'
    : !webgpuCoherent
      ? 'incoherent-gpu-template'
      : fixedHardwareTemplate
        ? 'stable-fixed-template'
        : nativeLocaleSurfaces
          ? 'coherent-gpu-template'
          : webgpuVaries
            ? 'vary-by-seed'
            : 'shared-native-adapter'
  const rendererMatchesPolicy = fixedHardwareTemplate ? !rendererVaries : rendererVaries
  const highEntropyVariation = {
    webglRenderer: rendererVaries,
    webglImageSha256: imageVaries,
    webglPixelsSha256: pixelsVary,
    audioSha256: audioVaries,
    canvasSha256: canvasVaries,
    creepCanvasSha256: creepCanvasVaries,
    rect: rectVaries,
    fontSetSha256: fontSetVaries
  }
  const highEntropyDifferenceCount = Object.values(highEntropyVariation).filter(Boolean).length
  const minimumHighEntropyDifferences = coherentSeeded
    ? fixedHardwareTemplate ? 5 : 6
    : 3
  const postProcessingRiskFields = [
    pixelsVary ? 'webglPixelsSha256' : null,
    audioVaries ? 'audioSha256' : null
  ].filter(Boolean)
  const unexpectedCollisionFields = conservativeNative
    ? []
    : coherentSeeded
      ? crossSeedCollisionFields.filter((field) => (
        field === 'canvasSha256'
        || field === 'creepCanvasSha256'
        || field === 'webglImageSha256'
        || field === 'webglPixelsSha256'
        || field === 'audioSha256'
        || field === 'rect'
      ))
      : crossSeedCollisionFields.filter((field) => (
        field === 'webglImageSha256'
        || field === 'webglPixelsSha256'
        || field === 'audioSha256'
      ))
  return {
    passed: conservativeNative
      ? rendererVaries && postProcessingRiskFields.length === 0 && speechPolicyPassed
      : coherentSeeded
        ? rendererMatchesPolicy
          && pixelsVary
          && imageVaries
          && audioVaries
          && audioNativeCalibrationStable
          && canvasVaries
          && creepCanvasVaries
          && rectVaries
          && highEntropyDifferenceCount >= minimumHighEntropyDifferences
          && unexpectedCollisionFields.length === 0
          && canvasReadbackCoherent
          && webglReadbackCoherent
          && speechPolicyPassed
          && (!nativeLocaleSurfaces || webgpuPolicyPassed)
        : rendererVaries
          && imageVaries
          && pixelsVary
          && audioVaries
          && unexpectedCollisionFields.length === 0
          && speechPolicyPassed,
    mode: conservativeNative
      ? 'conservative-native-v2'
      : coherentSeeded
        ? fixedHardwareTemplate
          ? nativeLocaleSurfaces ? 'coherent-fixed-native-locale-v4' : 'coherent-fixed-template-v3'
          : nativeLocaleSurfaces ? 'coherent-native-locale-v4' : 'coherent-seeded-v3'
        : 'legacy-differentiated-v1',
    rendererVaries,
    rendererPolicy: fixedHardwareTemplate ? 'stable-fixed-template' : 'vary-by-seed',
    rendererMatchesPolicy,
    imageVaries,
    pixelsVary,
    audioVaries,
    audioNativeCalibrationStable,
    canvasVaries,
    creepCanvasVaries,
    rectVaries,
    fontSetVaries,
    highEntropyVariation,
    highEntropyDifferenceCount,
    minimumHighEntropyDifferences,
    nativeReadbacksStable: !pixelsVary && !audioVaries,
    postProcessingRiskFields,
    crossSeedCollisionFields,
    unexpectedCollisionFields,
    canvasReadbackCoherent,
    canvasReadbackChecks,
    webglReadbackCoherent,
    webglReadbackChecks,
    speechLocaleCoherent,
    speechLocaleChecks,
    speechVoicesAvailable,
    speechPolicy,
    speechPolicyPassed,
    nativeLocaleSurfaces,
    webgpuAvailable,
    webgpuVaries,
    webgpuCoherent,
    webgpuCoherenceChecks,
    webgpuPolicy,
    webgpuPolicyPassed,
    webgpuNeedsKernelCoverage: nativeLocaleSurfaces && !webgpuPolicyPassed
  }
}

const identityFields = [
  'userAgent',
  'platform',
  'language',
  'languages',
  'intlLocale',
  'hardwareConcurrency',
  'deviceMemory',
  'timezone',
  'timezoneOffset',
  'userAgentData',
  'userAgentDataHighEntropy'
]

const identityHeaderFields = [
  'user-agent',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness'
]

function contextIdentityMatches(mainContext, context) {
  return Boolean(context && context.supported !== false
    && identityFields.every((field) => sameValue(context[field], mainContext[field])))
}

function contextHeadersMatch(mainContext, context) {
  if (!context?.requestHeaders || !mainContext?.requestHeaders) return false
  for (const field of identityHeaderFields) {
    const value = context.requestHeaders[field]
    if (field === 'user-agent' || field === 'accept-language') {
      if (value !== mainContext.requestHeaders[field]) return false
    } else if (value !== undefined && value !== mainContext.requestHeaders[field]) {
      return false
    }
  }
  return true
}

function offscreenMatches(mainContext, context) {
  return Boolean(mainContext?.offscreenCanvas?.supported && context?.offscreenCanvas?.supported
    && sameValue(context.offscreenCanvas, mainContext.offscreenCanvas))
}

function auditExecutionContexts(sample) {
  const mainContext = sample.contexts?.window
  const names = ['iframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker']
  const contexts = Object.fromEntries(names.map((name) => [name, {
    identity: contextIdentityMatches(mainContext, sample.contexts?.[name]),
    headers: contextHeadersMatch(mainContext, sample.contexts?.[name]),
    offscreenCanvas: offscreenMatches(mainContext, sample.contexts?.[name])
  }]))
  return {
    contexts,
    identity: Object.values(contexts).every((value) => value.identity),
    headers: Object.values(contexts).every((value) => value.headers),
    offscreenCanvas: Object.values(contexts).every((value) => value.offscreenCanvas),
    audioWorklet: sample.contexts?.audioWorklet?.supported === true && sample.contexts.audioWorklet.sampleRate === 44100
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await access(options.browser)
  const auditServer = await startAuditServer()
  options.auditUrl = auditServer.url
  const root = await mkdtemp(join(tmpdir(), 'prism-fingerprint-audit-'))
  try {
    const first = await collectSample(options, root, 'seed-a-first', options.seedA)
    const repeat = await collectSample(options, root, 'seed-a-repeat', options.seedA)
    const different = await collectSample(options, root, 'seed-b', options.seedB)
    const stable = sameValue(comparable(first), comparable(repeat))
    const isolationFields = [
      'fontSetSha256',
      'canvasSha256',
      'creepCanvasSha256',
      'webglVendor',
      'webglRenderer',
      'webglImageSha256',
      'webglPixelsSha256',
      'audioSha256',
      'rect',
      'speechVoicesSha256',
      'webgpuSha256',
    ]
    const differingFields = isolationFields.filter((field) => !sameValue(first[field], different[field]))
    const fullVersionList = first.userAgentDataHighEntropy?.fullVersionList ?? []
    const highEntropyVersion = first.userAgentDataHighEntropy?.uaFullVersion === options.version
      || fullVersionList.some((item) => item.version === options.version && !/Not.A.Brand/i.test(item.brand))
    const requestHeaderVersion = first.requestHeaders?.['sec-ch-ua-full-version-list']?.includes(`"${options.version}"`) === true
    const versionConsistent = highEntropyVersion && requestHeaderVersion
    const platformVersionConsistent = first.userAgentDataHighEntropy?.platformVersion === options.platformVersion
      && first.requestHeaders?.['sec-ch-ua-platform-version'] === `"${options.platformVersion}"`
    const surfaceIsolation = options.surfaceMode === 'template'
      || (options.surfaceMode === 'fixed-template' && ['v3', 'v4'].includes(options.renderIdentity))
      ? differingFields.length > 0
      : differingFields.length === 0
    const contextAudits = [first, repeat, different].map(auditExecutionContexts)
    const renderIdentityReadiness = renderBundleReadiness(
      first,
      different,
      options.language,
      options.renderIdentity,
      options.surfaceMode
    )
    const renderIdentityGate = !options.renderIdentity || renderIdentityReadiness.passed
    const expectedLanguages = options.acceptLanguages.split(',').map((value) => value.trim()).filter(Boolean)
    const expectedAcceptLanguage = expectedLanguages
      .map((value, index) => index === 0 ? value : `${value};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`)
      .join(',')
    const configuration = {
      exactEngineVersion: versionConsistent,
      exactPlatformVersion: platformVersionConsistent,
      hardwareConcurrency: first.hardwareConcurrency === options.hardwareConcurrency,
      language: first.language === options.language && sameValue(first.languages, expectedLanguages),
      intlLocale: first.intlLocale === options.language,
      acceptLanguageHeader: first.requestHeaders?.['accept-language'] === expectedAcceptLanguage,
      timezone: first.timezone === options.timezone,
      geolocation: Math.abs((first.geolocation?.latitude ?? 0) - options.latitude) < 0.000001
        && Math.abs((first.geolocation?.longitude ?? 0) - options.longitude) < 0.000001
        && first.geolocation?.accuracy === options.locationAccuracy
        && first.geolocation?.repeatStable === true,
      platform: options.platform === 'windows'
        ? /Win/i.test(first.platform) && /Windows/i.test(first.userAgent)
        : /Mac/i.test(first.platform) && /Mac/i.test(first.userAgent),
      screen: first.screen.width === options.screenWidth && first.screen.height === options.screenHeight,
      expectedGpu: !options.expectedGpu || (
        first.webglRenderer?.includes(options.expectedGpu) === true
        && first.contexts?.window?.offscreenCanvas?.webgl?.renderer?.includes(options.expectedGpu) === true
      ),
      publicIp: !options.expectedPublicIp || (
        first.publicIp?.supported === true
        && first.publicIp.ip === options.expectedPublicIp
        && repeat.publicIp?.ip === options.expectedPublicIp
        && different.publicIp?.ip === options.expectedPublicIp
      ),
      webdriverHidden: first.webdriver === false
    }
    const consistency = {
      screenMedia: first.screenMedia?.matchMedia === true && first.screenMedia?.css === true,
      desktopWorkArea: first.screen?.availWidth <= first.screen?.width && first.screen?.availHeight < first.screen?.height,
      crossContextIdentity: contextAudits.every((audit) => audit.identity),
      crossContextHeaders: contextAudits.every((audit) => audit.headers),
      offscreenCanvas: contextAudits.every((audit) => audit.offscreenCanvas),
      audioWorklet: contextAudits.every((audit) => audit.audioWorklet),
      canvasRepeatStable: first.canvasRepeatStable === true,
      creepCanvasRepeatStable: first.creepCanvasRepeatStable === true,
      creepCanvasLowEntropyCalibration: first.creepCanvasLowEntropyProbe?.passed === true,
      canvasReadbackCoherent: first.canvasReadbackConsistency?.allDecodedMatch === true,
      webglReadbackCoherent: first.webglReadbackConsistency?.supported !== true
        || first.webglReadbackConsistency?.match === true,
      pixelscanCanvasCalibration: first.pixelscanMaskingProbe?.canvas?.passed === true,
      pixelscanWebglCalibration: first.pixelscanMaskingProbe?.webgl?.passed === true,
      creepDomRectAuthenticity: first.creepDomRectProbe?.passed === true,
      textMetricsNativeShape: first.textMetrics?.emptyIntegers === true && first.textMetrics?.sampleWidth > 10,
      rectMath: Object.values(first.rectConsistency?.element ?? {}).every(Boolean) && Object.values(first.rectConsistency?.range ?? {}).every(Boolean),
      audioSampleRate: first.audioConsistency == null || (
        first.audioConsistency.contextSampleRate === first.audioConsistency.requestedSampleRate &&
        first.audioConsistency.renderedSampleRate === first.audioConsistency.requestedSampleRate
      ),
      audioNativeCalibration: first.audioConsistency?.creepSampleSum != null
        && first.audioConsistency.creepSampleSum === repeat.audioConsistency?.creepSampleSum
        && first.audioConsistency.creepSampleSum === different.audioConsistency?.creepSampleSum,
      creepAudioNoiseTrap: first.audioConsistency?.creepNoiseTrapPassed === true
        && repeat.audioConsistency?.creepNoiseTrapPassed === true
        && different.audioConsistency?.creepNoiseTrapPassed === true,
      webrtcLeakFree: first.webrtc?.supported === true && first.webrtc.directIpCandidates === 0
    }
    const report = {
      schemaVersion: 14,
      generatedAt: new Date().toISOString(),
      browser: options.browser,
      auditMode: {
        platform: options.platform,
        sandboxDisabled: options.allowNoSandbox,
        surfaceMode: options.surfaceMode,
        debugTransport: resolvedDebugTransport(options),
        expectedVersion: options.version,
        expectedPlatformVersion: options.platformVersion,
        contract: {
          hardwareConcurrency: options.hardwareConcurrency,
          screenWidth: options.screenWidth,
          screenHeight: options.screenHeight,
          language: options.language,
          acceptLanguages: expectedLanguages,
          timezone: options.timezone,
          geolocation: {
            latitude: options.latitude,
            longitude: options.longitude,
            accuracy: options.locationAccuracy
          },
          seedA: options.seedA,
          seedB: options.seedB,
          disableSpoofing: options.disableSpoofing.split(',').filter(Boolean),
          renderIdentity: options.renderIdentity || null,
          expectedGpu: options.expectedGpu || null
        },
        proxy: {
          enabled: Boolean(options.proxyServer),
          expectedPublicIp: options.expectedPublicIp || null,
          directDnsDisabled: Boolean(options.proxyServer),
          quicDisabled: Boolean(options.proxyServer),
          nonProxiedWebRtcDisabled: true
        }
      },
      result: {
        passed: stable
          && surfaceIsolation
          && renderIdentityGate
          && Object.values(configuration).every(Boolean)
          && Object.values(consistency).every(Boolean),
        sameSeedStable: stable,
        differentSeedFields: differingFields,
        surfaceIsolation,
        renderIdentityReadiness,
        configuration,
        consistency,
        contextConsistency: contextAudits.map((audit, index) => ({
          sample: [first.name, repeat.name, different.name][index],
          ...audit.contexts
        }))
      },
      samples: [first, repeat, different]
    }
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(report, null, 2), 'utf8')
    console.log(`Fingerprint audit: ${report.result.passed ? 'PASS' : 'FAIL'}`)
    console.log(`Same seed stable: ${stable}`)
    console.log(`Different seed fields: ${differingFields.join(', ') || 'none'}`)
    console.log(`Shared cross-seed fields: ${renderIdentityReadiness.crossSeedCollisionFields.join(', ') || 'none'}`)
    console.log(`Renderer policy: ${renderIdentityReadiness.rendererPolicy} (${renderIdentityReadiness.rendererMatchesPolicy ? 'PASS' : 'FAIL'})`)
    console.log(`Speech policy: ${renderIdentityReadiness.speechPolicy} (${renderIdentityReadiness.speechPolicyPassed ? 'PASS' : 'FAIL'})`)
    console.log(`WebGPU policy: ${renderIdentityReadiness.webgpuPolicy} (${renderIdentityReadiness.webgpuPolicyPassed ? 'PASS' : 'FAIL'})`)
    console.log(`Coherent render bundle readiness: ${renderIdentityReadiness.passed ? 'PASS' : 'PENDING'}`)
    console.log(`Masking authenticity probes: ${consistency.pixelscanCanvasCalibration
      && consistency.pixelscanWebglCalibration
      && consistency.creepCanvasLowEntropyCalibration
      && consistency.creepDomRectAuthenticity
      && consistency.audioNativeCalibration
      && consistency.creepAudioNoiseTrap ? 'PASS' : 'FAIL'}`)
    console.log(`Cross-context identity: ${consistency.crossContextIdentity ? 'PASS' : 'FAIL'}`)
    console.log(`Report: ${options.output}`)
    if (!report.result.passed) process.exitCode = 1
  } finally {
    await auditServer.close()
    if (options.keepData) console.log(`Kept profile data: ${root}`)
    else {
      try {
        await removeTemporaryTree(root)
      } catch (error) {
        console.error(`Fingerprint audit temporary-data cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export { cleanupRetryDelay, removeTemporaryTree, renderBundleReadiness }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
