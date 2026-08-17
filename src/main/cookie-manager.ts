import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PortableCookie } from './cookie-file'
import type { Logger } from './app-logger'
import { locateBrowserForProfile } from './browser-locator'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'

interface DevToolsPage {
  type: string
  webSocketDebuggerUrl?: string
}

class CdpClient {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (!message.id) return
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(`CDP: ${message.error.message}`))
      else request.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('Cookie 维护会话意外断开'))
      this.pending.clear()
    })
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('连接 Cookie 维护会话超时'))
      }, 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpClient(socket))
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('无法连接 Cookie 维护会话'))
      }, { once: true })
    })
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Cookie 操作超时：${method}`))
      }, 15_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

async function waitForPage(userDataPath: string): Promise<{ port: number; websocket: string }> {
  const activePort = join(userDataPath, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [portText] = (await readFile(activePort, 'utf8')).split(/\r?\n/)
      const port = Number(portText)
      if (!Number.isInteger(port) || port < 1) throw new Error('invalid port')
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const pages = await response.json() as DevToolsPage[]
        const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return { port, websocket: page.webSocketDebuggerUrl }
      }
    } catch {
      // Chromium may still be starting or may not have written the complete port file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('启动 Cookie 维护会话超时')
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000))
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export class CookieManager {
  private readonly busyProfiles = new Set<string>()

  constructor(
    private readonly profiles: ProfileStore,
    private readonly settings: SettingsStore,
    private readonly logger?: Logger
  ) {}

  isBusy(id: string): boolean {
    return this.busyProfiles.has(id)
  }

  async exportCookies(id: string): Promise<PortableCookie[]> {
    const profile = this.ensureClosed(id)
    const cookies = await this.withSession(id, async (client) => {
      const result = await client.send<{ cookies: PortableCookie[] }>('Network.getAllCookies')
      return result.cookies
    })
    this.logger?.info('环境 Cookie 已导出', { profileId: id, count: cookies.length })
    return cookies
  }

  async importCookies(id: string, cookies: PortableCookie[]): Promise<number> {
    this.ensureClosed(id)
    const defaultExpires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const persistentCookies = cookies.map((cookie) => ({ ...cookie, expires: cookie.expires ?? defaultExpires }))
    await this.withSession(id, (client) => client.send('Network.setCookies', { cookies: persistentCookies }))
    this.logger?.info('环境 Cookie 已导入', { profileId: id, count: cookies.length })
    return cookies.length
  }

  private ensureClosed(id: string) {
    const profile = this.profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再管理 Cookie')
    return profile
  }

  private async withSession<T>(id: string, action: (client: CdpClient) => Promise<T>): Promise<T> {
    if (this.busyProfiles.has(id)) throw new Error('该环境正在执行 Cookie 操作')
    this.busyProfiles.add(id)
    try {
      const profile = this.profiles.get(id)
      await this.profiles.assertProfileDataIdentity(id)
      const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion)
      if (!engine.executable) {
        throw new Error(profile.kernelVersion
          ? `环境绑定的内核 ${profile.kernelVersion} 不可用，无法管理 Cookie`
          : '没有找到浏览器内核')
      }
      const userDataPath = this.profiles.profileDataPath(id)
      const activePort = join(userDataPath, 'DevToolsActivePort')
      await rm(activePort, { force: true })
      const child = spawn(engine.executable, [
        `--user-data-dir=${userDataPath}`,
        '--headless=new',
        '--disable-extensions',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ], { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
      let client: CdpClient | undefined
      try {
        const { websocket } = await waitForPage(userDataPath)
        client = await CdpClient.connect(websocket)
        await client.send('Network.enable')
        return await action(client)
      } finally {
        if (client) {
          await Promise.race([
            client.send('Browser.close').catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 1000))
          ])
          client.close()
        }
        await stopChild(child)
        await rm(activePort, { force: true })
      }
    } finally {
      this.busyProfiles.delete(id)
    }
  }
}
