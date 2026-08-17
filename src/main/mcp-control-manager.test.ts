import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfile } from '../shared/types'
import { McpAuditLog } from './mcp-audit'
import { McpControlManager } from './mcp-control-manager'
import { McpPermissionStore } from './mcp-permission-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

function profile(id: string, serialNumber: number): BrowserProfile {
  return {
    id, serialNumber, name: `环境 ${serialNumber}`, note: '', group: '', tags: [], extensionIds: [], color: '#123456', startUrls: [], kernelVersion: '',
    window: { mode: 'auto', x: 0, y: 0, width: 1280, height: 720 }, favorite: false,
    proxy: { protocol: 'direct', host: '', username: '', password: '' },
    fingerprint: { seed: serialNumber, hardwareProfileId: 'macos-host', platform: 'macos', platformVersion: '15.0.0', brand: 'Chrome', brandVersion: '144.0.0.0', hardwareConcurrency: 8, language: 'zh-CN', acceptLanguages: 'zh-CN,zh', timezone: 'Asia/Shanghai', webrtcPolicy: 'proxy_only', networkIdentityMode: 'manual', proxyExitPolicy: 'warn', screenWidth: 1440, screenHeight: 900, disabledSpoofing: [] },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'closed'
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'prism-mcp-control-')); roots.push(root)
  const permissions = new McpPermissionStore(root)
  const audit = new McpAuditLog(root); await audit.initialize()
  const items = [profile('profile-1', 1), profile('profile-2', 2)]
  const profiles = { list: () => items, get: (id: string) => { const item = items.find((value) => value.id === id); if (!item) throw new Error('missing'); return item } }
  const launcher = {
    launch: vi.fn(async (id: string) => ({ ...profiles.get(id), status: 'running' as const })),
    close: vi.fn(async (id: string) => ({ ...profiles.get(id), status: 'closed' as const })),
    openPage: vi.fn(async (_id: string, url: string) => ({ url, title: 'Test', readyState: 'complete' })),
    pageSnapshot: vi.fn(async () => ({ url: 'https://example.com/', title: 'Test', readyState: 'complete', elements: [{ role: 'link', name: 'Next', ref: 'p1-e1' }], truncated: false })),
    clickPageElement: vi.fn(async () => ({ url: 'https://example.com/next', title: 'Next', readyState: 'complete' })),
    typePageElement: vi.fn(async () => ({ url: 'https://example.com/', title: 'Test', readyState: 'complete' }))
  }
  const licensing = { has: vi.fn(() => true) }
  const changed = vi.fn()
  const manager = new McpControlManager(permissions, profiles as never, launcher as never, licensing, audit, changed)
  await manager.initialize()
  return { root, permissions, audit, items, profiles, launcher, licensing, changed, manager }
}

describe('McpControlManager', () => {
  it('exposes and controls only profiles explicitly enabled by the user', async () => {
    const item = await fixture()
    await item.manager.setPermission('profile-1', true)
    expect(await item.manager.handleAgentRequest('mcp.profiles.list', {}, 'request-1')).toEqual([
      expect.objectContaining({ id: 'profile-1', name: '环境 1' })
    ])
    await expect(item.manager.handleAgentRequest('mcp.profiles.status', { profileId: 'profile-2' }, 'request-2'))
      .rejects.toThrow('尚未允许')
    await expect(item.manager.handleAgentRequest('mcp.profiles.launch', { profileId: 'profile-1' }, 'request-3'))
      .resolves.toMatchObject({ status: 'running' })
    expect(item.manager.status().controlledProfileIds).toEqual(['profile-1'])
    await item.audit.flush()
    const audit = await readFile(item.audit.path, 'utf8')
    expect(audit).toContain('"outcome":"success"')
    expect(audit).toContain('request-3')
    await item.manager.emergencyStop()
    expect(item.launcher.close).toHaveBeenCalledWith('profile-1')
  })

  it('tracks independent MCP client sessions and resets them on Agent exit', async () => {
    const item = await fixture()
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    await item.manager.handleAgentRequest('mcp.session.start', { sessionId: first }, 'start-1')
    await item.manager.handleAgentRequest('mcp.session.start', { sessionId: second }, 'start-2')
    expect(item.manager.status()).toMatchObject({ state: 'running', message: expect.stringContaining('2 个') })
    await item.manager.handleAgentRequest('mcp.session.stop', { sessionId: first }, 'stop-1')
    expect(item.manager.status().message).toContain('1 个')
    item.manager.resetSessions()
    expect(item.manager.status()).toMatchObject({ state: 'stopped' })
  })

  it('keeps page actions behind the same per-profile permission and omits page data from audit', async () => {
    const item = await fixture()
    await expect(item.manager.handleAgentRequest('mcp.pages.open', {
      profileId: 'profile-1', url: 'https://example.com/private?token=secret'
    }, 'page-denied')).rejects.toThrow('尚未允许')
    await item.manager.setPermission('profile-1', true)
    await expect(item.manager.handleAgentRequest('mcp.pages.open', {
      profileId: 'profile-1', url: 'https://example.com/private?token=secret'
    }, 'page-open')).resolves.toMatchObject({ readyState: 'complete' })
    await expect(item.manager.handleAgentRequest('mcp.pages.read', { profileId: 'profile-1' }, 'page-read'))
      .resolves.toMatchObject({ elements: [expect.objectContaining({ ref: 'p1-e1' })] })
    await expect(item.manager.handleAgentRequest('mcp.pages.click', { profileId: 'profile-1', ref: 'p1-e1' }, 'page-click'))
      .resolves.toMatchObject({ title: 'Next' })
    await expect(item.manager.handleAgentRequest('mcp.pages.type', {
      profileId: 'profile-1', ref: 'p2-e1', text: 'test-password-secret', clear: true
    }, 'page-type')).resolves.toMatchObject({ title: 'Test' })
    await item.audit.flush()
    const audit = await readFile(item.audit.path, 'utf8')
    expect(audit).toContain('page-open')
    expect(audit).toContain('page-read')
    expect(audit).not.toContain('example.com')
    expect(audit).not.toContain('test-password-secret')
  })

  it('allows revoking existing access without Pro but blocks granting new access', async () => {
    const item = await fixture()
    await item.manager.setPermission('profile-1', true)
    item.licensing.has.mockReturnValue(false)
    await expect(item.manager.setPermission('profile-1', false)).resolves.toEqual([
      expect.objectContaining({ profileId: 'profile-1', enabled: false })
    ])
    await expect(item.manager.setPermission('profile-2', true)).rejects.toThrow('需要 Prism Pro')
  })

  it('persists permissions and keeps secrets out of the MCP audit', async () => {
    const item = await fixture()
    await item.manager.setPermission('profile-1', true)
    await item.manager.shutdown()
    const reopened = new McpPermissionStore(item.root); await reopened.initialize()
    expect(reopened.enabled('profile-1')).toBe(true)
    const audit = await readFile(item.audit.path, 'utf8')
    expect(audit).toContain('permission-enable')
    expect(audit).not.toContain('password')
  })
})
