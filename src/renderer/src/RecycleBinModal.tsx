import { DeleteOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { Button, Empty, List, Modal, Popconfirm, Select, Space, Spin, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { AppSettings, BrowserProfileView, DeletedProfileSummary } from '../../shared/types'

interface RecycleBinModalProps {
  open: boolean
  onClose: () => void
  onRestored: (profile: BrowserProfileView) => void
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function RecycleBinModal({ open, onClose, onRestored }: RecycleBinModalProps) {
  const [items, setItems] = useState<DeletedProfileSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [purging, setPurging] = useState<string | null>(null)
  const [retention, setRetention] = useState<AppSettings['recycleRetentionDays']>(0)
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [trash, days] = await Promise.all([
        window.browserApi.profiles.trash(),
        window.browserApi.profiles.recycleRetention()
      ])
      setItems(trash)
      setRetention(days)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function restore(item: DeletedProfileSummary): Promise<void> {
    setRestoring(item.trashId)
    try {
      const profile = await window.browserApi.profiles.restore(item.trashId)
      onRestored(profile)
      setItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(`“${profile.name}”及其浏览器数据已恢复`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRestoring(null)
    }
  }

  async function purge(item: DeletedProfileSummary): Promise<void> {
    setPurging(item.trashId)
    try {
      await window.browserApi.profiles.purgeTrash(item.trashId)
      setItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(`“${item.name}”已永久删除`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurging(null)
    }
  }

  async function emptyTrash(): Promise<void> {
    setPurging('__all__')
    try {
      const count = await window.browserApi.profiles.emptyTrash()
      setItems([])
      messageApi.success(`已永久删除 ${count} 个环境`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurging(null)
    }
  }

  async function changeRetention(days: AppSettings['recycleRetentionDays']): Promise<void> {
    try {
      setRetention(await window.browserApi.profiles.setRecycleRetention(days))
      messageApi.success(days ? `将在应用启动时自动删除超过 ${days} 天的环境` : '已关闭自动清理')
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  function requestRetention(days: AppSettings['recycleRetentionDays']): void {
    if (!days) {
      void changeRetention(days)
      return
    }
    Modal.confirm({
      title: `自动删除超过 ${days} 天的回收站环境？`,
      content: '该策略会在应用启动时永久删除过期环境及全部浏览器数据，删除后无法恢复。现有未过期环境不受影响。',
      okText: '启用自动清理',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => changeRetention(days)
    })
  }

  return (
    <Modal open={open} title="环境回收站" width={650} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <div className="recycle-toolbar">
        <div>
          <Typography.Text type="secondary">删除的环境保留在本机，恢复时会带回原浏览器数据和指纹。</Typography.Text>
          <Space size="small" className="recycle-policy">
            <Typography.Text type="secondary">自动清理</Typography.Text>
            <Select
              size="small"
              value={retention}
              onChange={requestRetention}
              options={[
                { value: 0, label: '永不' },
                { value: 7, label: '保留 7 天' },
                { value: 30, label: '保留 30 天' },
                { value: 90, label: '保留 90 天' }
              ]}
            />
          </Space>
        </div>
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Popconfirm
            title="清空环境回收站？"
            description="所有列表中的环境配置和浏览器数据将永久删除，无法恢复。"
            okText="永久删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={emptyTrash}
          >
            <Button size="small" danger disabled={!items.length} loading={purging === '__all__'}>清空</Button>
          </Popconfirm>
        </Space>
      </div>
      <Spin spinning={loading && items.length === 0}>
        <List
          dataSource={items}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站为空" /> }}
          renderItem={(item) => (
            <List.Item actions={[
              <Button key="restore" type="primary" ghost icon={<UndoOutlined />} loading={restoring === item.trashId} disabled={Boolean(purging)} onClick={() => void restore(item)}>恢复</Button>,
              <Popconfirm
                key="purge"
                title={`永久删除“${item.name}”？`}
                description="该环境的 Cookie、站点数据和配置将无法恢复。"
                okText="永久删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => purge(item)}
              >
                <Button danger type="text" icon={<DeleteOutlined />} loading={purging === item.trashId}>永久删除</Button>
              </Popconfirm>
            ]}>
              <List.Item.Meta
                title={item.name}
                description={<Space split="·"><span>{item.serialNumber ? `#${item.serialNumber}` : '旧环境'}</span><span>{formatBytes(item.sizeBytes)}</span><span>{new Date(item.deletedAt).toLocaleString()}</span></Space>}
              />
            </List.Item>
          )}
        />
      </Spin>
    </Modal>
  )
}
