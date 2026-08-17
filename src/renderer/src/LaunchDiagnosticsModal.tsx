import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons'
import { Alert, List, Modal, Space, Tag, Typography } from 'antd'
import type { BrowserProfileView, LaunchDiagnosticReport } from '../../shared/types'

interface LaunchDiagnosticsModalProps {
  profile?: BrowserProfileView
  report?: LaunchDiagnosticReport
  open: boolean
  onClose: () => void
}

const statusView = {
  pass: { color: 'success', text: '通过', icon: <CheckCircleFilled /> },
  warning: { color: 'warning', text: '提醒', icon: <WarningFilled /> },
  error: { color: 'error', text: '失败', icon: <CloseCircleFilled /> }
} as const

export function LaunchDiagnosticsModal({ profile, report, open, onClose }: LaunchDiagnosticsModalProps) {
  return (
    <Modal open={open} title={`启动诊断${profile ? ` · ${profile.name}` : ''}`} footer={null} onCancel={onClose} destroyOnHidden>
      {report && (
        <>
          <Alert
            type={report.ready ? 'success' : 'error'}
            showIcon
            title={report.ready ? '未发现阻止启动的问题' : '发现可能导致启动失败的问题'}
            description={report.ready ? '提醒项不会阻止启动，但建议在正式业务使用前处理。' : '请处理失败项后重新诊断。'}
          />
          <List
            className="diagnostics-list"
            dataSource={report.checks}
            renderItem={(check) => {
              const view = statusView[check.status]
              return (
                <List.Item>
                  <List.Item.Meta
                    title={<Space><Tag color={view.color} icon={view.icon}>{view.text}</Tag><Typography.Text strong>{check.label}</Typography.Text></Space>}
                    description={check.message}
                  />
                </List.Item>
              )
            }}
          />
          <Typography.Text type="secondary">检查时间：{new Date(report.checkedAt).toLocaleString()}</Typography.Text>
        </>
      )}
    </Modal>
  )
}
