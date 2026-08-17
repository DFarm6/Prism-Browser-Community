#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))

function parseArguments(argv) {
  const options = {
    browser: '',
    output: resolve('pixelscan-online-probe.json'),
    url: 'https://pixelscan.net/fingerprint-check',
    timeoutMs: 120_000,
    headed: false,
    instrumentPixelscan: false,
    browserArgs: []
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--browser') options.browser = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--url') options.url = argv[++index] ?? ''
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index])
    else if (argument === '--headed') options.headed = true
    else if (argument === '--instrument-pixelscan') options.instrumentPixelscan = true
    else if (argument === '--browser-arg') options.browserArgs.push(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.browser) throw new Error('Usage: node tools/pixelscan-online-probe/run.mjs --browser /path/to/chrome [--browser-arg value]')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000) throw new Error('--timeout-ms must be at least 10000')
  return options
}

class CdpConnection {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = null
  }

  async open() {
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', event => this.onMessage(event.data))
    this.socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed')))
    await new Promise((resolveOpen, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 15_000)
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolveOpen()
      }, { once: true })
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('CDP connection failed'))
      }, { once: true })
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timeout)
          resolveCommand(value)
        },
        reject
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  onMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    if (!message.id) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        Promise.resolve(listener(message.params, message.sessionId)).catch(() => {})
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  close() {
    this.socket?.close()
  }
}

async function reserveDebugPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  if (!port) throw new Error('Unable to reserve a local CDP port')
  return port
}

async function waitForEndpoint(port, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chromium exited before CDP startup')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const version = await response.json()
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl
      }
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for Chromium CDP port ${port}`)
}

function instrumentPixelscanMaskingChunk(source) {
  const componentEntry = 'checkFingerprintMasking(){var s=this;return(0,e.Z)(function*(){'
  const componentReplacement = `${componentEntry}window.__prismPixelscanComponent=s;`
  const sourceWithComponent = source.includes(componentEntry)
    ? source.replace(componentEntry, componentReplacement)
    : source
  const invalidUaBranch = 'n&&n.get(se.O.INVALID_UA)?s.store.dispatch((0,i.gi)({status:!1}))'
  const invalidUaReplacement = 'n&&n.get(se.O.INVALID_UA)?(window.__prismPixelscan={status:!1,reason:"INVALID_UA",invalidUa:n.get(se.O.INVALID_UA)},s.store.dispatch((0,i.gi)({status:!1})))'
  const sourceWithInvalidUa = sourceWithComponent.includes(invalidUaBranch)
    ? sourceWithComponent.replace(invalidUaBranch, invalidUaReplacement)
    : sourceWithComponent
  const callPrefix = 's.store.dispatch((0,i.gi)('
  const start = sourceWithInvalidUa.indexOf(`${callPrefix}{status:q,details:[`)
  if (start < 0) return { source: sourceWithInvalidUa, instrumented: sourceWithInvalidUa !== source }
  const payloadStart = start + callPrefix.length
  const tail = '}]}))})()'
  const tailStart = sourceWithInvalidUa.indexOf(tail, payloadStart)
  if (tailStart < 0) return { source: sourceWithInvalidUa, instrumented: sourceWithInvalidUa !== source }
  const payloadEnd = tailStart + 3
  const payload = sourceWithInvalidUa.slice(payloadStart, payloadEnd)
  const replacement = `window.__prismPixelscan=${payload},s.store.dispatch((0,i.gi)(window.__prismPixelscan))`
  return {
    source: sourceWithInvalidUa.slice(0, start) + replacement + sourceWithInvalidUa.slice(payloadEnd + 2),
    instrumented: true
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const root = await mkdtemp(join(tmpdir(), 'prism-pixelscan-probe-'))
  const userDataDir = join(root, 'user-data')
  const debugPort = await reserveDebugPort()
  const stderrChunks = []
  const child = spawn(options.browser, [
    `--user-data-dir=${userDataDir}`,
    ...(options.headed ? [] : ['--headless=new']),
    '--use-mock-keychain',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    ...options.browserArgs,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))
  let connection
  let pixelscanChunkInstrumented = false
  const networkDiagnostics = []
  const networkRequests = new Map()
  try {
    connection = new CdpConnection(await waitForEndpoint(debugPort, child))
    await connection.open()
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    await connection.send('Runtime.enable', {}, sessionId)
    await connection.send('Page.enable', {}, sessionId)
    connection.on('Network.requestWillBeSent', (params, requestSessionId) => {
      if (requestSessionId !== sessionId || !/pixelscan\.net/i.test(params.request?.url ?? '')) return
      networkRequests.set(params.requestId, {
        method: params.request.method,
        postData: params.request.postData ?? null
      })
    })
    connection.on('Network.responseReceived', async (params, responseSessionId) => {
      if (responseSessionId !== sessionId || !['XHR', 'Fetch'].includes(params.type)) return
      if (!/pixelscan\.net/i.test(params.response?.url ?? '')) return
      try {
        const body = await connection.send('Network.getResponseBody', { requestId: params.requestId }, sessionId)
        const text = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8').toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch {}
        networkDiagnostics.push({
          url: params.response.url,
          status: params.response.status,
          request: networkRequests.get(params.requestId) ?? null,
          body: parsed
        })
      } catch {}
    })
    await connection.send('Network.enable', {}, sessionId)
    if (options.instrumentPixelscan) {
      connection.on('Fetch.requestPaused', async (params, pausedSessionId) => {
        if (pausedSessionId !== sessionId) return
        try {
          const result = await connection.send('Fetch.getResponseBody', { requestId: params.requestId }, sessionId)
          const original = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8').toString('utf8')
          const instrumented = instrumentPixelscanMaskingChunk(original)
          pixelscanChunkInstrumented ||= instrumented.instrumented
          const responseHeaders = (params.responseHeaders ?? []).filter(header => !/^(content-encoding|content-length)$/i.test(header.name))
          await connection.send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: params.responseStatusCode ?? 200,
            responsePhrase: params.responseStatusText,
            responseHeaders,
            body: Buffer.from(instrumented.source).toString('base64')
          }, sessionId)
        } catch {
          await connection.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {})
        }
      })
      await connection.send('Fetch.enable', {
        patterns: [{ urlPattern: '*294.*.js*', requestStage: 'Response' }]
      }, sessionId)
    }
    await connection.send('Page.navigate', { url: options.url }, sessionId)
    const deadline = Date.now() + options.timeoutMs
    let snapshot = null
    const creepMode = /abrahamjuliot\.github\.io\/creepjs/i.test(options.url)
    while (Date.now() < deadline) {
      const evaluated = await connection.send('Runtime.evaluate', {
        expression: `(() => {
          const text = document.body?.innerText || ''
          const heading = [...document.querySelectorAll('strong')].find(node => node.textContent?.trim() === 'DOMRect')
          const card = heading?.closest('.col-six') || heading?.parentElement || null
          return {
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            text,
            domRect: card ? {
              found: true,
              rejected: card.classList.contains('rejected'),
              className: card.className,
              text: card.innerText
            } : { found: false }
          }
        })()`,
        returnByValue: true
      }, sessionId)
      snapshot = evaluated.result?.value ?? null
      const text = snapshot?.text ?? ''
      if (creepMode && snapshot?.domRect?.found && !/Computing\.\.\./i.test(snapshot.domRect.text ?? '')) break
      if (/No masking detected/i.test(text) || /(?:^|\n)Masking detected(?:\n|$)/i.test(text)) break
      await delay(1_000)
    }
    const text = snapshot?.text ?? ''
    const status = creepMode && snapshot?.domRect?.found
      ? (snapshot.domRect.rejected ? 'creep-domrect-rejected' : 'creep-domrect-authentic')
      : /No masking detected/i.test(text)
      ? 'no-masking-detected'
      : /(?:^|\n)Masking detected(?:\n|$)/i.test(text)
        ? 'masking-detected'
        : 'inconclusive'
    const diagnosticsEvaluation = await connection.send('Runtime.evaluate', {
      expression: `(async () => {
        const prismWindows = [window]
        for (let index = 0; index < window.frames.length; index++) {
          try { prismWindows.push(window.frames[index]) } catch {}
        }
        const capturedDispatch = prismWindows.map(value => {
          try { return value.__prismPixelscan || null } catch { return null }
        }).find(Boolean)
        if (capturedDispatch) {
          return {
            available: true,
            source: 'instrumented-store-dispatch',
            status: capturedDispatch.status,
            reason: capturedDispatch.reason || null,
            invalidUa: capturedDispatch.invalidUa || null,
            details: capturedDispatch.details || null
          }
        }
        const capturedComponent = prismWindows.map(value => {
          try { return value.__prismPixelscanComponent || null } catch { return null }
        }).find(Boolean) || null
        const element = document.querySelector('pxlscn-fingerprint-masking')
        if (!element && !capturedComponent) return { available: false, reason: 'component-element-missing' }
        const contextKey = element ? Object.getOwnPropertyNames(element).find(key => key.startsWith('__ngContext__')) : null
        const context = contextKey && element ? element[contextKey] : null
        const candidates = Array.isArray(context) ? context : []
        const component = capturedComponent
          || candidates.find(value => value && value.componentTitle === 'FingerprintMaskingComponent')
          || (globalThis.ng && typeof globalThis.ng.getComponent === 'function' ? globalThis.ng.getComponent(element) : null)
        if (!component) {
          return {
            available: false,
            reason: 'component-instance-missing',
            capturedComponent: Boolean(capturedComponent),
            contextKey: contextKey || null,
            contextType: typeof context,
            candidateTypes: candidates.map(value => value?.constructor?.name || typeof value).slice(0, 40)
          }
        }
        const safe = async callback => {
          try { return await callback() } catch (error) { return { error: error?.name || String(error) } }
        }
        const redHash = await safe(() => component.getFixedRedBoxHash())
        const workerValues = await safe(() => component.checkWebworkerValues())
        const identicalSecCh = await safe(() => component.checkIdenticalSecCh())
        const platform = await safe(() => component.checkPlatformConsistency())
        const locale = await safe(() => component.checkLocaleConsistency())
        const hardware = await safe(() => component.checkHardwareSanity())
        return {
          available: true,
          testCanvas2d: component.testCanvas2d,
          jsModifyDetected: component.jsModifyDetected,
          redHash,
          expectedRedHash: component.utils?.hashes?.red || null,
          redHashMatches: redHash === component.utils?.hashes?.red,
          workerValues,
          fakeNavigatorClear: component.checkFakeNavigatorObject(),
          identicalUserAgents: component.httpHeaders?.userAgent === navigator.userAgent,
          identicalSecCh,
          platform,
          locale,
          hardware,
          osMatch: Boolean(component.osDetectionResults?.comparedResult?.match || component.osDetectionResults?.comparedResult?.sameGroup),
          osFontsStatus: component.osDetectionResults?.osFontsStatus,
          osDetectionResults: component.osDetectionResults || null,
          webglStatus: component.webglData?.status,
          webglParams: component.webglData?.webglParams || null,
          selfFrameEqual: JSON.stringify(component.selfFpCollect) === JSON.stringify(component.frameFpCollect),
          selfFpCollect: component.selfFpCollect || null,
          frameFpCollect: component.frameFpCollect || null
        }
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    const fingerprintDiagnostics = diagnosticsEvaluation.result?.value ?? null
    const contextDiagnosticsEvaluation = await connection.send('Runtime.evaluate', {
      expression: `(async () => {
        const result = {
          fptcAvailable: typeof window.Fptc === 'function',
          fptcEqual: null,
          fptcDifferentFields: [],
          fptcMain: null,
          fptcFrame: null,
          worker: null
        }
        if (result.fptcAvailable) {
          try {
            result.fptcMain = await new window.Fptc().getFingerprints()
            const frame = document.createElement('iframe')
            frame.style.display = 'none'
            document.body.appendChild(frame)
            const source = window.Fptc.toString()
              .replace('function ()', 'function Fptc()')
              .replace('function()', 'function Fptc()')
            frame.contentWindow.eval(source)
            const collector = frame.contentWindow.eval('new Fptc()')
            result.fptcFrame = await collector.getFingerprints()
            frame.remove()
            const keys = [...new Set([...Object.keys(result.fptcMain || {}), ...Object.keys(result.fptcFrame || {})])]
            result.fptcDifferentFields = keys.filter(key => result.fptcMain?.[key] !== result.fptcFrame?.[key])
            result.fptcEqual = result.fptcDifferentFields.length === 0
          } catch (error) {
            result.fptcError = error?.name + ': ' + error?.message
          }
        }
        try {
          result.worker = await new Promise(resolveWorker => {
            const workerSource = \`try {
              const canvas = new OffscreenCanvas(16, 20)
              const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
              const extension = gl.getExtension('WEBGL_debug_renderer_info')
              postMessage({
                userAgent: self.navigator.userAgent,
                vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
                renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
              })
            } catch (error) { postMessage({ error: error.name + ': ' + error.message }) }\`
            const worker = new Worker(URL.createObjectURL(new Blob([workerSource])))
            worker.onmessage = event => {
              const gl = document.createElement('canvas').getContext('webgl')
              const extension = gl.getExtension('WEBGL_debug_renderer_info')
              const main = {
                userAgent: navigator.userAgent,
                vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
                renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
              }
              resolveWorker({ main, worker: event.data, equal: JSON.stringify(main) === JSON.stringify(event.data) })
              worker.terminate()
            }
            worker.onerror = event => resolveWorker({ error: event.message })
          })
        } catch (error) {
          result.worker = { error: error?.name + ': ' + error?.message }
        }
        return result
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    const contextDiagnostics = contextDiagnosticsEvaluation.result?.value ?? null
    const report = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      url: options.url,
      browserMode: options.headed ? 'headed' : 'headless',
      status,
      passed: status === 'no-masking-detected' || status === 'creep-domrect-authentic',
      pixelscanInstrumentationRequested: options.instrumentPixelscan,
      pixelscanChunkInstrumented,
      fingerprintDiagnostics,
      contextDiagnostics,
      networkDiagnostics,
      page: {
        title: snapshot?.title ?? null,
        url: snapshot?.url ?? null,
        readyState: snapshot?.readyState ?? null,
        domRect: snapshot?.domRect ?? null,
        relevantLines: text.split(/\r?\n/).map(line => line.trim()).filter(line => /masking|fingerprint|browser|proxy|timezone|automated/i.test(line)).slice(0, 30)
      },
      stderr: Buffer.concat(stderrChunks).toString('utf8')
    }
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(report, null, 2), 'utf8')
    console.log(`Online fingerprint probe: ${report.passed ? 'PASS' : 'FAIL'}`)
    console.log(`Status: ${report.status}`)
    console.log(`Report: ${options.output}`)
    if (!report.passed) process.exitCode = 1
  } finally {
    connection?.close()
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      delay(3_000)
    ])
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
