#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { availableParallelism, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat, writeFile } from 'node:fs/promises'
import proxyChain from 'proxy-chain'
import { ProxyAgent, request } from 'undici'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const FINGERPRINT_AUDIT = resolve(TOOL_DIR, '../fingerprint-audit/run.mjs')
const GEO_URL = 'https://ipwho.is/'
const IP_URL = 'https://api.ipify.org?format=json'

const COUNTRY_LOCALES = {
  AU: ['en-AU', 'en-AU,en'],
  BR: ['pt-BR', 'pt-BR,pt,en-US,en'],
  CA: ['en-CA', 'en-CA,en-US,en'],
  CN: ['zh-CN', 'zh-CN,zh,en-US,en'],
  DE: ['de-DE', 'de-DE,de,en-US,en'],
  ES: ['es-ES', 'es-ES,es,en-US,en'],
  FR: ['fr-FR', 'fr-FR,fr,en-US,en'],
  GB: ['en-GB', 'en-GB,en-US,en'],
  HK: ['zh-HK', 'zh-HK,zh-TW,zh,en-US,en'],
  ID: ['id-ID', 'id-ID,id,en-US,en'],
  IN: ['en-IN', 'en-IN,en'],
  IT: ['it-IT', 'it-IT,it,en-US,en'],
  JP: ['ja-JP', 'ja-JP,ja,en-US,en'],
  KR: ['ko-KR', 'ko-KR,ko,en-US,en'],
  MX: ['es-MX', 'es-MX,es,en-US,en'],
  MY: ['ms-MY', 'ms-MY,ms,en-US,en'],
  NL: ['nl-NL', 'nl-NL,nl,en-US,en'],
  PH: ['en-PH', 'en-PH,en-US,en'],
  RU: ['ru-RU', 'ru-RU,ru,en-US,en'],
  SG: ['en-SG', 'en-SG,en-US,en'],
  TH: ['th-TH', 'th-TH,th,en-US,en'],
  TW: ['zh-TW', 'zh-TW,zh,en-US,en'],
  US: ['en-US', 'en-US,en'],
  VN: ['vi-VN', 'vi-VN,vi,en-US,en']
}

function currentPlatformVersion(platform) {
  if (platform === 'windows') return '10.0.0'
  const darwinMajor = Number(release().split('.')[0])
  if (!Number.isInteger(darwinMajor)) return '15.0.0'
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`
  return darwinMajor >= 20 ? `${darwinMajor - 9}.0.0` : '15.0.0'
}

function parseArguments(argv) {
  const platform = process.platform === 'win32' ? 'windows' : 'macos'
  const result = {
    browser: '',
    proxyFile: '',
    output: resolve('release/network-audit.json'),
    platform,
    platformVersion: '',
    version: '144.0.7559.132',
    hardwareConcurrency: Math.max(2, Math.min(64, availableParallelism())),
    screenWidth: platform === 'windows' ? 1920 : 1440,
    screenHeight: platform === 'windows' ? 1080 : 900,
    language: '',
    acceptLanguages: '',
    debugTransport: 'auto',
    allowNoSandbox: false
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--browser') result.browser = resolve(argv[++index] ?? '')
    else if (argument === '--proxy-file') result.proxyFile = resolve(argv[++index] ?? '')
    else if (argument === '--output') result.output = resolve(argv[++index] ?? '')
    else if (argument === '--platform') result.platform = argv[++index] ?? ''
    else if (argument === '--platform-version') result.platformVersion = argv[++index] ?? ''
    else if (argument === '--version') result.version = argv[++index] ?? ''
    else if (argument === '--hardware-concurrency') result.hardwareConcurrency = Number(argv[++index])
    else if (argument === '--screen-width') result.screenWidth = Number(argv[++index])
    else if (argument === '--screen-height') result.screenHeight = Number(argv[++index])
    else if (argument === '--language') result.language = argv[++index] ?? ''
    else if (argument === '--accept-languages') result.acceptLanguages = argv[++index] ?? ''
    else if (argument === '--debug-transport') result.debugTransport = argv[++index] ?? ''
    else if (argument === '--allow-no-sandbox') result.allowNoSandbox = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!result.browser || !result.proxyFile) {
    throw new Error('Usage: node tools/network-audit/run.mjs --browser /path/to/Chromium --proxy-file private-proxy.json [--output report.json]')
  }
  if (!['macos', 'windows'].includes(result.platform)) throw new Error('--platform must be macos or windows')
  if (!result.platformVersion) result.platformVersion = currentPlatformVersion(result.platform)
  return result
}

function validatedProxy(value) {
  if (!value || !['http', 'https', 'socks5'].includes(value.protocol)) {
    throw new Error('Proxy file protocol must be http, https or socks5')
  }
  if (typeof value.host !== 'string' || !value.host || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('Proxy file host or port is invalid')
  }
  if (/[/?#@\s]/.test(value.host) || value.host.includes('://')) {
    throw new Error('Proxy file host must not include protocol, credentials, port or path')
  }
  const normalizedHost = value.host.startsWith('[') && value.host.endsWith(']') ? value.host.slice(1, -1) : value.host
  const username = typeof value.username === 'string' ? value.username : ''
  const password = typeof value.password === 'string' ? value.password : ''
  const host = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost
  const credentials = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : ''
  const upstreamUrl = `${value.protocol}://${credentials}${host}:${value.port}`
  new URL(upstreamUrl)
  return {
    protocol: value.protocol,
    upstreamUrl
  }
}

async function lookupJson(url, dispatcher) {
  const response = await request(url, {
    dispatcher,
    headers: { accept: 'application/json', 'user-agent': 'Prism-Network-Audit/1' },
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new Error(`Network identity service returned HTTP ${response.statusCode}`)
  }
  return response.body.json()
}

function runFingerprintAudit(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [FINGERPRINT_AUDIT, ...args], { stdio: 'inherit', windowsHide: true })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => resolveRun({ code, signal }))
  })
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const proxyFileStat = await stat(options.proxyFile)
  if (process.platform !== 'win32' && (proxyFileStat.mode & 0o077) !== 0) {
    throw new Error('Proxy file permissions are too broad; run chmod 600 on the private proxy file')
  }
  const proxyConfig = JSON.parse(await readFile(options.proxyFile, 'utf8'))
  const privateProxy = validatedProxy(proxyConfig)
  const bridgeStats = { failures: 0, connectionsWithTraffic: 0, bytes: 0 }
  const bridge = new proxyChain.Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: privateProxy.upstreamUrl })
  })
  bridge.on('requestFailed', () => { bridgeStats.failures++ })
  bridge.on('connectionClosed', ({ stats }) => {
    const bytes = (stats?.trgRxBytes ?? 0) + (stats?.trgTxBytes ?? 0)
    if (bytes > 0) bridgeStats.connectionsWithTraffic++
    bridgeStats.bytes += bytes
  })
  await bridge.listen()
  const localProxy = `http://127.0.0.1:${bridge.port}`
  const dispatcher = new ProxyAgent(localProxy)
  try {
    const startedAt = Date.now()
    const [geo, independentIp] = await Promise.all([
      lookupJson(GEO_URL, dispatcher),
      lookupJson(IP_URL, dispatcher)
    ])
    if (geo.success === false) throw new Error(geo.message || 'Proxy geolocation lookup failed')
    if (isIP(geo.ip ?? '') === 0 || geo.ip !== independentIp.ip) {
      throw new Error(`Proxy exit mismatch between independent services (${geo.ip ?? '-'} / ${independentIp.ip ?? '-'})`)
    }
    if (!geo.country_code || !geo.timezone?.id
      || typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') {
      throw new Error('Proxy geolocation is incomplete; cannot build a coherent network identity')
    }
    new Intl.DateTimeFormat('en-US', { timeZone: geo.timezone.id }).format()
    const locale = COUNTRY_LOCALES[String(geo.country_code).toUpperCase()] ?? ['en-US', 'en-US,en']
    const language = options.language || locale[0]
    const acceptLanguages = options.acceptLanguages || locale[1]
    const auditArgs = [
      '--browser', options.browser,
      '--output', options.output,
      '--platform', options.platform,
      '--platform-version', options.platformVersion,
      '--version', options.version,
      '--surface-mode', 'native',
      '--hardware-concurrency', String(options.hardwareConcurrency),
      '--screen-width', String(options.screenWidth),
      '--screen-height', String(options.screenHeight),
      '--language', language,
      '--accept-languages', acceptLanguages,
      '--timezone', geo.timezone.id,
      '--latitude', String(geo.latitude),
      '--longitude', String(geo.longitude),
      '--location-accuracy', '25000',
      '--proxy-server', localProxy,
      '--expected-public-ip', geo.ip,
      '--debug-transport', options.debugTransport
    ]
    if (options.allowNoSandbox) auditArgs.push('--allow-no-sandbox')
    const execution = await runFingerprintAudit(auditArgs)
    const audit = JSON.parse(await readFile(options.output, 'utf8'))
    const summary = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      passed: execution.code === 0 && audit.result?.passed === true && bridgeStats.failures === 0,
      proxy: {
        protocol: privateProxy.protocol,
        credentialsUsed: Boolean(proxyConfig.username || proxyConfig.password)
      },
      preflight: {
        publicIp: geo.ip,
        ipVersion: isIP(geo.ip),
        countryCode: String(geo.country_code).toUpperCase(),
        timezone: geo.timezone.id,
        latitude: geo.latitude,
        longitude: geo.longitude,
        twoEndpointsAgree: true,
        latencyMs: Date.now() - startedAt
      },
      leakProtection: {
        browserPublicIpMatchesProxy: audit.result?.configuration?.publicIp === true,
        webRtcDirectIpCandidatesBlocked: audit.result?.consistency?.webrtcLeakFree === true,
        directDnsDisabled: audit.auditMode?.proxy?.directDnsDisabled === true,
        quicDisabled: audit.auditMode?.proxy?.quicDisabled === true,
        nonProxiedWebRtcDisabled: audit.auditMode?.proxy?.nonProxiedWebRtcDisabled === true
      },
      bridge: bridgeStats,
      fingerprintAudit: options.output
    }
    const summaryPath = options.output.replace(/\.json$/i, '.network.json')
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), { encoding: 'utf8', mode: 0o600 })
    console.log(`Network audit: ${summary.passed ? 'PASS' : 'FAIL'}`)
    console.log(`Summary: ${summaryPath}`)
    if (!summary.passed) process.exitCode = 1
  } finally {
    await dispatcher.close().catch(() => undefined)
    await bridge.close(true).catch(() => undefined)
  }
}

main().catch((error) => {
  const text = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(text.replace(/(https?|socks5):\/\/[^/@\s]*@/gi, '$1://[REDACTED]@'))
  process.exitCode = 1
})
