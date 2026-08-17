import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AutomationStartResult, AutomationStatus, BrowserProfile, McpConnection, McpStatus } from '../shared/types'
import type { Logger } from './app-logger'
import type { AutomationAuditLog } from './automation-audit'
import type { BrowserLauncher } from './browser-launcher'
import type { ProAgentChallenge, ProAgentHandshake } from './license-manager'
import type { ProfileStore } from './profile-store'
import { verifyProAgentBundle, type OsSignatureVerifier } from './pro-agent-integrity'

interface ProAgentLicenseAuthority {
  has(entitlement: 'automation-api' | 'mcp'): boolean
  proAgentReleasePublicKey(): Promise<string>
  createProAgentHandshake(challenge: ProAgentChallenge): Promise<ProAgentHandshake>
}

interface AgentMessage {
  type?: string
  id?: string
  method?: string
  params?: Record<string, unknown>
  challenge?: ProAgentChallenge
  endpoint?: string
  accessToken?: string
  mcpAccessToken?: string
  agentVersion?: string
}

type BundleVerifier = typeof verifyProAgentBundle
type SpawnAgent = typeof spawn

interface McpRequestBroker {
  handleAgentRequest(method: string, params: Record<string, unknown> | undefined, requestId: string): Promise<unknown>
  status(agentRunning?: boolean): McpStatus
  resetSessions(): void
}

function publicAutomationProfile(profile: BrowserProfile) {
  return {
    id: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    group: profile.group,
    tags: [...profile.tags],
    status: profile.status,
    lastOpenedAt: profile.lastOpenedAt
  }
}

function validProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Prism Pro Agent 返回的 API 地址无效')
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('Prism Pro Agent 必须只监听 127.0.0.1')
  return url.toString().replace(/\/$/, '')
}

function agentEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? ''
    }
  }
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8'
  }
}

export class ProAgentManager {
  private current: AutomationStatus = { state: 'stopped', message: '本地自动化 API 未启动', controlledProfileIds: [] }
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<AutomationStartResult> | null = null
  private controlled = new Set<string>()
  private expectedStop = false
  private mcpBroker?: McpRequestBroker
  private mcpAccessToken = ''
  private mcpTokenExposed = false
  private agentExecutable = ''

  constructor(
    private readonly profiles: ProfileStore,
    private readonly launcher: BrowserLauncher,
    private readonly licensing: ProAgentLicenseAuthority,
    private readonly audit: AutomationAuditLog,
    private readonly resourcesPath: string,
    private readonly onChanged: (status: AutomationStatus) => void,
    private readonly logger?: Logger,
    private readonly manifestPathOverride?: string,
    private readonly verifyBundle: BundleVerifier = verifyProAgentBundle,
    private readonly spawnAgent: SpawnAgent = spawn,
    private readonly verifyOsSignature?: OsSignatureVerifier
  ) {}

  status(): AutomationStatus {
    return { ...this.current, controlledProfileIds: [...this.controlled] }
  }

  attachMcpBroker(broker: McpRequestBroker): void { this.mcpBroker = broker }

  async mcpConnection(): Promise<McpConnection> {
    if (!this.licensing.has('mcp')) throw new Error('本地 AI MCP 需要 Prism Pro 授权')
    if (!this.mcpBroker) throw new Error('MCP 控制器尚未就绪')
    if (this.current.state !== 'running') await this.start()
    if (!this.mcpAccessToken || !this.agentExecutable) throw new Error('Prism Pro Agent 未返回 MCP 会话凭据')
    if (this.mcpTokenExposed) throw new Error('MCP 临时令牌已经显示过；如需重新配置，请停止后重新启动 MCP')
    this.mcpTokenExposed = true
    return {
      ...this.mcpBroker.status(true),
      command: this.agentExecutable,
      args: ['--mcp'],
      env: {
        PRISM_MCP_ENDPOINT: this.current.endpoint!,
        PRISM_MCP_TOKEN: this.mcpAccessToken
      }
    }
  }

  async start(): Promise<AutomationStartResult> {
    if (this.current.state === 'running') throw new Error('本地自动化 API 已经在运行；如需新令牌，请先停止后重新启动')
    if (this.starting) return this.starting
    this.starting = this.startInternal()
    try { return await this.starting } finally { this.starting = null }
  }

  private async startInternal(): Promise<AutomationStartResult> {
    if (!this.licensing.has('automation-api')) throw new Error('本地自动化 API 需要 Prism Pro 授权')
    this.setStatus({ state: 'starting', message: '正在启动本地自动化 API', controlledProfileIds: [] })
    try {
      const manifestPath = this.manifestPathOverride ?? join(this.resourcesPath, 'pro-agent', 'manifest.json')
      const releasePublicKey = await this.licensing.proAgentReleasePublicKey()
      const bundle = await this.verifyBundle({ manifestPath, releasePublicKey, verifyOsSignature: this.verifyOsSignature })
      const child = this.spawnAgent(bundle.executablePath, ['--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: agentEnvironment()
      }) as ChildProcessWithoutNullStreams
      this.child = child
      this.expectedStop = false
      let buffer = ''
      let handshakeSent = false
      const result = await new Promise<AutomationStartResult>((resolvePromise, reject) => {
        let settled = false
        let messageQueue = Promise.resolve()
        const timer = setTimeout(() => fail(new Error('Prism Pro Agent 启动超时')), 15_000)
        const fail = (error: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        }
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          if (Buffer.byteLength(buffer) > 256 * 1024) {
            fail(new Error('Prism Pro Agent 输出超出安全限制'))
            return
          }
          for (;;) {
            const lineEnd = buffer.indexOf('\n')
            if (lineEnd < 0) break
            const line = buffer.slice(0, lineEnd)
            buffer = buffer.slice(lineEnd + 1)
            if (!line.trim()) continue
            let message: AgentMessage
            try { message = JSON.parse(line) as AgentMessage } catch { fail(new Error('Prism Pro Agent 协议消息无效')); return }
            messageQueue = messageQueue.then(async () => {
              const handled = await this.handleMessage(message, bundle.manifest.payload.version, handshakeSent)
              if (handled.handshake) handshakeSent = true
              if (!handled.ready || settled) return
              settled = true
              clearTimeout(timer)
              const startedAt = new Date().toISOString()
              this.setStatus({
                state: 'running',
                message: '本地自动化 API 仅监听当前设备',
                endpoint: handled.ready.endpoint,
                agentVersion: bundle.manifest.payload.version,
                startedAt,
                controlledProfileIds: []
              })
              this.mcpAccessToken = handled.ready.mcpAccessToken
              this.mcpTokenExposed = false
              this.agentExecutable = bundle.executablePath
              this.audit.record({ action: 'agent-start', outcome: 'success' })
              resolvePromise({ ...this.status(), accessToken: handled.ready.accessToken })
            }).catch(fail)
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          this.logger?.error('Prism Pro Agent 写入了 stderr', { bytes: chunk.length })
        })
        child.once('error', (error) => fail(error))
        child.once('exit', (code, signal) => {
          this.child = null
          if (!settled) fail(new Error(`Prism Pro Agent 在就绪前退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`))
          this.mcpBroker?.resetSessions()
          if (this.expectedStop) this.setStatus({ state: 'stopped', message: '本地自动化 API 已停止', controlledProfileIds: [] })
          else this.setStatus({ state: 'error', message: '本地自动化 API 意外停止，请重新启动', controlledProfileIds: [...this.controlled] })
        })
      })
      return result
    } catch (error) {
      this.child?.kill('SIGKILL')
      this.child = null
      this.audit.record({ action: 'agent-start', outcome: 'failure', detail: error instanceof Error ? error.message : String(error) })
      this.setStatus({ state: 'error', message: '本地自动化 API 启动失败，请重试', controlledProfileIds: [] })
      throw error
    }
  }

  private async handleMessage(message: AgentMessage, expectedVersion: string, handshakeSent: boolean): Promise<{
    handshake?: true
    ready?: { endpoint: string; accessToken: string; mcpAccessToken: string }
  }> {
    if (message.type === 'challenge') {
      if (handshakeSent || !message.challenge || message.challenge.agentVersion !== expectedVersion) throw new Error('Prism Pro Agent 握手挑战无效')
      this.write({ type: 'handshake', handshake: await this.licensing.createProAgentHandshake(message.challenge) })
      return { handshake: true }
    }
    if (message.type === 'ready') {
      if (!handshakeSent || message.agentVersion !== expectedVersion || typeof message.accessToken !== 'string'
        || !/^[A-Za-z0-9_-]{43,128}$/.test(message.accessToken) || typeof message.mcpAccessToken !== 'string'
        || !/^[A-Za-z0-9_-]{43,128}$/.test(message.mcpAccessToken)
        || message.mcpAccessToken === message.accessToken) throw new Error('Prism Pro Agent 就绪消息无效')
      return { ready: { endpoint: validateEndpoint(message.endpoint), accessToken: message.accessToken, mcpAccessToken: message.mcpAccessToken } }
    }
    if (message.type === 'request') {
      if (!handshakeSent) throw new Error('Prism Pro Agent 尚未完成授权握手')
      await this.handleRequest(message)
      return {}
    }
    throw new Error('Prism Pro Agent 发送了未知协议消息')
  }

  private async handleRequest(message: AgentMessage): Promise<void> {
    const id = typeof message.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(message.id) ? message.id : randomUUID()
    const method = message.method
    const profileId = message.params?.profileId
    if (method?.startsWith('mcp.')) {
      if (!this.mcpBroker) {
        this.write({ type: 'response', id, error: 'mcp_not_available' })
        return
      }
      try {
        const result = await this.mcpBroker.handleAgentRequest(method, message.params, id)
        this.write({ type: 'response', id, result })
      } catch (error) {
        this.write({ type: 'response', id, error: error instanceof Error ? error.message : 'mcp_request_failed' })
      }
      return
    }
    const action = method === 'profiles.list' ? 'profiles-list'
      : method === 'profiles.status' ? 'profile-status'
        : method === 'profiles.launch' ? 'profile-launch'
          : method === 'profiles.close' ? 'profile-close' : null
    if (!action) {
      this.write({ type: 'response', id, error: 'method_not_allowed' })
      return
    }
    try {
      this.audit.record({ action, outcome: 'allowed', requestId: id, profileId: validProfileId(profileId) ? profileId : undefined })
      let result: unknown
      if (method === 'profiles.list') result = this.profiles.list().map(publicAutomationProfile)
      else {
        if (!validProfileId(profileId)) throw new Error('环境 ID 无效')
        if (method === 'profiles.status') result = publicAutomationProfile(this.profiles.get(profileId))
        else if (method === 'profiles.launch') {
          result = publicAutomationProfile(await this.launcher.launch(profileId))
          this.controlled.add(profileId)
          this.notifyCurrent()
        } else {
          result = publicAutomationProfile(await this.launcher.close(profileId))
          this.controlled.delete(profileId)
          this.notifyCurrent()
        }
      }
      this.audit.record({ action, outcome: 'success', requestId: id, profileId: validProfileId(profileId) ? profileId : undefined })
      this.write({ type: 'response', id, result })
    } catch (error) {
      this.audit.record({ action, outcome: 'failure', requestId: id, profileId: validProfileId(profileId) ? profileId : undefined, detail: error instanceof Error ? error.message : String(error) })
      this.write({ type: 'response', id, error: error instanceof Error ? error.message : 'request_failed' })
    }
  }

  async stop(emergency = false): Promise<AutomationStatus> {
    const child = this.child
    this.expectedStop = true
    if (child) {
      this.write({ type: 'stop', emergency })
      const exited = await new Promise<boolean>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(false), 2_000)
        child.once('exit', () => { clearTimeout(timer); resolvePromise(true) })
      })
      if (!exited) child.kill('SIGKILL')
    }
    if (emergency) {
      await Promise.allSettled([...this.controlled].map((id) => this.launcher.close(id)))
      this.audit.record({ action: 'emergency-stop', outcome: 'success' })
    } else this.audit.record({ action: 'agent-stop', outcome: 'success' })
    this.controlled.clear()
    this.mcpAccessToken = ''
    this.mcpTokenExposed = false
    this.agentExecutable = ''
    this.mcpBroker?.resetSessions()
    this.child = null
    this.setStatus({ state: 'stopped', message: emergency ? '自动化已紧急停止，相关浏览器已关闭' : '本地自动化 API 已停止', controlledProfileIds: [] })
    return this.status()
  }

  private write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Prism Pro Agent 通道不可用')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private notifyCurrent(): void { this.onChanged(this.status()) }
  private setStatus(status: AutomationStatus): void { this.current = status; this.notifyCurrent() }
}
