import { CopyOutlined, LockOutlined, RobotOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Space, Switch, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, McpConnection, McpProfilePermission, McpStatus } from '../../shared/types'

interface McpModalProps {
  open: boolean
  status: McpStatus | null
  permissions: McpProfilePermission[]
  profiles: BrowserProfileView[]
  proEnabled: boolean
  onStatusChanged: (status: McpStatus) => void
  onPermissionsChanged: (permissions: McpProfilePermission[]) => void
  onClose: () => void
}

function connectionJson(connection: McpConnection): string {
  return JSON.stringify({
    mcpServers: {
      prism: { command: connection.command, args: connection.args, env: connection.env }
    }
  }, null, 2)
}

export function McpModal({ open, status, permissions, profiles, proEnabled, onStatusChanged, onPermissionsChanged, onClose }: McpModalProps) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [configuration, setConfiguration] = useState('')
  const [copied, setCopied] = useState(false)
  const enabled = useMemo(() => new Set(permissions.filter((item) => item.enabled).map((item) => item.profileId)), [permissions])

  useEffect(() => {
    if (!open) { setConfiguration(''); setError(''); setCopied(false); setBusy('') }
  }, [open])

  function humanError(cause: unknown): string {
    return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error: /, '')
  }

  async function setPermission(profileId: string, allow: boolean): Promise<void> {
    setBusy(profileId); setError('')
    try { onPermissionsChanged(await window.browserApi.mcp.setPermission(profileId, allow)) }
    catch (cause) { setError(humanError(cause)) }
    finally { setBusy('') }
  }

  async function start(): Promise<void> {
    setBusy('start'); setError(''); setCopied(false)
    try {
      const connection = await window.browserApi.mcp.start()
      onStatusChanged(connection)
      setConfiguration(connectionJson(connection))
    } catch (cause) { setError(humanError(cause)) }
    finally { setBusy('') }
  }

  async function stop(emergency: boolean): Promise<void> {
    setBusy(emergency ? 'emergency' : 'stop'); setError('')
    try {
      const next = emergency ? await window.browserApi.mcp.emergencyStop() : await window.browserApi.mcp.stop()
      onStatusChanged(next); setConfiguration(''); setCopied(false)
    } catch (cause) { setError(humanError(cause)) }
    finally { setBusy('') }
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(configuration)
    setCopied(true)
  }

  const stateLabel = status?.state === 'running' ? 'AI 已连接' : status?.state === 'ready' ? '等待连接' : status?.state === 'error' ? '异常' : '已停止'
  const active = status?.state === 'running' || status?.state === 'ready'

  return (
    <Modal open={open} width={820} title={<Space><RobotOutlined />本地 AI · MCP</Space>} footer={null} onCancel={onClose} className="mcp-modal">
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type={proEnabled ? active ? 'success' : 'info' : 'warning'} showIcon icon={<SafetyCertificateOutlined />}
          title={proEnabled ? status?.message ?? 'MCP 尚未启动' : '本地 AI 控制需要 Prism Pro'}
          description="AI 只能操作下方授权的环境，可以访问网页、读取内容、点击并填写表单，包括你提供的密码。"
        />
        <div className="mcp-status-row">
          <Space><Typography.Text type="secondary">状态</Typography.Text><Tag color={status?.state === 'running' ? 'green' : status?.state === 'ready' ? 'blue' : 'default'}>{stateLabel}</Tag></Space>
          <Space>
            {!active ? <Button type="primary" icon={<RobotOutlined />} loading={busy === 'start'} disabled={!proEnabled || !enabled.size} onClick={() => void start()}>生成 MCP 配置</Button>
              : <Button loading={busy === 'stop'} onClick={() => void stop(false)}>停止 MCP</Button>}
            <Popconfirm title="紧急停止 AI 控制？" description="将断开 MCP，并关闭本次由 MCP 启动的环境。共享的本地自动化 API 也会停止。" okText="紧急停止" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => stop(true)}>
              <Button danger icon={<StopOutlined />} disabled={!active || Boolean(busy)}>紧急停止</Button>
            </Popconfirm>
          </Space>
        </div>
        {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}

        <section className="mcp-permissions">
          <div className="mcp-section-heading"><div><strong>允许 AI 控制的环境</strong><span>默认全部关闭，逐个授权</span></div><Tag>{enabled.size} 个已授权</Tag></div>
          <div className="mcp-profile-list">
            {profiles.map((profile) => {
              const allowed = enabled.has(profile.id)
              return (
                <div className="mcp-profile" key={profile.id}>
                  <span className="profile-color" style={{ background: profile.color }} />
                  <div><strong>#{profile.serialNumber} · {profile.name}</strong><small>{profile.group || '未分组'} · {profile.status === 'running' ? '运行中' : '已关闭'}</small></div>
                  <Switch checked={allowed} loading={busy === profile.id} disabled={busy === profile.id || !proEnabled && !allowed} onChange={(value) => void setPermission(profile.id, value)} />
                </div>
              )
            })}
          </div>
        </section>

        {configuration && (
          <section className="mcp-configuration">
            <div className="mcp-section-heading"><div><strong><LockOutlined /> 一次性客户端配置</strong><span>粘贴到本地 AI 客户端的 MCP 配置中</span></div><Button icon={<CopyOutlined />} onClick={() => void copy()}>{copied ? '已复制' : '复制配置'}</Button></div>
            <Input.TextArea value={configuration} readOnly autoSize={{ minRows: 7, maxRows: 12 }} spellCheck={false} />
            <Alert type="warning" showIcon title="请勿分享连接配置" description="关闭 MCP 或退出 Prism 后，此配置会失效；使用期间请保持 Prism 运行。" />
          </section>
        )}
      </Space>
    </Modal>
  )
}
