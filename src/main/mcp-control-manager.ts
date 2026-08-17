import type { BrowserProfile, McpProfilePermission, McpStatus } from '../shared/types'
import type { BrowserLauncher } from './browser-launcher'
import type { McpAuditLog } from './mcp-audit'
import type { McpPermissionStore } from './mcp-permission-store'
import type { ProfileStore } from './profile-store'
import { safeErrorText } from './redaction'

interface McpLicenseAuthority { has(entitlement: 'mcp'): boolean }

function publicMcpProfile(profile: BrowserProfile) {
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

export class McpControlManager {
  private controlled = new Set<string>()
  private sessions = new Set<string>()

  constructor(
    private readonly permissions: McpPermissionStore,
    private readonly profiles: ProfileStore,
    private readonly launcher: BrowserLauncher,
    private readonly licensing: McpLicenseAuthority,
    private readonly audit: McpAuditLog,
    private readonly onChanged: (status: McpStatus) => void
  ) {}

  async initialize(): Promise<void> { await this.permissions.initialize() }

  permissionList(): McpProfilePermission[] { return this.permissions.list() }

  async setPermission(profileId: string, enabled: boolean): Promise<McpProfilePermission[]> {
    if (enabled && !this.licensing.has('mcp')) throw new Error('本地 AI 控制需要 Prism Pro 授权')
    this.profiles.get(profileId)
    const result = await this.permissions.set(profileId, enabled)
    this.audit.record({ action: enabled ? 'permission-enable' : 'permission-disable', outcome: 'success', profileId })
    this.changed()
    return result
  }

  async removeProfile(profileId: string): Promise<void> { await this.permissions.remove(profileId) }

  status(agentRunning = this.sessions.size > 0): McpStatus {
    const enabledProfileIds = this.profiles.list().filter((profile) => this.permissions.enabled(profile.id)).map((profile) => profile.id)
    return {
      state: this.sessions.size ? 'running' : agentRunning ? 'ready' : 'stopped',
      message: this.sessions.size ? `${this.sessions.size} 个本地 AI 客户端已连接 MCP` : agentRunning ? 'MCP 连接配置已就绪，等待本地 AI 连接' : '本地 MCP 会话未启动',
      enabledProfileIds,
      controlledProfileIds: [...this.controlled]
    }
  }

  resetSessions(): void {
    if (!this.sessions.size) return
    this.sessions.clear()
    this.changed()
  }

  async handleAgentRequest(method: string, params: Record<string, unknown> | undefined, requestId: string): Promise<unknown> {
    if (!this.licensing.has('mcp')) throw new Error('MCP 权限不可用')
    if (method === 'mcp.session.start' || method === 'mcp.session.stop') {
      const sessionId = params?.sessionId
      if (typeof sessionId !== 'string' || !/^[a-f\d-]{36}$/i.test(sessionId)) throw new Error('MCP 会话 ID 无效')
      if (method === 'mcp.session.start') this.sessions.add(sessionId)
      else this.sessions.delete(sessionId)
      this.audit.record({ action: method === 'mcp.session.start' ? 'session-start' : 'session-stop', outcome: 'success', requestId: sessionId })
      this.changed()
      return this.status()
    }
    const profileId = params?.profileId
    const action = method === 'mcp.profiles.list' ? 'profiles-list'
      : method === 'mcp.profiles.status' ? 'profile-status'
        : method === 'mcp.profiles.launch' ? 'profile-launch'
          : method === 'mcp.profiles.close' ? 'profile-close'
            : method === 'mcp.pages.open' ? 'page-open'
              : method === 'mcp.pages.read' ? 'page-read'
                : method === 'mcp.pages.click' ? 'page-click'
                  : method === 'mcp.pages.type' ? 'page-type' : null
    if (!action) throw new Error('MCP 方法不在白名单中')
    try {
      if (method === 'mcp.profiles.list') {
        this.audit.record({ action, outcome: 'allowed', requestId })
        const result = this.profiles.list().filter((profile) => this.permissions.enabled(profile.id)).map(publicMcpProfile)
        this.audit.record({ action, outcome: 'success', requestId })
        return result
      }
      if (typeof profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(profileId)) throw new Error('环境 ID 无效')
      if (!this.permissions.enabled(profileId)) throw new Error('该环境尚未允许本地 AI 控制')
      this.audit.record({ action, outcome: 'allowed', requestId, profileId })
      if (method === 'mcp.profiles.status') {
        const result = publicMcpProfile(this.profiles.get(profileId))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.profiles.launch') {
        const profile = await this.launcher.launch(profileId)
        this.controlled.add(profileId); this.changed()
        const result = publicMcpProfile(profile)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.open') {
        if (typeof params?.url !== 'string') throw new Error('网页地址无效')
        const result = await this.launcher.openPage(profileId, params.url)
        this.controlled.add(profileId); this.changed()
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.read') {
        const result = await this.launcher.pageSnapshot(profileId)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.click') {
        if (typeof params?.ref !== 'string') throw new Error('页面元素引用无效')
        const result = await this.launcher.clickPageElement(profileId, params.ref)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.type') {
        if (typeof params?.ref !== 'string' || typeof params?.text !== 'string'
          || (params.clear !== undefined && typeof params.clear !== 'boolean')) throw new Error('页面输入参数无效')
        const result = await this.launcher.typePageElement(profileId, params.ref, params.text, params.clear !== false)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      const profile = await this.launcher.close(profileId)
      this.controlled.delete(profileId); this.changed()
      const result = publicMcpProfile(profile)
      this.audit.record({ action, outcome: 'success', requestId, profileId })
      return result
    } catch (error) {
      this.audit.record({ action, outcome: 'failure', requestId, profileId: typeof profileId === 'string' ? profileId : undefined, detail: safeErrorText(error) })
      throw error
    }
  }

  async emergencyStop(): Promise<McpStatus> {
    await Promise.allSettled([...this.controlled].map((profileId) => this.launcher.close(profileId)))
    this.controlled.clear()
    this.sessions.clear()
    this.audit.record({ action: 'emergency-stop', outcome: 'success' })
    this.changed()
    return this.status(false)
  }

  async shutdown(): Promise<void> {
    this.sessions.clear()
    await this.audit.flush()
  }

  private changed(): void { this.onChanged(this.status()) }
}
