import { ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Col,
  ColorPicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Tabs,
  Typography
} from 'antd'
import { useEffect, useState } from 'react'
import { defaultPlatform, defaultProfileDraft, randomSeed } from '../../shared/defaults'
import { fingerprintVersionWarning } from '../../shared/fingerprint-consistency'
import {
  applyHardwareProfile,
  effectiveGpuIdentity,
  HARDWARE_PROFILES,
  hardwareProfile,
  hardwareProfileSummary,
  refreshSeededGpuIdentity
} from '../../shared/hardware-profiles'
import { effectiveNetworkIdentity } from '../../shared/network-identity'
import type { BrowserExtension, BrowserProfileView, EngineStatus, HardwareProfileId, KernelRelease, ProfileDraft, ProxyTestResult } from '../../shared/types'
import { kernelRequiresPro } from '../../shared/kernel-policy'

interface EditorValues extends Omit<ProfileDraft, 'startUrls' | 'color'> {
  startUrlsText: string
  color: string | { toHexString: () => string }
}

interface ProfileEditorProps {
  open: boolean
  profile?: BrowserProfileView
  suggestedIndex: number
  saving: boolean
  extensions: BrowserExtension[]
  engine: EngineStatus | null
  kernels: KernelRelease[]
  groups: string[]
  proEnabled: boolean
  onCancel: () => void
  onSave: (draft: ProfileDraft) => Promise<void>
}

function editorValues(profile: BrowserProfileView | undefined, index: number): EditorValues {
  const draft = profile ?? defaultProfileDraft(index)
  const fingerprint = { ...draft.fingerprint }
  return {
    name: draft.name,
    note: draft.note,
    group: draft.group,
    tags: [...draft.tags],
    extensionIds: [...draft.extensionIds],
    color: draft.color,
    startUrlsText: draft.startUrls.join('\n'),
    kernelVersion: draft.kernelVersion,
    window: { ...draft.window },
    proxy: { ...draft.proxy },
    fingerprint: {
      ...fingerprint,
      disabledSpoofing: [...draft.fingerprint.disabledSpoofing]
    }
  }
}

const riskLabels: Record<NonNullable<ProxyTestResult['networkRisk']>, string> = {
  tor: 'Tor 出口',
  vpn: 'VPN 网络',
  proxy: '代理网络',
  hosting: '机房网络'
}

export function ProfileEditor({ open, profile, suggestedIndex, saving, extensions, engine, kernels, groups, proEnabled, onCancel, onSave }: ProfileEditorProps) {
  const [form] = Form.useForm<EditorValues>()
  const proxyProtocol = Form.useWatch(['proxy', 'protocol'], form)
  const proxyPassword = Form.useWatch(['proxy', 'password'], form) ?? ''
  const proxyPasswordStored = Form.useWatch(['proxy', 'passwordStored'], form) === true
  const webrtcPolicy = Form.useWatch(['fingerprint', 'webrtcPolicy'], form) ?? 'proxy_only'
  const fingerprintTimezone = Form.useWatch(['fingerprint', 'timezone'], form)
  const fingerprintLanguage = Form.useWatch(['fingerprint', 'language'], form) ?? 'zh-CN'
  const fingerprintAcceptLanguages = Form.useWatch(['fingerprint', 'acceptLanguages'], form) ?? 'zh-CN,zh,en-US,en'
  const networkIdentityMode = Form.useWatch(['fingerprint', 'networkIdentityMode'], form) ?? 'manual'
  const brandVersion = Form.useWatch(['fingerprint', 'brandVersion'], form) ?? ''
  const hardwareProfileId = Form.useWatch(['fingerprint', 'hardwareProfileId'], form) ?? 'legacy-custom'
  const fingerprintSeed = Form.useWatch(['fingerprint', 'seed'], form) ?? 0
  const fingerprintGpuBucket = Form.useWatch(['fingerprint', 'gpuBucket'], form)
  const kernelVersion = Form.useWatch('kernelVersion', form) ?? ''
  const windowMode = Form.useWatch(['window', 'mode'], form) ?? 'auto'
  const [testingProxy, setTestingProxy] = useState(false)
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const pinnedKernel = kernels.find((kernel) => kernel.version === kernelVersion)
  const selectedEngine: EngineStatus | null = kernelVersion
    ? {
        executable: pinnedKernel?.executable ?? null,
        source: pinnedKernel ? 'profile' : 'missing',
        fingerprintKernel: true,
        label: pinnedKernel ? 'Fingerprint Chromium（环境固定）' : '固定内核未安装',
        version: kernelVersion
      }
    : engine
  const versionWarning = fingerprintVersionWarning(brandVersion, selectedEngine)
  const selectedHardware = hardwareProfile(hardwareProfileId)
  const selectedGpuIdentity = effectiveGpuIdentity({
    hardwareProfileId,
    seed: fingerprintSeed,
    gpuBucket: fingerprintGpuBucket
  })
  const hostPlatform = defaultPlatform()
  const timezoneMismatch = Boolean(proxyResult?.timezone && fingerprintTimezone && proxyResult.timezone !== fingerprintTimezone)
  const networkIdentity = effectiveNetworkIdentity({
    ...form.getFieldValue('fingerprint'),
    language: fingerprintLanguage,
    acceptLanguages: fingerprintAcceptLanguages,
    timezone: fingerprintTimezone,
    networkIdentityMode
  }, proxyResult?.ok ? proxyResult : profile?.proxyCheck)

  useEffect(() => {
    if (open) {
      form.setFieldsValue(editorValues(profile, suggestedIndex))
      setProxyResult(null)
    }
  }, [form, open, profile, suggestedIndex])

  async function testCurrentProxy(): Promise<void> {
    try {
      if (proxyProtocol !== 'direct') await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
      setTestingProxy(true)
      setProxyResult(null)
      setProxyResult(await window.browserApi.proxy.test(form.getFieldValue('proxy'), profile?.id))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setProxyResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setTestingProxy(false)
    }
  }

  async function submit(): Promise<void> {
    await form.validateFields()
    const values = form.getFieldsValue(true) as EditorValues
    const color = typeof values.color === 'string' ? values.color : values.color.toHexString()
    await onSave({
      name: values.name,
      note: values.note,
      group: values.group,
      tags: values.tags,
      color,
      startUrls: values.startUrlsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      kernelVersion: values.kernelVersion,
      window: values.window,
      proxy: values.proxy,
      extensionIds: values.extensionIds,
      fingerprint: values.fingerprint
    })
  }

  const general = (
    <div className="editor-section">
      <Form.Item name="name" label="环境名称" rules={[{ required: true, message: '请输入环境名称' }]}>
        <Input placeholder="例如：美国店铺 01" maxLength={60} />
      </Form.Item>
      <Form.Item name="color" label="标记颜色">
        <ColorPicker showText />
      </Form.Item>
      <Form.Item
        name="kernelVersion"
        label="浏览器内核"
        extra="长期使用的账号建议固定版本；自动模式会跟随应用当前选择的内核。"
      >
        <Select
          options={[
            { value: '', label: `自动跟随当前内核${engine?.version ? ` · ${engine.version}` : ''}` },
            ...kernels.map((kernel) => ({
              value: kernel.version,
              label: `${kernel.version}${kernelRequiresPro(kernel.version) ? ' · Pro' : ''}${kernel.origin === 'local-build' ? ' · 本地构建' : ''}`,
              disabled: kernelRequiresPro(kernel.version) && !proEnabled
            })),
            ...(kernelVersion && !pinnedKernel ? [{ value: kernelVersion, label: `${kernelVersion} · 当前未安装` }] : [])
          ]}
        />
      </Form.Item>
      {kernelVersion && !pinnedKernel && (
        <Alert type="error" showIcon message={`固定内核 ${kernelVersion} 当前不可用`} description="安装该版本后才能启动此环境，或者改回自动跟随。" />
      )}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name="group" label="环境分组">
            <AutoComplete
              allowClear
              options={groups.map((value) => ({ value }))}
              placeholder="选择已有分组或输入新分组"
              maxLength={40}
              filterOption={(input, option) => String(option?.value ?? '').toLocaleLowerCase().includes(input.toLocaleLowerCase())}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" maxCount={20} tokenSeparators={[',']} placeholder="输入后回车" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="startUrlsText" label="启动页面" extra="每行一个网址；不填写协议时自动使用 HTTPS">
        <Input.TextArea rows={4} placeholder={'https://example.com\nhttps://browserleaks.com/'} />
      </Form.Item>
      <Form.Item name="extensionIds" label="启动扩展" extra="从扩展管理中导入后，可为每个环境选择不同的扩展组合">
        <Select
          mode="multiple"
          allowClear
          placeholder={extensions.length ? '选择该环境启动时加载的扩展' : '尚未导入扩展'}
          options={extensions.map((extension) => ({
            value: extension.id,
            label: `${extension.name} · ${extension.version}`
          }))}
        />
      </Form.Item>
      <Divider />
      <Form.Item name={['window', 'mode']} label="浏览器窗口" extra="自动模式沿用指纹屏幕尺寸；自定义模式可固定窗口尺寸和桌面坐标。">
        <Select options={[{ value: 'auto', label: '自动尺寸与位置' }, { value: 'custom', label: '固定尺寸与位置' }]} />
      </Form.Item>
      {windowMode === 'custom' && (
        <>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="窗口尺寸">
                <Space.Compact block>
                  <Form.Item name={['window', 'width']} noStyle><InputNumber min={480} max={7680} precision={0} className="resolution-input" /></Form.Item>
                  <Input className="resolution-times" value="×" disabled />
                  <Form.Item name={['window', 'height']} noStyle><InputNumber min={360} max={4320} precision={0} className="resolution-input" /></Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="桌面坐标">
                <Space.Compact block>
                  <Form.Item name={['window', 'x']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="X" className="resolution-input" /></Form.Item>
                  <Input className="resolution-times" value="," disabled />
                  <Form.Item name={['window', 'y']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="Y" className="resolution-input" /></Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>
          <Alert type="info" showIcon message="多显示器允许负坐标；显示器布局变化后，过期坐标可能让窗口出现在屏幕之外。" />
        </>
      )}
      <Form.Item name="note" label="备注">
        <Input.TextArea rows={3} maxLength={500} showCount placeholder="仅保存在本机" />
      </Form.Item>
    </div>
  )

  const proxy = (
    <div className="editor-section">
      <Form.Item name={['proxy', 'protocol']} label="代理方式">
        <Select
          options={[
            { value: 'direct', label: '不使用代理（本地网络）' },
            { value: 'http', label: 'HTTP' },
            { value: 'https', label: 'HTTPS' },
            { value: 'socks5', label: 'SOCKS5' }
          ]}
        />
      </Form.Item>
      {proxyProtocol !== 'direct' && (
        <>
          <Row gutter={12}>
            <Col span={16}>
              <Form.Item name={['proxy', 'host']} label="主机" rules={[{ required: true, message: '请输入代理主机' }]}>
                <Input placeholder="proxy.example.com" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['proxy', 'port']} label="端口" rules={[{ required: true, message: '请输入端口' }]}>
                <InputNumber min={1} max={65535} className="full-width" placeholder="8080" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name={['proxy', 'username']} label="用户名">
                <Input autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="密码"
                extra={proxyPasswordStored
                  ? '已保存；代理地址和用户名未修改时，留空可保持原密码。'
                  : '密码将安全保存在当前设备。'}
              >
                <Space.Compact block>
                  <Form.Item name={['proxy', 'password']} noStyle>
                    <Input.Password
                      autoComplete="new-password"
                      placeholder={proxyPasswordStored ? '已保存，留空保持不变' : undefined}
                    />
                  </Form.Item>
                  {proxyPasswordStored && !proxyPassword && (
                    <Button onClick={() => form.setFieldValue(['proxy', 'passwordStored'], false)}>清除已保存</Button>
                  )}
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>
        </>
      )}
      <Space className="proxy-test-row">
        <Button loading={testingProxy} onClick={() => void testCurrentProxy()}>检测连接</Button>
        {proxyResult && !proxyResult.ok && <Typography.Text type="danger">连接失败：{proxyResult.error}</Typography.Text>}
      </Space>
      {proxyResult?.ok && (
        <div className="proxy-test-result">
          <div className="proxy-result-line">
            <Typography.Text strong>出口 IP：{proxyResult.ip}</Typography.Text>
            <Typography.Text type="secondary">{proxyResult.latencyMs} ms</Typography.Text>
            {proxyResult.networkRisk && <Tag color="warning">{riskLabels[proxyResult.networkRisk]}</Tag>}
          </div>
          {(proxyResult.country || proxyResult.city) && (
            <Typography.Text type="secondary">
              {[proxyResult.country, proxyResult.region, proxyResult.city].filter(Boolean).join(' · ')}
            </Typography.Text>
          )}
          {(proxyResult.asn || proxyResult.organization || proxyResult.isp) && (
            <Typography.Text type="secondary">
              {[proxyResult.asn ? `AS${proxyResult.asn}` : '', proxyResult.organization, proxyResult.isp]
                .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ')}
            </Typography.Text>
          )}
          {proxyResult.timezone && (
            <div className="proxy-timezone-row">
              <Typography.Text type={proxyResult.geoConfidence === 'conflict' || timezoneMismatch ? 'warning' : 'success'}>
                代理时区：{proxyResult.timezone} · {proxyResult.geoConfidence === 'conflict'
                  ? 'GeoIP 数据源存在冲突'
                  : timezoneMismatch ? `与指纹时区 ${fingerprintTimezone} 不一致` : '与指纹时区一致'}
              </Typography.Text>
              {timezoneMismatch && proxyResult.geoConfidence !== 'conflict' && (
                <Button size="small" onClick={() => form.setFieldValue(['fingerprint', 'timezone'], proxyResult.timezone)}>
                  应用代理时区
                </Button>
              )}
            </div>
          )}
          {proxyResult.latitude !== undefined && proxyResult.longitude !== undefined && (
            <Typography.Text type="secondary">
              城市级坐标：{proxyResult.latitude.toFixed(3)}, {proxyResult.longitude.toFixed(3)} · 精度约 {Math.round((proxyResult.accuracyMeters ?? 25000) / 1000)} km
            </Typography.Text>
          )}
          {networkIdentityMode === 'proxy' && (
            <Alert
              type={proxyResult.geoConfidence === 'conflict' ? 'warning' : 'success'}
              showIcon
              message={proxyResult.geoConfidence === 'conflict' ? '代理地理信息存在冲突' : '代理网络身份已生成'}
              description={proxyResult.geoConfidence === 'conflict'
                ? `${proxyResult.geoConflict}。继续使用可能影响指纹一致性；启动时会再次检测，并由用户确认是否继续。`
                : `${networkIdentity.language} · ${networkIdentity.acceptLanguages} · ${networkIdentity.timezone}`}
            />
          )}
          {proxyResult.degraded && <Typography.Text type="warning">{proxyResult.warning}</Typography.Text>}
        </div>
      )}
      <Divider />
      <Form.Item
        name={['fingerprint', 'webrtcPolicy']}
        label="WebRTC IP 策略"
        extra="视频通话兼容性与网络隐私之间的取舍；普通多环境使用建议保持默认。"
      >
        <Select
          options={[
            { value: 'proxy_only', label: '防泄漏（推荐）— 禁止非代理 UDP' },
            { value: 'public_only', label: '仅公网接口 — 不暴露本地地址' },
            { value: 'default', label: '系统默认 — 使用所有网络接口' }
          ]}
        />
      </Form.Item>
      {webrtcPolicy === 'proxy_only' && (
        <Alert
          type="success"
          showIcon
          message="WebRTC 防泄漏已开启"
          description={proxyProtocol === 'direct'
            ? '不会枚举本地接口；未配置 UDP 代理时 WebRTC 将使用 TCP，部分实时音视频性能可能下降。'
            : 'WebRTC 仅使用代理支持的 UDP 或 TCP，不允许通过本地网络绕过代理。'}
        />
      )}
      {webrtcPolicy === 'public_only' && (
        <Alert
          type="warning"
          showIcon
          message="可能暴露真实公网 IP"
          description="该模式隐藏本地网卡地址，但 WebRTC 可以使用系统默认公网接口；使用代理环境时不建议选择。"
        />
      )}
      {webrtcPolicy === 'default' && (
        <Alert
          type="error"
          showIcon
          message="高风险：WebRTC 使用所有接口"
          description="网页可能获取本地网卡或绕过代理的公网地址，仅用于兼容性排障。"
        />
      )}
    </div>
  )

  const fingerprint = (
    <div className="editor-section">
      <Form.Item
        name={['fingerprint', 'hardwareProfileId']}
        label="硬件模板"
        extra="请选择完整硬件组合，避免出现不合理的设备信息。"
      >
        <Select
          options={[
            ...HARDWARE_PROFILES.map((item) => ({
              value: item.id,
              label: item.label,
              disabled: item.hostMatched && item.platform !== hostPlatform
            })),
            ...(hardwareProfileId === 'legacy-custom' ? [{ value: 'legacy-custom', label: '旧版自定义配置（保持原指纹）' }] : [])
          ]}
          onChange={(id: HardwareProfileId) => {
            const current = form.getFieldValue('fingerprint')
            form.setFieldValue('fingerprint', applyHardwareProfile(current, id, { refreshSeededGpu: true }))
          }}
        />
      </Form.Item>
      {selectedHardware?.hostMatched && (
        <Alert
          type="success"
          showIcon
          message="使用当前设备的硬件信息"
          description="不同环境可能显示相同的硬件信息。"
        />
      )}
      {selectedHardware && !selectedHardware.hostMatched && (
        <Alert
          type="info"
          showIcon
          message={hardwareProfileSummary(selectedHardware.id)}
          description="同一环境的硬件信息保持稳定；重新生成后会获得新的身份。"
        />
      )}
      {selectedHardware?.renderIdentityMode === 'seeded-curated' && !selectedGpuIdentity && (
        <Alert
          type="warning"
          showIcon
          message="旧环境保持原有硬件信息"
          description="如需更换，请点击下方“重新生成”。"
        />
      )}
      {hardwareProfileId === 'legacy-custom' && (
        <Alert
          type="warning"
          showIcon
          message="这是升级前创建的自定义硬件组合"
          description="为避免已使用环境的指纹突变，当前值不会自动修改。新账号建议新建环境并选择成套硬件模板。"
        />
      )}
      <Divider />
      <Row gutter={12}>
        <Col span={16}>
          <Form.Item name={['fingerprint', 'seed']} label="指纹种子" rules={[{ required: true }]}>
            <InputNumber min={0} max={0xffffffff} precision={0} className="full-width" />
          </Form.Item>
        </Col>
        <Col span={8} className="seed-action">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              const current = form.getFieldValue('fingerprint')
              form.setFieldValue('fingerprint', refreshSeededGpuIdentity({
                ...current,
                seed: randomSeed()
              }))
            }}
          >
            重新生成
          </Button>
        </Col>
      </Row>
      <div className="form-hint prominent">
        {selectedHardware?.hostMatched
          ? '不同环境可能共享当前设备的硬件信息。'
          : '指纹种子决定环境身份。使用中的环境请勿随意修改；复制或重新生成会获得新身份。'}
      </div>
      <Divider />
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'platform']} label="模拟系统">
            <Select disabled={hardwareProfileId !== 'legacy-custom'} options={[{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'macOS' }]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'platformVersion']} label="系统版本">
            <Input
              disabled={hardwareProfileId !== 'legacy-custom'}
              placeholder="10.0.0"
              addonAfter={selectedHardware?.hostMatched ? '启动时读取本机' : undefined}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item
            name={['fingerprint', 'networkIdentityMode']}
            label="网络身份"
            extra="自动模式会在启动前检测代理并匹配语言、时区和位置。"
          >
            <Select options={[
              { value: 'proxy', label: '跟随代理出口（推荐）' },
              { value: 'manual', label: '手动固定' }
            ]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'proxyExitPolicy']} label="出口变化">
            <Select options={[
              { value: 'block', label: '阻止启动并确认（推荐）' },
              { value: 'warn', label: '仅告警，继续启动' }
            ]} />
          </Form.Item>
        </Col>
      </Row>
      {networkIdentityMode === 'proxy' && (
        <Alert
          type={proxyProtocol === 'direct' ? 'warning' : 'info'}
          showIcon
          message={proxyProtocol === 'direct' ? '当前没有配置代理' : '语言、时区和地理位置将在启动时跟随代理'}
          description={proxyProtocol === 'direct'
            ? '直连环境继续使用下方手动值；配置代理后自动联动。'
            : `${networkIdentity.language} · ${networkIdentity.acceptLanguages} · ${networkIdentity.timezone}`}
        />
      )}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'brand']} label="浏览器品牌">
            <Select options={[{ value: 'Chrome', label: 'Chrome' }, { value: 'Edge', label: 'Edge' }]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            name={['fingerprint', 'brandVersion']}
            label="品牌版本"
            extra={selectedEngine?.version ? `留空时自动匹配内核 ${selectedEngine.version}` : '留空时与内核版本一致'}
            rules={[{ pattern: /^\d+(?:\.\d+){0,3}$/, message: '请输入 1–4 段数字版本，或留空自动匹配', validateTrigger: 'onBlur' }]}
          >
            <Input placeholder="自动" />
          </Form.Item>
        </Col>
      </Row>
      {versionWarning && <Alert type="warning" showIcon message={versionWarning} description="建议留空并自动匹配当前内核。" />}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'hardwareConcurrency']} label="CPU 核心数">
            <Select disabled={hardwareProfileId !== 'legacy-custom'} options={[2, 4, 6, 8, 10, 12, 14, 16, 20, 24].map((value) => ({ value, label: `${value} 核` }))} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="屏幕分辨率">
            <Space.Compact block>
              <Form.Item name={['fingerprint', 'screenWidth']} noStyle>
                <InputNumber disabled={hardwareProfileId !== 'legacy-custom'} min={800} max={7680} precision={0} className="resolution-input" />
              </Form.Item>
              <Input className="resolution-times" value="×" disabled />
              <Form.Item name={['fingerprint', 'screenHeight']} noStyle>
                <InputNumber disabled={hardwareProfileId !== 'legacy-custom'} min={600} max={4320} precision={0} className="resolution-input" />
              </Form.Item>
            </Space.Compact>
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'language']} label="界面语言">
            <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="zh-CN" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'timezone']} label="时区">
            <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="Asia/Shanghai" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name={['fingerprint', 'acceptLanguages']} label="Accept-Language">
        <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="zh-CN,zh,en-US,en" />
      </Form.Item>
      <Form.Item name={['fingerprint', 'disabledSpoofing']} label="关闭部分伪装" extra="仅用于排障，正常情况下保持全不选。">
        <Checkbox.Group
          options={[
            { value: 'font', label: '字体' },
            { value: 'audio', label: 'Audio' },
            { value: 'canvas', label: 'Canvas' },
            { value: 'clientrects', label: 'ClientRects' },
            { value: 'gpu', label: 'GPU' }
          ]}
        />
      </Form.Item>
    </div>
  )

  return (
    <Modal
      open={open}
      title={profile ? '编辑浏览器环境' : '新建浏览器环境'}
      width={720}
      destroyOnHidden
      confirmLoading={saving}
      okText={profile ? '保存修改' : '创建环境'}
      cancelText="取消"
      onCancel={onCancel}
      onOk={() => void submit()}
    >
      <Typography.Paragraph type="secondary" className="editor-intro">
        每个环境的数据、指纹和网络设置彼此独立。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onValuesChange={(changed) => { if ('proxy' in changed) setProxyResult(null) }}
      >
        <Tabs
          defaultActiveKey="general"
          items={[
            { key: 'general', label: '基础设置', children: general, forceRender: true },
            { key: 'proxy', label: '代理设置', children: proxy, forceRender: true },
            { key: 'fingerprint', label: '指纹设置', children: fingerprint, forceRender: true }
          ]}
        />
      </Form>
    </Modal>
  )
}
