import { Alert, Button, Empty, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import type { BrowserCrashRecord, BrowserProfileView } from '../../shared/types'

interface CrashHistoryModalProps {
  open: boolean
  profile?: BrowserProfileView
  records: BrowserCrashRecord[]
  loading: boolean
  recovering: boolean
  onClose: () => void
  onRecover: () => void
  onDiagnose: () => void
}

export function CrashHistoryModal({
  open,
  profile,
  records,
  loading,
  recovering,
  onClose,
  onRecover,
  onDiagnose
}: CrashHistoryModalProps) {
  const recoverable = profile?.status === 'error' || profile?.status === 'orphaned'
  return (
    <Modal
      open={open}
      title={`异常与恢复${profile ? ` · ${profile.name}` : ''}`}
      onCancel={onClose}
      destroyOnHidden
      footer={(
        <Space>
          <Button onClick={onDiagnose} disabled={!profile}>启动诊断</Button>
          {recoverable && (
            <Button type="primary" danger={profile?.status === 'orphaned'} loading={recovering} onClick={onRecover}>
              {profile?.status === 'orphaned' ? '结束遗留进程' : '重新启动环境'}
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </Space>
      )}
    >
      {profile?.lastError && (
        <Alert
          type={profile.status === 'orphaned' ? 'warning' : 'error'}
          showIcon
          title="最近异常状态"
          description={profile.lastError}
        />
      )}
      <Spin spinning={loading}>
        {records.length ? (
          <List
            dataSource={[...records].reverse()}
            renderItem={(record) => (
              <List.Item>
                <List.Item.Meta
                  title={(
                    <Space>
                      <Tag color="error">{record.phase === 'starting' ? '启动阶段' : '运行阶段'}</Tag>
                      <Typography.Text>{new Date(record.occurredAt).toLocaleString()}</Typography.Text>
                    </Space>
                  )}
                />
              </List.Item>
            )}
          />
        ) : !loading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有浏览器崩溃记录" /> : null}
      </Spin>
    </Modal>
  )
}
