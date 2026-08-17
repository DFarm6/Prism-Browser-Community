import {
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons'
import { Alert, Button, Checkbox, Input, Modal, Popconfirm, Select, Space, Switch, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, ScheduledTask, ScheduledTaskDraft, ScheduledTaskSchedule } from '../../shared/types'

interface SchedulerModalProps {
  open: boolean
  tasks: ScheduledTask[]
  profiles: BrowserProfileView[]
  proEnabled: boolean
  onChanged: (tasks: ScheduledTask[]) => void
  onClose: () => void
}

const weekdays = [
  { label: '周日', value: 0 }, { label: '周一', value: 1 }, { label: '周二', value: 2 },
  { label: '周三', value: 3 }, { label: '周四', value: 4 }, { label: '周五', value: 5 }, { label: '周六', value: 6 }
]

function localDateTimeInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function defaultDraft(profileId = ''): ScheduledTaskDraft {
  return {
    name: '启动浏览器环境', profileId, action: 'launch', enabled: true,
    schedule: { kind: 'once', runAt: new Date(Date.now() + 10 * 60_000).toISOString() },
    missedPolicy: 'run_once', maxRetries: 1, retryDelayMinutes: 5
  }
}

function scheduleText(schedule: ScheduledTaskSchedule): string {
  if (schedule.kind === 'once') return `一次 · ${new Date(schedule.runAt).toLocaleString()}`
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  return `${schedule.weekdays.map((day) => weekdays.find((item) => item.value === day)?.label).join('、')} ${schedule.time}`
}

function outcomeTag(task: ScheduledTask) {
  if (!task.lastOutcome) return null
  const value = task.lastOutcome === 'success' ? { color: 'green', text: '成功' }
    : task.lastOutcome === 'skipped' ? { color: 'gold', text: '已跳过' } : { color: 'red', text: '失败' }
  return <Tag color={value.color}>{value.text}</Tag>
}

export function SchedulerModal({ open, tasks, profiles, proEnabled, onChanged, onClose }: SchedulerModalProps) {
  const [editing, setEditing] = useState<ScheduledTask | null | undefined>(undefined)
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => defaultDraft())
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const profileNames = useMemo(() => new Map(profiles.map((profile) => [profile.id, `#${profile.serialNumber} · ${profile.name}`])), [profiles])

  useEffect(() => {
    if (!open) { setEditing(undefined); setError(''); setBusyId('') }
  }, [open])

  function openEditor(task?: ScheduledTask): void {
    setError('')
    setEditing(task ?? null)
    setDraft(task ? {
      name: task.name, profileId: task.profileId, action: task.action, schedule: structuredClone(task.schedule),
      enabled: task.enabled, missedPolicy: task.missedPolicy, maxRetries: task.maxRetries, retryDelayMinutes: task.retryDelayMinutes
    } : defaultDraft(profiles[0]?.id))
  }

  async function operation(id: string, callback: () => Promise<unknown>): Promise<void> {
    setBusyId(id); setError('')
    try { await callback(); onChanged(await window.browserApi.scheduler.list()) }
    catch (cause) { setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error: /, '')) }
    finally { setBusyId('') }
  }

  async function save(): Promise<void> {
    if (!draft.name.trim()) { setError('请输入任务名称'); return }
    if (!draft.profileId) { setError('请选择浏览器环境'); return }
    if (draft.schedule.kind === 'weekly' && !draft.schedule.weekdays.length) { setError('每周任务至少选择一天'); return }
    setBusyId('save'); setError('')
    try {
      const normalized: ScheduledTaskDraft = {
        ...draft,
        schedule: draft.schedule.kind === 'once'
          ? { kind: 'once', runAt: new Date(draft.schedule.runAt).toISOString() }
          : structuredClone(draft.schedule)
      }
      if (editing) await window.browserApi.scheduler.update(editing.id, normalized)
      else await window.browserApi.scheduler.create(normalized)
      onChanged(await window.browserApi.scheduler.list())
      setEditing(undefined)
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally { setBusyId('') }
  }

  function updateScheduleTime(time: string): void {
    const schedule = draft.schedule
    if (schedule.kind === 'daily') setDraft({ ...draft, schedule: { kind: 'daily', time } })
    else if (schedule.kind === 'weekly') setDraft({ ...draft, schedule: { kind: 'weekly', time, weekdays: schedule.weekdays } })
  }

  function updateWeekdays(days: number[]): void {
    const schedule = draft.schedule
    if (schedule.kind === 'weekly') setDraft({ ...draft, schedule: { ...schedule, weekdays: days } })
  }

  const enabledCount = tasks.filter((task) => task.enabled).length

  return (
    <Modal open={open} width={920} title={<Space><ClockCircleOutlined />本地计划任务</Space>} footer={null} onCancel={onClose} className="scheduler-modal">
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type={proEnabled ? 'info' : 'warning'} showIcon icon={<SafetyCertificateOutlined />}
          title={proEnabled ? `${enabledCount} 个任务已启用，仅在本机执行` : '创建和执行计划任务需要 Prism Pro'}
          description="计划任务仅在 Prism 运行时执行；错过的任务会按照你设置的规则处理。"
        />
        <div className="scheduler-toolbar">
          <Typography.Text type="secondary">共 {tasks.length} 个任务</Typography.Text>
          <Button type="primary" icon={<PlusOutlined />} disabled={!proEnabled || !profiles.length} onClick={() => openEditor()}>新建任务</Button>
        </div>
        {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
        <div className="scheduler-list">
          {!tasks.length ? (
            <div className="scheduler-empty"><ClockCircleOutlined /><strong>暂无计划任务</strong><span>可以按一次、每天或每周自动启动和关闭环境。</span></div>
          ) : tasks.map((task) => (
            <div className={`scheduler-task ${task.enabled ? '' : 'disabled'}`} key={task.id}>
              <Switch
                size="small" checked={task.enabled} disabled={busyId === task.id || !proEnabled && !task.enabled}
                onChange={(enabled) => void operation(task.id, () => window.browserApi.scheduler.setEnabled(task.id, enabled))}
              />
              <div className="scheduler-task-main">
                <div className="scheduler-task-title">
                  <strong>{task.name}</strong>
                  <Tag color={task.action === 'launch' ? 'blue' : 'default'}>{task.action === 'launch' ? '启动' : '关闭'}</Tag>
                  {outcomeTag(task)}
                </div>
                <span>{profileNames.get(task.profileId) ?? `环境 ${task.profileId.slice(0, 8)}（已不存在）`}</span>
                <small>{scheduleText(task.schedule)} · {task.nextRunAt ? `下次 ${new Date(task.nextRunAt).toLocaleString()}` : '无下次执行'}</small>
                {task.lastMessage && <small className={task.lastOutcome === 'failure' ? 'task-error' : ''}>上次：{task.lastMessage}{task.lastAttempts ? `（${task.lastAttempts} 次尝试）` : ''}</small>}
              </div>
              <div className="scheduler-task-actions">
                <Button size="small" icon={<PlayCircleOutlined />} loading={busyId === `run-${task.id}`} disabled={!proEnabled} onClick={() => void operation(`run-${task.id}`, () => window.browserApi.scheduler.runNow(task.id))}>立即运行</Button>
                <Button size="small" icon={<EditOutlined />} disabled={!proEnabled || busyId === task.id} onClick={() => openEditor(task)} />
                <Popconfirm title="删除这个计划任务？" description="只删除任务，不会删除浏览器环境。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => operation(task.id, () => window.browserApi.scheduler.remove(task.id))}>
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={busyId === task.id} />
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      </Space>

      <Modal open={editing !== undefined} title={editing ? '编辑计划任务' : '新建计划任务'} okText="保存" cancelText="取消" confirmLoading={busyId === 'save'} onOk={() => void save()} onCancel={() => setEditing(undefined)} destroyOnHidden>
        <div className="scheduler-form">
          <label>任务名称<Input maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>浏览器环境<Select value={draft.profileId || undefined} options={profiles.map((profile) => ({ value: profile.id, label: `#${profile.serialNumber} · ${profile.name}` }))} onChange={(profileId) => setDraft({ ...draft, profileId })} /></label>
          <div className="scheduler-form-grid">
            <label>执行动作<Select value={draft.action} options={[{ value: 'launch', label: '启动环境' }, { value: 'close', label: '关闭环境' }]} onChange={(action) => setDraft({ ...draft, action })} /></label>
            <label>重复方式<Select value={draft.schedule.kind} options={[{ value: 'once', label: '仅一次' }, { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }]} onChange={(kind) => setDraft({ ...draft, schedule: kind === 'once' ? { kind, runAt: new Date(Date.now() + 10 * 60_000).toISOString() } : kind === 'daily' ? { kind, time: '09:00' } : { kind, time: '09:00', weekdays: [1, 2, 3, 4, 5] } })} /></label>
          </div>
          {draft.schedule.kind === 'once' ? (
            <label>执行时间<Input type="datetime-local" value={localDateTimeInput(new Date(draft.schedule.runAt))} onChange={(event) => setDraft({ ...draft, schedule: { kind: 'once', runAt: new Date(event.target.value).toISOString() } })} /></label>
          ) : (
            <label>本机时间<Input type="time" value={draft.schedule.time} onChange={(event) => updateScheduleTime(event.target.value)} /></label>
          )}
          {draft.schedule.kind === 'weekly' && <label>执行日期<Select mode="multiple" value={draft.schedule.weekdays} options={weekdays} onChange={updateWeekdays} /></label>}
          <div className="scheduler-form-grid">
            <label>错过任务<Select value={draft.missedPolicy} options={[{ value: 'run_once', label: '24 小时内补执行一次' }, { value: 'skip', label: '跳过本次' }]} onChange={(missedPolicy) => setDraft({ ...draft, missedPolicy })} /></label>
            <label>失败重试<Select value={draft.maxRetries} options={[0, 1, 2, 3].map((value) => ({ value, label: `${value} 次` }))} onChange={(maxRetries) => setDraft({ ...draft, maxRetries })} /></label>
          </div>
          {draft.maxRetries > 0 && <label>重试间隔（分钟）<Input type="number" min={1} max={60} value={draft.retryDelayMinutes} onChange={(event) => setDraft({ ...draft, retryDelayMinutes: Number(event.target.value) })} /></label>}
          <Checkbox checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}>保存后立即启用</Checkbox>
        </div>
      </Modal>
    </Modal>
  )
}
