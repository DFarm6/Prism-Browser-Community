import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Input, Modal, Radio, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'

interface WorkspaceMigrationModalProps {
  mode: 'export' | 'import' | null
  busy: boolean
  profileCount: number
  onSubmit: (password: string, conflictPolicy: 'rename' | 'skip') => Promise<void>
  onClose: () => void
}

export function WorkspaceMigrationModal({ mode, busy, profileCount, onSubmit, onClose }: WorkspaceMigrationModalProps) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [conflictPolicy, setConflictPolicy] = useState<'rename' | 'skip'>('rename')

  useEffect(() => {
    setPassword('')
    setConfirmation('')
    setConflictPolicy('rename')
  }, [mode])

  const valid = password.length >= 10 && password.length <= 200 && (mode === 'import' || password === confirmation)

  return (
    <Modal
      open={mode !== null}
      title={mode === 'export' ? '导出全部环境' : '导入全部环境'}
      okText={mode === 'export' ? '选择位置并导出' : '选择迁移包并导入'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !valid }}
      closable={!busy}
      maskClosable={!busy}
      onOk={() => void onSubmit(password, conflictPolicy)}
      onCancel={onClose}
      className="workspace-migration-modal"
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          icon={<SafetyCertificateOutlined />}
          title={mode === 'export' ? `将打包本机 ${profileCount} 个环境` : '导入全部环境'}
          description={mode === 'export'
            ? '环境配置、代理信息、浏览器数据和本地扩展将加密保存到一个文件中。'
            : '密码错误或文件损坏时不会导入；已有环境不会被覆盖。'}
        />
        <div>
          <Typography.Text strong><LockOutlined /> 迁移密码</Typography.Text>
          <Input.Password
            value={password}
            autoComplete="new-password"
            placeholder="至少 10 个字符，请通过其他渠道妥善保存"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {mode === 'export' && (
          <div>
            <Typography.Text strong>再次输入密码</Typography.Text>
            <Input.Password value={confirmation} autoComplete="new-password" disabled={busy} onChange={(event) => setConfirmation(event.target.value)} />
            {confirmation && password !== confirmation && <Typography.Text type="danger">两次输入的密码不一致</Typography.Text>}
          </div>
        )}
        {mode === 'import' && (
          <div>
            <Typography.Text strong>遇到同名环境</Typography.Text>
            <Radio.Group value={conflictPolicy} disabled={busy} onChange={(event) => setConflictPolicy(event.target.value)}>
              <Space direction="vertical">
                <Radio value="rename">保留两者，为导入环境自动改名</Radio>
                <Radio value="skip">跳过同名环境</Radio>
              </Space>
            </Radio.Group>
          </div>
        )}
        <Typography.Text type="secondary">
          Prism 不保存迁移密码，密码遗失后无法恢复迁移包。跨系统迁移后，部分网站可能需要重新登录。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
