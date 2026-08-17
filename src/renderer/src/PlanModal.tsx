import {
  ApiOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CrownOutlined,
  RobotOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons'
import { Alert, Button, Input, Modal, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { LicenseStatus } from '../../shared/types'

interface PlanModalProps {
  open: boolean
  license: LicenseStatus | null
  activating: boolean
  onActivate: (activationCode: string) => Promise<void>
  onDeactivate: () => Promise<void>
  onPurchase: () => Promise<void>
  onClose: () => void
}

const communityFeatures = [
  '不限数量的本地浏览器环境',
  '完整指纹内核、代理与 WebRTC 防泄漏',
  '独立 Cookie、缓存与浏览器数据',
  '环境复制、分组、标签与批量操作',
  '全部环境加密打包与跨设备迁移',
  '内置指纹内核随新版软件更新'
]

const proFeatures = [
  { icon: <ApiOutlined />, text: '本地自动化 API' },
  { icon: <ClockCircleOutlined />, text: '本地计划任务与定时执行' },
  { icon: <RobotOutlined />, text: '本地 AI · MCP 控制' }
]

export function PlanModal({ open, license, activating, onActivate, onDeactivate, onPurchase, onClose }: PlanModalProps) {
  const [activationCode, setActivationCode] = useState('')
  const activated = license?.plan === 'pro'

  useEffect(() => {
    if (!open) setActivationCode('')
  }, [open])

  async function activate(): Promise<void> {
    await onActivate(activationCode)
    setActivationCode('')
  }

  async function deactivate(): Promise<void> {
    await onDeactivate()
    setActivationCode('')
  }

  return (
    <Modal
      open={open}
      width={900}
      title={null}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      className="plan-modal"
    >
      <div className="plan-hero">
        <div className="plan-hero-icon"><CrownOutlined /></div>
        <div>
          <Tag color="geekblue">开源 · 本地优先</Tag>
          <Typography.Title level={2}>环境数据永不上云，专业能力按需激活</Typography.Title>
          <Typography.Paragraph>
            Community 与 Pro 的环境数据都只保存在当前设备，不会上传 Prism 服务器。
          </Typography.Paragraph>
        </div>
      </div>

      <div className="plan-grid">
        <section className="plan-card current">
          <div className="plan-card-heading">
            <div>
              <span className="plan-eyebrow">开源版本</span>
              <Typography.Title level={3}>Community</Typography.Title>
            </div>
            <strong className="plan-price">免费</strong>
          </div>
          <Typography.Paragraph type="secondary">适合个人、本地使用和开源社区。</Typography.Paragraph>
          <div className="plan-feature-list">
            {communityFeatures.map((feature) => (
              <div key={feature}><CheckCircleFilled /><span>{feature}</span></div>
            ))}
          </div>
          <Button block disabled>{activated ? 'Community 基础能力永久免费' : '正在使用'}</Button>
        </section>

        <section className="plan-card pro">
          <div className="plan-card-heading">
            <div>
              <span className="plan-eyebrow">单设备一年授权</span>
              <Typography.Title level={3}>Prism Pro</Typography.Title>
            </div>
            <Tag color={activated ? 'green' : 'purple'}>{activated ? '已激活' : '可选升级'}</Tag>
          </div>
          <Typography.Paragraph type="secondary">本地自动化、计划执行与安全的 AI 控制；从首次激活起一年内授权一台设备使用。</Typography.Paragraph>
          <div className="plan-feature-list pro-features">
            {proFeatures.map((feature) => (
              <div key={feature.text}>{feature.icon}<span>{feature.text}</span></div>
            ))}
          </div>
          {activated ? (
            <div className="activation-form">
              <div className="license-active-panel">
                <CheckCircleFilled />
                <div>
                  <strong>当前设备已激活</strong>
                  <span>一年授权 · 仅限当前设备</span>
                  {license.licenseId && <span>许可证 ID：{license.licenseId}</span>}
                  {license.maintenanceUntil && <span>Pro 授权有效至 {new Date(license.maintenanceUntil).toLocaleDateString('zh-CN')}</span>}
                </div>
              </div>
              <Button danger block loading={activating} onClick={() => void deactivate()}>
                解除当前设备
              </Button>
              <Typography.Text type="secondary">解绑后可在其他设备继续使用剩余有效期，本机环境数据不会删除。</Typography.Text>
            </div>
          ) : (
            <div className="activation-form">
              <Button block icon={<ShoppingCartOutlined />} onClick={() => void onPurchase()}>
                立即购买 Prism Pro
              </Button>
              <Typography.Text type="secondary">每枚激活码可在一台设备使用一年；解绑后可在另一台设备继续使用剩余有效期。</Typography.Text>
              <Input.Password
                value={activationCode}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
                disabled={!license?.activationAvailable || activating}
                onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
                onPressEnter={() => void activate()}
              />
              <Button
                type="primary"
                block
                icon={<CrownOutlined />}
                loading={activating}
                disabled={!license?.activationAvailable || activationCode.trim().length < 19}
                onClick={() => void activate()}
              >
                在当前设备激活
              </Button>
              <Typography.Text type="secondary">{license?.message ?? '正在检查激活服务…'}</Typography.Text>
            </div>
          )}
        </section>
      </div>

      <Alert
        type="info"
        showIcon
        title="本地隐私承诺"
        description="浏览器环境、Cookie、扩展数据和代理信息仅保存在当前设备。"
      />
    </Modal>
  )
}
