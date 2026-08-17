import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { ProfileDraft } from '../shared/types'
import type { KernelManager } from './kernel-manager'
import { listBundledBrowsers, locateBrowser, locateBundledBrowser, normalizeBrowserSelection } from './browser-locator'
import { mergeKernelCatalog } from './kernel-catalog'
import type { BrowserLauncher } from './browser-launcher'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { testProxy } from './proxy-tester'
import { validateProxyConfig } from '../shared/validation'
import type { AppLogger } from './app-logger'
import { parseProfileConfig, safeProfileFileName, serializeProfileConfig } from './profile-transfer'
import { clearProfileCache, profileStorageInfo, storageOverview } from './profile-data'
import type { ExtensionStore } from './extension-store'
import type { CookieManager } from './cookie-manager'
import { parseCookieFile, serializeCookieFile } from './cookie-file'
import { parseBatchProfileCsv, serializeBatchProfileTemplate } from './profile-batch-csv'
import { proxyForTest, publicProfile, sameProxyIdentity } from './profile-secrets'
import type { ProfileBackupManager } from './profile-backup'
import type { AppSessionTracker } from './app-session'
import type { UpdateManager } from './update-manager'
import type { LicenseManager } from './license-manager'
import type { WorkspaceMigrationManager } from './workspace-migration'
import type { ProAgentManager } from './pro-agent-manager'
import type { SchedulerManager } from './scheduler-manager'
import type { McpControlManager } from './mcp-control-manager'
import type { AnnouncementManager } from './announcement-manager'

export const PRO_PURCHASE_URL = 'https://pay.ldxp.cn/item/q23itv'

interface IpcDependencies {
  profiles: ProfileStore
  settings: SettingsStore
  launcher: BrowserLauncher
  kernels: KernelManager
  extensions: ExtensionStore
  cookies: CookieManager
  logger: AppLogger
  backups: ProfileBackupManager
  workspaceMigration: WorkspaceMigrationManager
  appSession: AppSessionTracker
  updater: UpdateManager
  licensing: LicenseManager
  automation: ProAgentManager
  scheduler: SchedulerManager
  mcp: McpControlManager
  announcements: AnnouncementManager
}

export function registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, updater, licensing, automation, scheduler, mcp, announcements }: IpcDependencies): void {
  ipcMain.handle('profiles:list', () => profiles.list().map(publicProfile))
  ipcMain.handle('profiles:storage-health', () => profiles.storageHealth())
  ipcMain.handle('profiles:create', async (_event, draft: ProfileDraft) => publicProfile(await profiles.create(draft)))
  ipcMain.handle('profiles:update', async (_event, id: string, draft: ProfileDraft) => publicProfile(await profiles.update(id, draft)))
  ipcMain.handle('profiles:duplicate', async (_event, id: string) => publicProfile(await profiles.duplicate(id)))
  ipcMain.handle('profiles:export-config', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭环境再导出配置')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '导出环境配置',
      defaultPath: safeProfileFileName(profile.name),
      filters: [{ name: 'Prism Browser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeProfileConfig(profile), { encoding: 'utf8', mode: 0o600 })
    logger.info('环境配置已导出', { profileId: id })
    return result.filePath
  })
  ipcMain.handle('profiles:import-config', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境配置',
      properties: ['openFile'],
      filters: [{ name: 'Prism Browser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 1024 * 1024) throw new Error('环境配置文件不能超过 1 MB')
    const profile = await profiles.create(parseProfileConfig(await readFile(path, 'utf8')))
    logger.info('环境配置已导入', { profileId: profile.id })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:import-batch-csv', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '批量导入浏览器环境',
      properties: ['openFile'],
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('批量导入 CSV 不能超过 2 MB')
    const drafts = parseBatchProfileCsv(await readFile(path, 'utf8'), profiles.list().length + 1)
    const created = await profiles.createMany(drafts)
    logger.info('已通过 CSV 批量导入浏览器环境', { count: created.length })
    return created.map(publicProfile)
  })
  ipcMain.handle('profiles:export-batch-template', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存批量导入 CSV 模板',
      defaultPath: 'prism-browser-batch-template.csv',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeBatchProfileTemplate(), { encoding: 'utf8', mode: 0o600 })
    return result.filePath
  })
  ipcMain.handle('profiles:storage-info', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    return profileStorageInfo(profiles.profileDataPath(id))
  })
  ipcMain.handle('profiles:storage-overview', () => storageOverview(profiles.vaultPath))
  ipcMain.handle('profiles:open-data-folder', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    const error = await shell.openPath(profiles.profileDataPath(id))
    if (error) throw new Error(`无法打开环境数据目录：${error}`)
  })
  ipcMain.handle('profiles:clear-cache', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) {
      throw new Error('请先关闭浏览器环境再清理缓存')
    }
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.assertProfileDataIdentity(id)
    const result = await clearProfileCache(profiles.profileDataPath(id))
    logger.info('浏览器环境缓存已清理', { profileId: id })
    return result
  })
  ipcMain.handle('profiles:export-backup', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) throw new Error('请先关闭环境再备份完整数据')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    const processCheck = (await launcher.diagnose(id)).checks.find((check) => check.key === 'process')
    if (processCheck?.status === 'error') throw new Error(`无法安全备份：${processCheck.message}`)
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择环境数据备份保存位置', properties: ['openDirectory', 'createDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return backups.export(id, result.filePaths[0])
  })
  ipcMain.handle('profiles:import-backup', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择 Prism 环境数据备份目录', properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const imported = await backups.import(result.filePaths[0])
    return { profile: publicProfile(imported.profile), result: imported.result }
  })
  ipcMain.handle('profiles:export-workspace', async (_event, password: string) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导出迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: '导出全部环境加密迁移包',
      defaultPath: `Prism 全部环境 ${stamp}.prism-migration`,
      filters: [{ name: 'Prism 加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return workspaceMigration.exportAll(result.filePath, password)
  })
  ipcMain.handle('profiles:import-workspace', async (_event, password: string, conflictPolicy: 'rename' | 'skip') => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入全部环境加密迁移包',
      properties: ['openFile'],
      filters: [{ name: 'Prism 加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return workspaceMigration.importAll(result.filePaths[0], password, conflictPolicy)
  })
  ipcMain.handle('profiles:trash', () => profiles.listTrash())
  ipcMain.handle('profiles:restore', async (_event, trashId: string) => {
    const profile = await profiles.restore(trashId)
    logger.info('浏览器环境已从回收站恢复', { profileId: profile.id })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:purge-trash', async (_event, trashId: string) => {
    await profiles.purgeTrash(trashId)
    logger.info('回收站环境已永久删除', { trashId })
  })
  ipcMain.handle('profiles:empty-trash', async () => {
    const count = await profiles.emptyTrash()
    logger.info('环境回收站已清空', { count })
    return count
  })
  ipcMain.handle('profiles:recycle-retention', () => settings.get().recycleRetentionDays)
  ipcMain.handle('profiles:set-recycle-retention', async (_event, days: number) => {
    if (days !== 0 && days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    await settings.update({ recycleRetentionDays: days })
    logger.info('环境回收站自动清理策略已更新', { days })
    return days
  })
  ipcMain.handle('profiles:export-cookies', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导出 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const defaultPath = safeProfileFileName(profile.name).replace(/\.prism-profile\.json$/, '.cookies.json')
    const options: Electron.SaveDialogOptions = {
      title: '导出环境 Cookie',
      defaultPath,
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const exported = await cookies.exportCookies(id)
    await writeFile(result.filePath, serializeCookieFile(profile.name, exported), { encoding: 'utf8', mode: 0o600 })
    return { count: exported.length, filePath: result.filePath }
  })
  ipcMain.handle('profiles:import-cookies', async (_event, id: string) => {
    profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导入 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境 Cookie',
      properties: ['openFile'],
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Cookie 文件不能超过 10 MB')
    const imported = parseCookieFile(await readFile(path, 'utf8'))
    const count = await cookies.importCookies(id, imported)
    return { count, filePath: path }
  })
  ipcMain.handle('profiles:remove', async (_event, id: string) => {
    if (launcher.isRunning(id)) throw new Error('请先关闭运行中的环境')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    if (scheduler.profileTasks(id).length) throw new Error('该环境仍被计划任务引用，请先删除对应计划任务')
    await profiles.remove(id)
    await mcp.removeProfile(id)
  })
  ipcMain.handle('profiles:launch', (_event, id: string, options?: { allowGeoConflict?: unknown }) => {
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    return launcher.launch(id, { allowGeoConflict: options?.allowGeoConflict === true }).then(publicProfile)
  })
  ipcMain.handle('profiles:close', (_event, id: string) => launcher.close(id).then(publicProfile))
  ipcMain.handle('profiles:close-all', () => launcher.closeAll())
  ipcMain.handle('profiles:test-proxy', async (_event, id: string) => {
    const testedProfile = profiles.get(id)
    const result = await testProxy(testedProfile.proxy)
    const current = profiles.get(id)
    if (!sameProxyIdentity(testedProfile.proxy, current.proxy) || testedProfile.proxy.password !== current.proxy.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    const profile = await profiles.setProxyCheck(id, { ...result, checkedAt: new Date().toISOString() })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:diagnose', (_event, id: string) => launcher.diagnose(id))
  ipcMain.handle('profiles:crash-history', (_event, id: string) => launcher.crashHistory(id))
  ipcMain.handle('profiles:set-favorite', async (_event, id: string, favorite: boolean) => publicProfile(await profiles.setFavorite(id, favorite)))
  ipcMain.handle('profiles:classify-many', async (_event, ids: string[], patch) => {
    return (await profiles.classifyMany(ids, patch)).map(publicProfile)
  })
  ipcMain.handle('profiles:remove-many', async (_event, ids: string[]) => {
    for (const id of ids) {
      if (launcher.isRunning(id)) throw new Error(`环境“${profiles.get(id).name}”正在运行，不能删除`)
      if (cookies.isBusy(id)) throw new Error(`环境“${profiles.get(id).name}”正在执行 Cookie 操作`)
      if (scheduler.profileTasks(id).length) throw new Error(`环境“${profiles.get(id).name}”仍被计划任务引用，请先删除对应计划任务`)
    }
    await profiles.removeMany(ids)
    await Promise.all(ids.map((id) => mcp.removeProfile(id)))
  })

  ipcMain.handle('engine:status', () => locateBrowser(settings))
  ipcMain.handle('engine:bundled', () => locateBundledBrowser())
  ipcMain.handle('engine:activate-bundled', async () => {
    const bundled = await locateBundledBrowser()
    if (!bundled?.executable) throw new Error('当前安装包没有可用的内置指纹内核')
    return kernels.configure(
      { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:select', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择 Fingerprint Chromium 内核',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '浏览器', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    const executable = await normalizeBrowserSelection(result.filePaths[0])
    return kernels.configure({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
  })
  ipcMain.handle('engine:import-local', async () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入并切换内核')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入本地 Fingerprint Chromium 构建',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Chromium', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    return kernels.importLocal(result.filePaths[0])
  })
  ipcMain.handle('engine:use-system', async () => {
    return kernels.configure({ browserExecutable: '', fingerprintKernel: false, enginePreference: 'system' })
  })
  ipcMain.handle('engine:installed', async () => {
    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    return mergeKernelCatalog(managed, bundled)
  })
  ipcMain.handle('engine:activate', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (!bundled?.executable) return kernels.activate(version)
    const primary = await locateBundledBrowser()
    return kernels.configure(
      primary?.version === version
        ? { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' }
        : { browserExecutable: bundled.executable, fingerprintKernel: true, enginePreference: 'auto' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:rollback-available', () => kernels.rollbackAvailable())
  ipcMain.handle('engine:rollback', () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再回滚内核')
    return kernels.rollback()
  })
  ipcMain.handle('engine:remove', (_event, version: string) => kernels.remove(version))
  ipcMain.handle('engine:verify', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (bundled?.executable) {
      return {
        version,
        status: 'healthy',
        message: '随 Prism Browser 发布的内核完整性正常',
        checkedAt: new Date().toISOString()
      }
    }
    return kernels.verify(version)
  })
  ipcMain.handle('updates:status', () => updater.status())
  ipcMain.handle('updates:check', () => updater.check())
  ipcMain.handle('updates:download', () => updater.download())
  ipcMain.handle('updates:open-installer', async () => {
    const error = await shell.openPath(await updater.downloadedPath())
    if (error) throw new Error(`无法打开更新安装程序：${error}`)
  })
  ipcMain.handle('announcements:status', () => announcements.status())
  ipcMain.handle('announcements:check', () => announcements.check())
  ipcMain.handle('announcements:open-action', async () => {
    const status = announcements.status()
    if (status.state !== 'available' || !status.announcement?.action) throw new Error('当前公告没有可打开的链接')
    await shell.openExternal(status.announcement.action.url)
  })
  ipcMain.handle('proxy:test', (_event, config, profileId?: string) => {
    const validated = validateProxyConfig(config)
    const profile = profileId ? profiles.get(profileId) : undefined
    return testProxy(proxyForTest(validated, profile))
  })
  ipcMain.handle('diagnostics:session-health', () => appSession.recoveryStatus())
  if (process.env.PRISM_E2E === '1') {
    ipcMain.handle('diagnostics:e2e-quit', () => app.quit())
  }
  ipcMain.handle('licensing:status', () => licensing.status())
  ipcMain.handle('licensing:sync', () => licensing.synchronize())
  ipcMain.handle('licensing:activate', (_event, activationCode: string) => licensing.activate(activationCode))
  ipcMain.handle('licensing:deactivate', () => licensing.deactivate())
  ipcMain.handle('licensing:open-purchase', async () => {
    await shell.openExternal(PRO_PURCHASE_URL)
  })
  ipcMain.handle('automation:status', () => automation.status())
  ipcMain.handle('automation:start', () => automation.start())
  ipcMain.handle('automation:stop', () => automation.stop(false))
  ipcMain.handle('automation:emergency-stop', () => automation.stop(true))
  ipcMain.handle('scheduler:list', () => scheduler.list())
  ipcMain.handle('scheduler:create', (_event, draft) => scheduler.create(draft))
  ipcMain.handle('scheduler:update', (_event, id: string, draft) => scheduler.update(id, draft))
  ipcMain.handle('scheduler:remove', (_event, id: string) => scheduler.remove(id))
  ipcMain.handle('scheduler:set-enabled', (_event, id: string, enabled: boolean) => scheduler.setEnabled(id, enabled))
  ipcMain.handle('scheduler:run-now', (_event, id: string) => scheduler.runNow(id))
  ipcMain.handle('mcp:status', () => mcp.status(automation.status().state === 'running'))
  ipcMain.handle('mcp:permissions', () => mcp.permissionList())
  ipcMain.handle('mcp:set-permission', (_event, profileId: string, enabled: boolean) => mcp.setPermission(profileId, enabled))
  ipcMain.handle('mcp:start', () => automation.mcpConnection())
  ipcMain.handle('mcp:stop', async () => {
    await automation.stop(false)
    mcp.resetSessions()
    return mcp.status(false)
  })
  ipcMain.handle('mcp:emergency-stop', async () => {
    await mcp.emergencyStop()
    await automation.stop(false)
    return mcp.status(false)
  })
  ipcMain.handle('extensions:list', () => extensions.list())
  ipcMain.handle('extensions:import-directory', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择未打包的浏览器扩展目录', properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extensions.importDirectory(result.filePaths[0])
  })
  ipcMain.handle('extensions:remove', async (_event, id: string) => {
    if (await profiles.usesExtension(id)) throw new Error('该扩展仍被浏览器环境使用，请先从环境配置中移除')
    await extensions.remove(id)
  })
}
