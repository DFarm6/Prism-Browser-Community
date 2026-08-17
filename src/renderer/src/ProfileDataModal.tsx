import { DeleteOutlined, DownloadOutlined, FolderOpenOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Modal, Popconfirm, Space, Spin, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { BrowserProfileView, ProfileStorageInfo } from '../../shared/types'

interface ProfileDataModalProps {
  open: boolean
  profile?: BrowserProfileView
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function ProfileDataModal({ open, profile, onClose }: ProfileDataModalProps) {
  const [info, setInfo] = useState<ProfileStorageInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cookieBusy, setCookieBusy] = useState<'import' | 'export' | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    if (!profile) return
    setLoading(true)
    try {
      setInfo(await window.browserApi.profiles.storageInfo(profile.id))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open, profile?.id])

  async function clearCache(): Promise<void> {
    if (!profile) return
    setClearing(true)
    try {
      const previous = info?.cacheBytes ?? 0
      const next = await window.browserApi.profiles.clearCache(profile.id)
      setInfo(next)
      messageApi.success(`已清理 ${formatBytes(Math.max(0, previous - next.cacheBytes))} 缓存`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setClearing(false)
    }
  }

  async function openFolder(): Promise<void> {
    if (!profile) return
    try {
      await window.browserApi.profiles.openDataFolder(profile.id)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function transferCookies(mode: 'import' | 'export'): Promise<void> {
    if (!profile) return
    setCookieBusy(mode)
    try {
      const result = mode === 'import'
        ? await window.browserApi.profiles.importCookies(profile.id)
        : await window.browserApi.profiles.exportCookies(profile.id)
      if (result) messageApi.success(`已${mode === 'import' ? '导入' : '导出'} ${result.count} 条 Cookie`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setCookieBusy(null)
    }
  }

  async function exportBackup(): Promise<void> {
    if (!profile) return
    setBackupBusy(true)
    try {
      const result = await window.browserApi.profiles.exportBackup(profile.id)
      if (result) messageApi.success(`完整数据备份已导出，共 ${formatBytes(result.totalBytes)}、${result.fileCount} 个文件`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBackupBusy(false)
    }
  }

  const canClear = profile?.status === 'closed' || profile?.status === 'error'

  return (
    <Modal open={open} title={`环境数据 · ${profile?.name ?? ''}`} width={680} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        type="info"
        showIcon
        title="缓存清理不会删除账号登录状态"
        description="只清理缓存，Cookie、网站数据、书签和扩展不会被删除。"
      />
      <Spin spinning={loading}>
        <Descriptions className="profile-data-details" column={1} bordered size="small">
          <Descriptions.Item label="数据总量">{info ? formatBytes(info.totalBytes) : '—'}</Descriptions.Item>
          <Descriptions.Item label="可清理缓存">{info ? formatBytes(info.cacheBytes) : '—'}</Descriptions.Item>
          <Descriptions.Item label="数据目录">
            <Typography.Text copyable={{ text: info?.path }} className="data-path">{info?.path ?? '—'}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </Spin>
      <Space className="profile-data-actions">
        <Button icon={<FolderOpenOutlined />} onClick={() => void openFolder()}>打开数据目录</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>重新统计</Button>
        <Popconfirm
          title="清理该环境的浏览器缓存？"
          description="必须先关闭环境。Cookie 和站点登录数据不会被删除。"
          okText="清理缓存"
          cancelText="取消"
          onConfirm={clearCache}
        >
          <Button danger icon={<DeleteOutlined />} loading={clearing} disabled={!canClear}>清理缓存</Button>
        </Popconfirm>
      </Space>
      <div className="cookie-transfer">
        <div>
          <Typography.Text strong>完整数据备份</Typography.Text>
          <Typography.Text type="secondary">备份可能包含账号登录信息，请妥善保管；跨系统恢复后部分网站可能需要重新登录。</Typography.Text>
        </div>
        <Button icon={<DownloadOutlined />} loading={backupBusy} disabled={!canClear || backupBusy} onClick={() => void exportBackup()}>导出备份目录</Button>
      </div>
      <div className="cookie-transfer">
        <div>
          <Typography.Text strong>Cookie 迁移</Typography.Text>
          <Typography.Text type="secondary">支持常见 Cookie JSON 格式。导出文件包含登录信息，请妥善保管。</Typography.Text>
        </div>
        <Space>
          <Button icon={<UploadOutlined />} loading={cookieBusy === 'import'} disabled={!canClear || Boolean(cookieBusy)} onClick={() => void transferCookies('import')}>导入 Cookie</Button>
          <Button icon={<DownloadOutlined />} loading={cookieBusy === 'export'} disabled={!canClear || Boolean(cookieBusy)} onClick={() => void transferCookies('export')}>导出 Cookie</Button>
        </Space>
      </div>
    </Modal>
  )
}
