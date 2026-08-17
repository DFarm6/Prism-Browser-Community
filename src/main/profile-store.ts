import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserProfile, DeletedProfileSummary, ProfileBatchClassification, ProfileDraft, ProfileStoreHealth, ProxyCheckSummary, WebRtcPolicy } from '../shared/types'
import { defaultProfileWindow, seedFromId } from '../shared/defaults'
import { refreshSeededGpuIdentity } from '../shared/hardware-profiles'
import { validateProfileDraft } from '../shared/validation'
import { identitySecretCodec, type SecretCodec } from './secret-codec'
import { privateProxyConfig, sameProxyIdentity } from './profile-secrets'
import { safePathSize } from './profile-data'

interface StoreFile {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11
  nextSerialNumber?: number
  profiles: BrowserProfile[]
}

interface LoadedStore {
  profiles: BrowserProfile[]
  nextSerialNumber: number
}

interface DeletedProfileRecord {
  schemaVersion: 1
  deletedAt: string
  profile: BrowserProfile
}

interface ProfileOwnerMarker {
  schemaVersion: 1
  profileId: string
}

const PROFILE_OWNER_FILE = 'profile-owner.json'
const MAX_PROFILE_SERIAL = 999_999_999

function validProfileSerial(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_PROFILE_SERIAL
}

function safeWebRtcPolicy(value: unknown): WebRtcPolicy {
  return value === 'proxy_only' || value === 'public_only' || value === 'default' ? value : 'proxy_only'
}

function safeProxyCheck(value: unknown): ProxyCheckSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const check = value as Partial<ProxyCheckSummary>
  if (typeof check.ok !== 'boolean' || typeof check.latencyMs !== 'number' || typeof check.checkedAt !== 'string') return undefined
  if (Number.isNaN(Date.parse(check.checkedAt))) return undefined
  const risk = check.networkRisk === 'tor' || check.networkRisk === 'vpn' || check.networkRisk === 'proxy' || check.networkRisk === 'hosting'
    ? check.networkRisk
    : undefined
  return {
    ok: check.ok,
    ip: typeof check.ip === 'string' ? check.ip : undefined,
    latencyMs: Math.max(0, Math.round(check.latencyMs)),
    error: typeof check.error === 'string' ? check.error.slice(0, 500) : undefined,
    warning: typeof check.warning === 'string' ? check.warning.slice(0, 500) : undefined,
    degraded: check.degraded === true,
    country: typeof check.country === 'string' ? check.country : undefined,
    countryCode: typeof check.countryCode === 'string' ? check.countryCode : undefined,
    latitude: typeof check.latitude === 'number' && check.latitude >= -90 && check.latitude <= 90 ? check.latitude : undefined,
    longitude: typeof check.longitude === 'number' && check.longitude >= -180 && check.longitude <= 180 ? check.longitude : undefined,
    accuracyMeters: typeof check.accuracyMeters === 'number' && check.accuracyMeters > 0 ? check.accuracyMeters : undefined,
    ipVersion: check.ipVersion === 4 || check.ipVersion === 6 ? check.ipVersion : undefined,
    region: typeof check.region === 'string' ? check.region : undefined,
    city: typeof check.city === 'string' ? check.city : undefined,
    timezone: typeof check.timezone === 'string' ? check.timezone : undefined,
    asn: typeof check.asn === 'number' ? check.asn : undefined,
    organization: typeof check.organization === 'string' ? check.organization : undefined,
    isp: typeof check.isp === 'string' ? check.isp : undefined,
    networkRisk: risk,
    geoConfidence: check.geoConfidence === 'consensus' || check.geoConfidence === 'single-source' || check.geoConfidence === 'conflict'
      ? check.geoConfidence
      : undefined,
    geoSources: Array.isArray(check.geoSources)
      ? check.geoSources.filter((source): source is string => typeof source === 'string').slice(0, 5)
      : undefined,
    geoConflict: typeof check.geoConflict === 'string' ? check.geoConflict.slice(0, 500) : undefined,
    failureKind: ['authentication', 'timeout', 'connection', 'unknown'].includes(check.failureKind ?? '') ? check.failureKind : undefined,
    retried: check.retried === true,
    exitChanged: check.exitChanged === true,
    previousIp: typeof check.previousIp === 'string' ? check.previousIp : undefined,
    checkedAt: check.checkedAt
  }
}

export class ProfileStore {
  readonly vaultPath: string
  readonly profilesPath: string
  readonly backupPath: string
  readonly previousBackupPath: string
  private profiles = new Map<string, BrowserProfile>()
  private nextSerialNumber = 1
  private writeQueue: Promise<void> = Promise.resolve()
  private health: ProfileStoreHealth = { recoveredFromBackup: false, backupHealthy: true }
  private preservePreviousBackupOnce = false

  constructor(vaultPath: string, private readonly secrets: SecretCodec = identitySecretCodec) {
    this.vaultPath = vaultPath
    this.profilesPath = join(vaultPath, 'profiles.json')
    this.backupPath = join(vaultPath, 'profiles.json.backup')
    this.previousBackupPath = join(vaultPath, 'profiles.json.backup.previous')
  }

  async initialize(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true })
    let loaded: LoadedStore | undefined
    let primaryError: unknown
    try {
      loaded = await this.readStore(this.profilesPath)
    } catch (error) {
      primaryError = error
    }

    if (!loaded) {
      const recoveryErrors: unknown[] = []
      let recoveredPath: string | undefined
      for (const candidate of [this.backupPath, this.previousBackupPath]) {
        try {
          loaded = await this.readStore(candidate)
          recoveredPath = candidate
          break
        } catch (error) {
          recoveryErrors.push(error)
        }
      }
      const firstRun = (primaryError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        && recoveryErrors.length === 2
        && recoveryErrors.every((error) => (error as NodeJS.ErrnoException).code === 'ENOENT')
      if (!loaded && !firstRun) {
        throw new Error(`环境元数据及备份均无法读取：${primaryError instanceof Error ? primaryError.message : String(primaryError)}`)
      }
      if (loaded && recoveredPath) {
        this.preservePreviousBackupOnce = true
        let corruptFilePath: string | undefined
        if ((primaryError as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          corruptFilePath = join(this.vaultPath, `profiles.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          await rename(this.profilesPath, corruptFilePath)
        }
        this.health = {
          recoveredFromBackup: true,
          recoveryMessage: `主环境配置不可用，已从${recoveredPath === this.backupPath ? '最近备份' : '上一份备份'}恢复`,
          corruptFilePath,
          backupHealthy: true
        }
      }
    }

    this.profiles.clear()
    this.nextSerialNumber = loaded?.nextSerialNumber ?? 1
    for (const profile of loaded?.profiles ?? []) {
      this.profiles.set(profile.id, profile)
      await this.ensureProfileDirectories(profile.id)
    }
    await this.persist()
  }

  storageHealth(): ProfileStoreHealth {
    return { ...this.health }
  }

  private async readStore(path: string): Promise<LoadedStore> {
    const raw = await readFile(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('环境元数据不是有效 JSON')
    }
    if (!value || typeof value !== 'object') throw new Error('环境元数据结构无效')
    const data = value as Partial<StoreFile>
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(Number(data.schemaVersion)) || !Array.isArray(data.profiles)) {
      throw new Error('环境元数据版本或列表结构无效')
    }
    const result: BrowserProfile[] = []
    const ids = new Set<string>()
    for (const value of data.profiles) {
      const stored = value as Partial<BrowserProfile>
      if (typeof stored.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(stored.id) || ids.has(stored.id)) {
        throw new Error('环境元数据包含无效或重复 ID')
      }
      if (!stored.proxy || !stored.fingerprint || !Array.isArray(stored.startUrls)) {
        throw new Error(`环境 ${stored.id} 的配置不完整`)
      }
      if (typeof stored.proxy.password !== 'string' || typeof stored.createdAt !== 'string' || typeof stored.updatedAt !== 'string') {
        throw new Error(`环境 ${stored.id} 的持久化字段无效`)
      }
      const draft = validateProfileDraft({
        name: stored.name as string,
        note: stored.note as string,
        group: typeof stored.group === 'string' ? stored.group : '',
        tags: Array.isArray(stored.tags) ? stored.tags.filter((tag) => typeof tag === 'string') : [],
        extensionIds: Array.isArray(stored.extensionIds) ? stored.extensionIds.filter((id) => typeof id === 'string') : [],
        color: stored.color as string,
        startUrls: stored.startUrls,
        kernelVersion: typeof stored.kernelVersion === 'string' ? stored.kernelVersion : '',
        window: stored.window ?? defaultProfileWindow(),
        proxy: { ...stored.proxy, password: this.secrets.decode(stored.proxy.password) },
        fingerprint: {
          ...stored.fingerprint,
          hardwareProfileId: stored.fingerprint.hardwareProfileId ?? 'legacy-custom',
          webrtcPolicy: safeWebRtcPolicy(stored.fingerprint.webrtcPolicy),
          networkIdentityMode: stored.fingerprint.networkIdentityMode ?? 'manual',
          proxyExitPolicy: stored.fingerprint.proxyExitPolicy ?? 'warn',
          disabledSpoofing: Array.isArray(stored.fingerprint.disabledSpoofing) ? stored.fingerprint.disabledSpoofing : []
        }
      })
      ids.add(stored.id)
      result.push({
        ...stored,
        ...draft,
        proxy: privateProxyConfig(draft.proxy),
        id: stored.id,
        serialNumber: validProfileSerial(stored.serialNumber) ? stored.serialNumber : 0,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        lastOpenedAt: typeof stored.lastOpenedAt === 'string' ? stored.lastOpenedAt : undefined,
        proxyCheck: safeProxyCheck(stored.proxyCheck),
        favorite: stored.favorite === true,
        status: 'closed',
        lastError: undefined
      })
    }
    const usedSerials = new Set<number>()
    const ordered = [...result].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    for (const profile of ordered) {
      if (validProfileSerial(profile.serialNumber) && !usedSerials.has(profile.serialNumber)) {
        usedSerials.add(profile.serialNumber)
      } else {
        profile.serialNumber = 0
      }
    }
    let migrationSerial = 1
    for (const profile of ordered) {
      if (validProfileSerial(profile.serialNumber)) continue
      while (usedSerials.has(migrationSerial)) migrationSerial += 1
      if (migrationSerial > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
      profile.serialNumber = migrationSerial
      usedSerials.add(migrationSerial)
    }
    let highestSerial = 0
    for (const serial of usedSerials) highestSerial = Math.max(highestSerial, serial)
    const storedNext = validProfileSerial(data.nextSerialNumber) ? data.nextSerialNumber : 1
    const nextSerialNumber = Math.max(storedNext, highestSerial + 1)
    if (nextSerialNumber > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
    return { profiles: result, nextSerialNumber }
  }

  list(): BrowserProfile[] {
    return [...this.profiles.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): BrowserProfile {
    const profile = this.profiles.get(id)
    if (!profile) throw new Error('浏览器环境不存在')
    return profile
  }

  async create(input: ProfileDraft): Promise<BrowserProfile> {
    return (await this.createMany([input]))[0]
  }

  async createMany(inputs: ProfileDraft[]): Promise<BrowserProfile[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('没有可创建的浏览器环境')
    if (inputs.length > 500) throw new Error('单次最多创建 500 个浏览器环境')
    const drafts = inputs.map(validateProfileDraft)
    if (this.nextSerialNumber + drafts.length - 1 > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
    const firstSerialNumber = this.nextSerialNumber
    this.nextSerialNumber += drafts.length
    const now = new Date().toISOString()
    const created = drafts.map((draft, index) => {
      const id = randomUUID()
      return {
        ...draft,
        id,
        serialNumber: firstSerialNumber + index,
        proxy: privateProxyConfig(draft.proxy),
        fingerprint: {
          ...draft.fingerprint,
          seed: Number.isInteger(draft.fingerprint.seed) ? draft.fingerprint.seed : seedFromId(id)
        },
        createdAt: now,
        updatedAt: now,
        favorite: false,
        status: 'closed' as const
      }
    })

    try {
      await Promise.all(created.map((profile) => this.ensureProfileDirectories(profile.id)))
      for (const profile of created) this.profiles.set(profile.id, profile)
      await this.persist()
      return created
    } catch (error) {
      for (const profile of created) this.profiles.delete(profile.id)
      await Promise.allSettled(created.map((profile) => rm(join(this.vaultPath, 'profiles', profile.id), { recursive: true, force: true })))
      throw error
    }
  }

  async update(id: string, input: ProfileDraft): Promise<BrowserProfile> {
    const current = this.get(id)
    if (current.status !== 'closed' && current.status !== 'error') {
      throw new Error('请先关闭浏览器环境再修改配置')
    }
    const draft = validateProfileDraft(input)
    const keepStoredPassword = draft.proxy.protocol !== 'direct'
      && !draft.proxy.password
      && draft.proxy.passwordStored
      && sameProxyIdentity(draft.proxy, current.proxy)
    const profile: BrowserProfile = {
      ...current,
      ...draft,
      proxy: privateProxyConfig({
        ...draft.proxy,
        password: draft.proxy.protocol === 'direct' ? '' : keepStoredPassword ? current.proxy.password : draft.proxy.password
      }),
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      status: current.status
    }
    if (!sameProxyIdentity(profile.proxy, current.proxy) || profile.proxy.password !== current.proxy.password) {
      delete profile.proxyCheck
    }
    this.profiles.set(id, profile)
    await this.persist()
    return profile
  }

  async duplicate(id: string): Promise<BrowserProfile> {
    const source = this.get(id)
    const seed = seedFromId(randomUUID())
    return this.create({
      name: `${source.name} 副本`,
      note: source.note,
      group: source.group,
      tags: [...source.tags],
      extensionIds: [...source.extensionIds],
      color: source.color,
      startUrls: [...source.startUrls],
      kernelVersion: source.kernelVersion,
      window: { ...source.window },
      proxy: { ...source.proxy },
      fingerprint: refreshSeededGpuIdentity({ ...source.fingerprint, seed })
    })
  }

  async classifyMany(idsInput: string[], patch: ProfileBatchClassification): Promise<BrowserProfile[]> {
    if (!Array.isArray(idsInput) || !patch || typeof patch !== 'object') throw new Error('批量修改参数无效')
    const ids = [...new Set(idsInput)]
    if (!ids.length) throw new Error('没有选择浏览器环境')
    if (ids.length > 500) throw new Error('单次最多修改 500 个浏览器环境')
    if (patch.group === undefined && !patch.addTags?.length) throw new Error('请填写分组或要追加的标签')
    if (patch.group !== undefined && typeof patch.group !== 'string') throw new Error('环境分组格式无效')
    if (patch.addTags !== undefined && (!Array.isArray(patch.addTags) || !patch.addTags.every((tag) => typeof tag === 'string'))) {
      throw new Error('环境标签格式无效')
    }
    const now = new Date().toISOString()
    const nextProfiles = ids.map((id) => {
      const current = this.get(id)
      const validated = validateProfileDraft({
        name: current.name,
        note: current.note,
        group: patch.group === undefined ? current.group : patch.group,
        tags: [...current.tags, ...(patch.addTags ?? [])],
        extensionIds: current.extensionIds,
        color: current.color,
        startUrls: current.startUrls,
        kernelVersion: current.kernelVersion,
        window: current.window,
        proxy: current.proxy,
        fingerprint: current.fingerprint
      })
      return { ...current, ...validated, proxy: current.proxy, updatedAt: now }
    })
    for (const profile of nextProfiles) this.profiles.set(profile.id, profile)
    await this.persist()
    return nextProfiles
  }

  async removeMany(idsInput: string[]): Promise<void> {
    if (!Array.isArray(idsInput)) throw new Error('批量删除参数无效')
    const ids = [...new Set(idsInput)]
    if (!ids.length) throw new Error('没有选择浏览器环境')
    if (ids.length > 500) throw new Error('单次最多删除 500 个浏览器环境')
    for (const id of ids) {
      const profile = this.get(id)
      if (profile.status !== 'closed' && profile.status !== 'error') throw new Error(`环境“${profile.name}”正在运行，不能删除`)
    }
    for (const id of ids) await this.remove(id)
  }

  async remove(id: string): Promise<void> {
    const profile = this.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('运行中的环境不能删除')
    await this.assertProfileDataIdentity(id)
    const source = join(this.vaultPath, 'profiles', id)
    const recycle = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(recycle, { recursive: true })
    const deletedAt = new Date().toISOString()
    const record: DeletedProfileRecord = {
      schemaVersion: 1,
      deletedAt,
      profile: {
        ...profile,
        status: 'closed',
        lastError: undefined,
        proxy: { ...profile.proxy, password: this.secrets.encode(profile.proxy.password) }
      }
    }
    const marker = join(source, 'deleted-profile.json')
    await writeFile(marker, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    const trashId = `${id}-${Date.now()}`
    try {
      await rename(source, join(recycle, trashId))
    } catch (error) {
      await rm(marker, { force: true })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.profiles.delete(id)
    await this.persist()
  }

  async listTrash(): Promise<DeletedProfileSummary[]> {
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    const result: DeletedProfileSummary[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.schemaVersion !== 1 || !record.profile?.id || !record.profile.name) continue
        result.push({
          trashId: entry.name,
          profileId: record.profile.id,
          serialNumber: validProfileSerial(record.profile.serialNumber) ? record.profile.serialNumber : undefined,
          name: record.profile.name,
          deletedAt: record.deletedAt,
          sizeBytes: await safePathSize(join(root, entry.name))
        })
      } catch {
        // Old or incomplete recycle entries remain recoverable on disk but are not shown as restorable profiles.
      }
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  async usesExtension(id: string): Promise<boolean> {
    if (this.list().some((profile) => profile.extensionIds.includes(id))) return true
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.profile?.extensionIds?.includes(id)) return true
      } catch {
        // Ignore legacy recycle entries without restorable metadata.
      }
    }
    return false
  }

  async kernelUsers(version: string): Promise<string[]> {
    const names = this.list().filter((profile) => profile.kernelVersion === version).map((profile) => profile.name)
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.profile?.kernelVersion === version && typeof record.profile.name === 'string') names.push(record.profile.name)
      } catch {
        // Ignore legacy recycle entries without restorable metadata.
      }
    }
    return names
  }

  async purgeTrash(trashId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(trashId)) throw new Error('回收站条目标识无效')
    const target = join(this.vaultPath, 'recycle-bin', 'profiles', trashId)
    let record: DeletedProfileRecord
    try {
      record = JSON.parse(await readFile(join(target, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
    } catch {
      throw new Error('回收站条目不完整，已取消永久删除')
    }
    if (record.schemaVersion !== 1 || !record.profile?.id) throw new Error('回收站条目元数据无效，已取消永久删除')
    await rm(target, { recursive: true, force: true })
  }

  async emptyTrash(): Promise<number> {
    const items = await this.listTrash()
    for (const item of items) await this.purgeTrash(item.trashId)
    return items.length
  }

  async purgeTrashOlderThan(days: number): Promise<number> {
    if (days === 0) return 0
    if (days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    const expired: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.schemaVersion === 1 && record.profile?.id && Date.parse(record.deletedAt) < cutoff) expired.push(entry.name)
      } catch {
        // Incomplete entries are deliberately preserved for manual inspection.
      }
    }
    for (const trashId of expired) await this.purgeTrash(trashId)
    return expired.length
  }

  async restore(trashId: string): Promise<BrowserProfile> {
    if (!/^[a-zA-Z0-9-]+$/.test(trashId)) throw new Error('回收站条目标识无效')
    const source = join(this.vaultPath, 'recycle-bin', 'profiles', trashId)
    let record: DeletedProfileRecord
    try {
      record = JSON.parse(await readFile(join(source, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
    } catch {
      throw new Error('回收站中的环境数据不完整')
    }
    if (record.schemaVersion !== 1 || !record.profile?.id) throw new Error('回收站中的环境元数据无效')
    if (this.profiles.has(record.profile.id)) throw new Error('相同 ID 的环境已经存在，无法恢复')
    const profile: BrowserProfile = {
      ...record.profile,
      serialNumber: validProfileSerial(record.profile.serialNumber)
        && !this.list().some((item) => item.serialNumber === record.profile.serialNumber)
        ? record.profile.serialNumber
        : this.nextSerialNumber++,
      kernelVersion: typeof record.profile.kernelVersion === 'string' ? record.profile.kernelVersion : '',
      group: typeof record.profile.group === 'string' ? record.profile.group : '',
      tags: Array.isArray(record.profile.tags) ? record.profile.tags : [],
      extensionIds: Array.isArray(record.profile.extensionIds) ? record.profile.extensionIds : [],
      fingerprint: {
        ...record.profile.fingerprint,
        webrtcPolicy: safeWebRtcPolicy(record.profile.fingerprint?.webrtcPolicy)
      },
      window: record.profile.window ?? defaultProfileWindow(),
      favorite: record.profile.favorite === true,
      proxy: privateProxyConfig({ ...record.profile.proxy, password: this.secrets.decode(record.profile.proxy.password) }),
      status: 'closed',
      lastError: undefined,
      updatedAt: new Date().toISOString()
    }
    if (profile.serialNumber >= this.nextSerialNumber) this.nextSerialNumber = profile.serialNumber + 1
    if (this.nextSerialNumber > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
    const target = join(this.vaultPath, 'profiles', profile.id)
    await rename(source, target)
    try {
      await this.ensureProfileDirectories(profile.id)
      await rm(join(target, 'deleted-profile.json'), { force: true })
      this.profiles.set(profile.id, profile)
      await this.persist()
      return profile
    } catch (error) {
      this.profiles.delete(profile.id)
      await rename(target, source).catch(() => undefined)
      throw error
    }
  }

  async setRuntime(
    id: string,
    patch: Pick<BrowserProfile, 'status'> & Partial<Pick<BrowserProfile, 'lastError' | 'lastOpenedAt'>>
  ): Promise<BrowserProfile> {
    const current = this.get(id)
    const profile = {
      ...current,
      ...patch,
      updatedAt: current.updatedAt
    }
    if (patch.lastError === undefined) delete profile.lastError
    this.profiles.set(id, profile)
    if (patch.lastOpenedAt || patch.status === 'closed' || patch.status === 'error') await this.persist()
    return profile
  }

  async setProxyCheck(id: string, check: ProxyCheckSummary, baselineIp?: string): Promise<BrowserProfile> {
    const current = this.get(id)
    const nextCheck = safeProxyCheck(check)
    if (!nextCheck) throw new Error('代理检测结果无效')
    const previousIp = baselineIp ?? (current.proxyCheck?.ok ? current.proxyCheck.ip : undefined)
    if (previousIp && nextCheck.ok && nextCheck.ip && previousIp !== nextCheck.ip) {
      nextCheck.exitChanged = true
      nextCheck.previousIp = previousIp
    } else {
      nextCheck.exitChanged = false
      nextCheck.previousIp = undefined
    }
    const profile: BrowserProfile = { ...current, proxyCheck: nextCheck }
    this.profiles.set(id, profile)
    await this.persist()
    return profile
  }

  async setFavorite(id: string, favorite: boolean): Promise<BrowserProfile> {
    if (typeof favorite !== 'boolean') throw new Error('收藏状态无效')
    const current = this.get(id)
    const profile: BrowserProfile = { ...current, favorite, updatedAt: new Date().toISOString() }
    this.profiles.set(id, profile)
    await this.persist()
    return profile
  }

  profileDataPath(id: string): string {
    return join(this.vaultPath, 'profiles', id, 'user-data')
  }

  profileRuntimePath(id: string): string {
    return join(this.vaultPath, 'profiles', id, 'runtime')
  }

  profileOwnerPath(id: string): string {
    return join(this.vaultPath, 'profiles', id, PROFILE_OWNER_FILE)
  }

  async assertProfileDataIdentity(id: string): Promise<void> {
    this.get(id)
    await this.verifyProfileDataIdentity(id)
  }

  private async verifyProfileDataIdentity(id: string): Promise<void> {
    const root = join(this.vaultPath, 'profiles', id)
    const [rootInfo, markerInfo, dataInfo, runtimeInfo] = await Promise.all([
      lstat(root),
      lstat(this.profileOwnerPath(id)),
      lstat(this.profileDataPath(id)),
      lstat(this.profileRuntimePath(id))
    ]).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('环境数据目录不完整，为保护数据已取消操作')
      }
      throw error
    })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !markerInfo.isFile() || markerInfo.isSymbolicLink()
      || !dataInfo.isDirectory() || dataInfo.isSymbolicLink()
      || !runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      throw new Error('环境数据目录结构异常或包含符号链接，为保护数据已取消操作')
    }
    let marker: ProfileOwnerMarker
    try {
      marker = JSON.parse(await readFile(this.profileOwnerPath(id), 'utf8')) as ProfileOwnerMarker
    } catch {
      throw new Error('环境数据身份标记损坏，为保护数据已取消操作')
    }
    if (marker.schemaVersion !== 1 || marker.profileId !== id) {
      throw new Error('环境数据目录与环境 ID 不匹配，为保护数据已取消操作')
    }
  }

  private async ensureProfileDirectories(id: string): Promise<void> {
    const root = join(this.vaultPath, 'profiles', id)
    await mkdir(root, { recursive: true })
    try {
      await writeFile(this.profileOwnerPath(id), JSON.stringify({
        schemaVersion: 1,
        profileId: id
      } satisfies ProfileOwnerMarker, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await mkdir(this.profileDataPath(id), { recursive: true })
    await mkdir(this.profileRuntimePath(id), { recursive: true })
    await this.verifyProfileDataIdentity(id)
  }

  private persist(): Promise<void> {
    const data: StoreFile = {
      schemaVersion: 11,
      nextSerialNumber: this.nextSerialNumber,
      profiles: this.list().map((profile) => ({
        ...profile,
        proxy: { ...profile.proxy, password: this.secrets.encode(profile.proxy.password) }
      }))
    }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.profilesPath), { recursive: true })
      const temporary = `${this.profilesPath}.tmp`
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.profilesPath)
      const backupTemporary = `${this.backupPath}.tmp`
      try {
        if (!this.preservePreviousBackupOnce) {
          try {
            await copyFile(this.backupPath, this.previousBackupPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        await copyFile(this.profilesPath, backupTemporary)
        await rm(this.backupPath, { force: true })
        await rename(backupTemporary, this.backupPath)
        this.preservePreviousBackupOnce = false
        this.health = { ...this.health, backupHealthy: true, backupError: undefined }
      } catch (error) {
        await rm(backupTemporary, { force: true }).catch(() => undefined)
        this.health = {
          ...this.health,
          backupHealthy: false,
          backupError: error instanceof Error ? error.message : String(error)
        }
      }
    })
    this.writeQueue = operation
    return operation
  }
}
