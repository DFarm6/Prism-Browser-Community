interface CookieInput {
  name?: unknown
  value?: unknown
  domain?: unknown
  url?: unknown
  path?: unknown
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expires?: unknown
  expirationDate?: unknown
  session?: unknown
  priority?: unknown
}

export interface PortableCookie {
  name: string
  value: string
  domain?: string
  url?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expires?: number
  priority?: 'Low' | 'Medium' | 'High'
}

interface PrismCookieFile {
  type: 'prism-browser-cookies'
  schemaVersion: 1
  exportedAt: string
  profileName: string
  cookies: CookieInput[]
}

function normalizeSameSite(value: unknown): PortableCookie['sameSite'] {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase().replaceAll('-', '_')
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'None'
  return undefined
}

function normalizeCookie(input: CookieInput, index: number): PortableCookie {
  if (typeof input.name !== 'string' || !input.name || input.name.length > 4096) {
    throw new Error(`第 ${index + 1} 条 Cookie 名称无效`)
  }
  if (typeof input.value !== 'string' || input.value.length > 64 * 1024) {
    throw new Error(`第 ${index + 1} 条 Cookie 值无效或过长`)
  }
  const domain = typeof input.domain === 'string' ? input.domain.trim() : ''
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!domain && !url) throw new Error(`第 ${index + 1} 条 Cookie 缺少 domain 或 url`)
  if (domain && (domain.length > 253 || /[\s/:]/.test(domain))) throw new Error(`第 ${index + 1} 条 Cookie 域名无效`)
  if (url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`第 ${index + 1} 条 Cookie URL 无效`)
  }
  const path = typeof input.path === 'string' && input.path.startsWith('/') ? input.path : '/'
  const expiration = input.session === true ? undefined : Number(input.expires ?? input.expirationDate)
  const expires = typeof expiration === 'number' && Number.isFinite(expiration) && expiration > 0 ? expiration : undefined
  const priority = ['Low', 'Medium', 'High'].includes(String(input.priority))
    ? input.priority as PortableCookie['priority']
    : undefined
  const sameSite = normalizeSameSite(input.sameSite)
  const secure = input.secure === true
  if (sameSite === 'None' && !secure) throw new Error(`第 ${index + 1} 条 Cookie 使用 SameSite=None 时必须启用 Secure`)
  return {
    name: input.name,
    value: input.value,
    ...(domain ? { domain } : {}),
    ...(url ? { url } : {}),
    path,
    secure,
    httpOnly: input.httpOnly === true,
    ...(sameSite ? { sameSite } : {}),
    ...(expires ? { expires } : {}),
    ...(priority ? { priority } : {})
  }
}

export function parseCookieFile(raw: string): PortableCookie[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Cookie 文件不是有效的 JSON')
  }
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Partial<PrismCookieFile>).cookies)
      ? (value as Partial<PrismCookieFile>).cookies!
      : undefined
  if (!source) throw new Error('Cookie 文件必须是数组或 Prism Cookie 导出文件')
  if (source.length > 10_000) throw new Error('单次最多导入 10000 条 Cookie')
  return source.map((cookie, index) => {
    if (!cookie || typeof cookie !== 'object') throw new Error(`第 ${index + 1} 条 Cookie 格式无效`)
    return normalizeCookie(cookie as CookieInput, index)
  })
}

export function serializeCookieFile(profileName: string, cookies: CookieInput[]): string {
  const normalized = cookies.map((cookie, index) => normalizeCookie(cookie, index))
  const file: PrismCookieFile = {
    type: 'prism-browser-cookies',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    profileName,
    cookies: normalized
  }
  return JSON.stringify(file, null, 2)
}
