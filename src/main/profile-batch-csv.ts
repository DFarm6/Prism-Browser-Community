import { defaultProfileDraft } from '../shared/defaults'
import { refreshSeededGpuIdentity } from '../shared/hardware-profiles'
import type { BrowserBrand, BrowserPlatform, ProfileDraft, ProxyProtocol, WebRtcPolicy } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'

export const BATCH_PROFILE_COLUMNS = [
  'name',
  'group',
  'tags',
  'note',
  'start_urls',
  'kernel_version',
  'color',
  'proxy_protocol',
  'proxy_host',
  'proxy_port',
  'proxy_username',
  'proxy_password',
  'fingerprint_seed',
  'platform',
  'platform_version',
  'brand',
  'brand_version',
  'hardware_concurrency',
  'language',
  'accept_languages',
  'timezone',
  'screen_width',
  'screen_height',
  'window_mode',
  'window_x',
  'window_y',
  'window_width',
  'window_height',
  'webrtc_policy',
  'disabled_spoofing'
] as const

const MAX_BATCH_ROWS = 500
const MAX_CELL_LENGTH = 10_000

function parseCsv(raw: string): string[][] {
  const input = raw.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let afterQuote = false

  const pushCell = (): void => {
    if (cell.length > MAX_CELL_LENGTH) throw new Error('CSV 单元格不能超过 10000 个字符')
    row.push(cell)
    cell = ''
    afterQuote = false
  }
  const pushRow = (): void => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
        afterQuote = true
      } else {
        cell += char
      }
      continue
    }
    if (afterQuote) {
      if (char === ',') pushCell()
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && input[index + 1] === '\n') index += 1
        pushRow()
      } else if (char !== ' ' && char !== '\t') {
        throw new Error('CSV 引号字段结束后存在无效字符')
      }
      continue
    }
    if (char === '"') {
      if (cell.length) throw new Error('CSV 未转义的引号无效')
      quoted = true
    } else if (char === ',') {
      pushCell()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      pushRow()
    } else {
      cell += char
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号字段')
  if (cell.length || row.length) pushRow()
  return rows
}

function optionalInteger(value: string, column: string, rowNumber: number): number | undefined {
  if (!value.trim()) return undefined
  if (!/^\d+$/.test(value.trim())) throw new Error(`第 ${rowNumber} 行 ${column} 必须是整数`)
  return Number(value.trim())
}

function optionalSignedInteger(value: string, column: string, rowNumber: number): number | undefined {
  if (!value.trim()) return undefined
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`第 ${rowNumber} 行 ${column} 必须是整数`)
  return Number(value.trim())
}

function splitPipe(value: string): string[] {
  return value.split('|').map((item) => item.trim()).filter(Boolean)
}

function rowDraft(values: Record<string, string>, index: number, rowNumber: number): ProfileDraft {
  const draft = defaultProfileDraft(index)
  const protocol = (values.proxy_protocol.trim().toLowerCase() || 'direct') as ProxyProtocol
  const platform = (values.platform.trim().toLowerCase() || draft.fingerprint.platform) as BrowserPlatform
  const rawBrand = values.brand.trim()
  const brand = (rawBrand ? `${rawBrand[0].toUpperCase()}${rawBrand.slice(1).toLowerCase()}` : draft.fingerprint.brand) as BrowserBrand
  const webrtcPolicy = (values.webrtc_policy.trim().toLowerCase() || 'proxy_only') as WebRtcPolicy
  const port = optionalInteger(values.proxy_port, 'proxy_port', rowNumber)
  const seed = optionalInteger(values.fingerprint_seed, 'fingerprint_seed', rowNumber)
  const concurrency = optionalInteger(values.hardware_concurrency, 'hardware_concurrency', rowNumber)
  const screenWidth = optionalInteger(values.screen_width, 'screen_width', rowNumber)
  const screenHeight = optionalInteger(values.screen_height, 'screen_height', rowNumber)
  const windowX = optionalSignedInteger(values.window_x, 'window_x', rowNumber)
  const windowY = optionalSignedInteger(values.window_y, 'window_y', rowNumber)
  const windowWidth = optionalInteger(values.window_width, 'window_width', rowNumber)
  const windowHeight = optionalInteger(values.window_height, 'window_height', rowNumber)

  try {
    const fingerprint = refreshSeededGpuIdentity({
      ...draft.fingerprint,
      seed: seed ?? draft.fingerprint.seed,
      platform,
      platformVersion: values.platform_version.trim() || draft.fingerprint.platformVersion,
      brand,
      brandVersion: values.brand_version,
      hardwareConcurrency: (concurrency ?? draft.fingerprint.hardwareConcurrency) as typeof draft.fingerprint.hardwareConcurrency,
      language: values.language.trim() || draft.fingerprint.language,
      acceptLanguages: values.accept_languages.trim() || draft.fingerprint.acceptLanguages,
      timezone: values.timezone.trim() || draft.fingerprint.timezone,
      screenWidth: screenWidth ?? draft.fingerprint.screenWidth,
      screenHeight: screenHeight ?? draft.fingerprint.screenHeight,
      webrtcPolicy,
      disabledSpoofing: splitPipe(values.disabled_spoofing) as typeof draft.fingerprint.disabledSpoofing
    })
    return validateProfileDraft({
      ...draft,
      name: values.name,
      group: values.group,
      tags: splitPipe(values.tags),
      note: values.note,
      startUrls: values.start_urls.trim() ? splitPipe(values.start_urls) : [],
      kernelVersion: values.kernel_version,
      color: values.color.trim() || draft.color,
      proxy: {
        protocol,
        host: values.proxy_host,
        port,
        username: values.proxy_username,
        password: values.proxy_password
      },
      window: {
        ...draft.window,
        mode: values.window_mode.trim().toLowerCase() === 'custom' ? 'custom' : values.window_mode.trim().toLowerCase() === 'auto' || !values.window_mode.trim() ? 'auto' : values.window_mode.trim() as typeof draft.window.mode,
        x: windowX ?? draft.window.x,
        y: windowY ?? draft.window.y,
        width: windowWidth ?? draft.window.width,
        height: windowHeight ?? draft.window.height
      },
      fingerprint
    })
  } catch (error) {
    throw new Error(`第 ${rowNumber} 行：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function parseBatchProfileCsv(raw: string, suggestedStartIndex = 1): ProfileDraft[] {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('CSV 文件为空')
  if (raw.includes('\0')) throw new Error('CSV 文件包含无效的空字符')
  const rows = parseCsv(raw).filter((row) => row.some((cell) => cell.trim()) && !row[0]?.trim().startsWith('#'))
  if (!rows.length) throw new Error('CSV 文件为空')
  const headers = rows[0].map((value) => value.trim().toLowerCase())
  if (!headers.includes('name')) throw new Error('CSV 缺少必填列 name')
  if (new Set(headers).size !== headers.length) throw new Error('CSV 包含重复列名')
  const unknown = headers.filter((header) => !BATCH_PROFILE_COLUMNS.includes(header as typeof BATCH_PROFILE_COLUMNS[number]))
  if (unknown.length) throw new Error(`CSV 包含未知列：${unknown.join(', ')}`)
  const dataRows = rows.slice(1)
  if (!dataRows.length) throw new Error('CSV 没有可导入的数据行')
  if (dataRows.length > MAX_BATCH_ROWS) throw new Error(`CSV 单次最多导入 ${MAX_BATCH_ROWS} 行`)

  return dataRows.map((cells, index) => {
    if (cells.length > headers.length || cells.slice(headers.length).some((cell) => cell.trim())) {
      throw new Error(`第 ${index + 2} 行的列数超过表头`)
    }
    const values = Object.fromEntries(BATCH_PROFILE_COLUMNS.map((column) => [column, ''])) as Record<string, string>
    headers.forEach((header, columnIndex) => { values[header] = cells[columnIndex] ?? '' })
    return rowDraft(values, suggestedStartIndex + index, index + 2)
  })
}

export function serializeBatchProfileTemplate(): string {
  const example: Record<typeof BATCH_PROFILE_COLUMNS[number], string> = {
    name: '# 示例行（不会导入，请复制后修改名称）',
    group: '示例分组',
    tags: '重点|广告',
    note: '单元格可包含逗号',
    start_urls: 'https://example.com|https://browserleaks.com/',
    kernel_version: '',
    color: '#5965e8',
    proxy_protocol: 'http',
    proxy_host: 'proxy.example.com',
    proxy_port: '8080',
    proxy_username: 'user',
    proxy_password: '',
    fingerprint_seed: '',
    platform: 'windows',
    platform_version: '10.0.0',
    brand: 'Chrome',
    brand_version: '',
    hardware_concurrency: '8',
    language: 'zh-CN',
    accept_languages: 'zh-CN,zh,en-US,en',
    timezone: 'Asia/Shanghai',
    screen_width: '1440',
    screen_height: '900',
    window_mode: 'auto',
    window_x: '0',
    window_y: '0',
    window_width: '1200',
    window_height: '800',
    webrtc_policy: 'proxy_only',
    disabled_spoofing: ''
  }
  const escape = (value: string): string => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  const exampleRow = BATCH_PROFILE_COLUMNS.map((column) => escape(example[column])).join(',')
  return `\uFEFF${BATCH_PROFILE_COLUMNS.join(',')}\r\n${exampleRow}\r\n`
}
