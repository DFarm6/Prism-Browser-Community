import type { BrowserProfile, ProfileDraft } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'

const PROFILE_EXPORT_MARKER = 'prism-browser-profile'

interface ProfileExportFile {
  type: typeof PROFILE_EXPORT_MARKER
  schemaVersion: 1
  exportedAt: string
  containsBrowserData: false
  containsProxyPassword: false
  containsExtensions: false
  profile: ProfileDraft
}

export function serializeProfileConfig(profile: BrowserProfile): string {
  const data: ProfileExportFile = {
    type: PROFILE_EXPORT_MARKER,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    containsBrowserData: false,
    containsProxyPassword: false,
    containsExtensions: false,
    profile: {
      name: profile.name,
      note: profile.note,
      group: profile.group,
      tags: [...profile.tags],
      extensionIds: [],
      color: profile.color,
      startUrls: [...profile.startUrls],
      kernelVersion: profile.kernelVersion,
      window: { ...profile.window },
      proxy: { ...profile.proxy, password: '' },
      fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
    }
  }
  return JSON.stringify(data, null, 2)
}

export function parseProfileConfig(raw: string): ProfileDraft {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('环境配置文件不是有效的 JSON')
  }
  if (!value || typeof value !== 'object') throw new Error('环境配置文件格式无效')
  const data = value as Partial<ProfileExportFile>
  if (data.type !== PROFILE_EXPORT_MARKER || data.schemaVersion !== 1 || !data.profile) {
    throw new Error('不是受支持的 Prism Browser 环境配置文件')
  }
  const candidate = data.profile as ProfileDraft
  const draft = validateProfileDraft({
    ...candidate,
    group: typeof candidate.group === 'string' ? candidate.group : '',
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    extensionIds: Array.isArray(candidate.extensionIds) ? candidate.extensionIds : [],
    kernelVersion: typeof candidate.kernelVersion === 'string' ? candidate.kernelVersion : ''
  })
  return {
    ...draft,
    name: `${draft.name}（导入）`,
    proxy: { ...draft.proxy, password: '' }
  }
}

export function safeProfileFileName(name: string): string {
  const normalized = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\.+$/g, '')
  return `${normalized || 'browser-profile'}.prism-profile.json`
}
