import { ApiOutlined, CopyOutlined, LockOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { AutomationStartResult, AutomationStatus } from '../../shared/types'

interface AutomationModalProps {
  open: boolean
  status: AutomationStatus | null
  proEnabled: boolean
  onChanged: (status: AutomationStatus) => void
  onClose: () => void
}

export function AutomationModal({ open, status, proEnabled, onChanged, onClose }: AutomationModalProps) {
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) { setToken(''); setError('') }
  }, [open])

  async function run(operation: () => Promise<AutomationStatus | AutomationStartResult>, keepToken = false): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      onChanged(result)
      setToken(keepToken && 'accessToken' in result ? result.accessToken : '')
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally { setBusy(false) }
  }

  const running = status?.state === 'running'
  const stateLabel = status?.state === 'running' ? '运行中'
    : status?.state === 'starting' ? '启动中'
      : status?.state === 'error' ? '异常'
        : status?.state === 'unavailable' ? '不可用' : '已停止'

  return (
    <Modal open={open} width={650} title={<Space><ApiOutlined />本地自动化 API</Space>} footer={null} onCancel={onClose} className="automation-modal">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type={running ? 'success' : proEnabled ? 'info' : 'warning'}
          showIcon
          icon={<SafetyCertificateOutlined />}
          title={running ? 'API 已启动，仅当前设备可访问' : proEnabled ? '默认关闭，按需启动' : '此功能需要 Prism Pro'}
          description="API 可以查询、启动和关闭浏览器环境，不能读取浏览器数据。"
        />

        <div className="automation-status-row">
          <div>
            <Typography.Text type="secondary">状态</Typography.Text>
            <div><Tag color={running ? 'green' : status?.state === 'error' ? 'red' : 'default'}>{status ? stateLabel : '正在检查'}</Tag>{status?.message}</div>
          </div>
        </div>

        {running && status?.endpoint && (
          <div className="automation-credential-box">
            <Typography.Text strong>API 地址</Typography.Text>
            <Input value={status.endpoint} readOnly />
            <Typography.Text strong><LockOutlined /> 本次访问令牌</Typography.Text>
            {token ? (
              <Input.Password
                value={token}
                readOnly
                addonAfter={<Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(token)}>复制</Button>}
              />
            ) : (
              <Typography.Text type="secondary">令牌只在启动成功时显示一次。需要新令牌时请停止并重新启动 API。</Typography.Text>
            )}
          </div>
        )}

        {status?.controlledProfileIds.length ? (
          <Typography.Text type="secondary">当前由 API 启动的环境：{status.controlledProfileIds.length} 个</Typography.Text>
        ) : null}
        {error && <Alert type="error" showIcon title={error} />}

        <div className="automation-actions">
          {!running ? (
            <Button type="primary" icon={<ApiOutlined />} loading={busy} disabled={!proEnabled || status?.state === 'starting'} onClick={() => void run(() => window.browserApi.automation.start(), true)}>
              启动本地 API
            </Button>
          ) : (
            <Button loading={busy} onClick={() => void run(() => window.browserApi.automation.stop())}>停止 API</Button>
          )}
          <Popconfirm
            title="紧急停止自动化？"
            description="这会停止 API，并关闭本次由 API 启动的浏览器环境。"
            okText="紧急停止"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => run(() => window.browserApi.automation.emergencyStop())}
          >
            <Button danger icon={<StopOutlined />} disabled={!running || busy}>紧急停止</Button>
          </Popconfirm>
        </div>
      </Space>
    </Modal>
  )
}
