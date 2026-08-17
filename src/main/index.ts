import { app, BrowserWindow, dialog, shell } from 'electron'
import { isAbsolute, join } from 'node:path'
import { BrowserLauncher } from './browser-launcher'
import { registerIpc } from './ipc'
import { ProfileStore } from './profile-store'
import { ElectronSecretCodec } from './secret-codec'
import { SettingsStore } from './settings-store'
import { KernelManager } from './kernel-manager'
import { AppLogger } from './app-logger'
import { ExtensionStore } from './extension-store'
import { CookieManager } from './cookie-manager'
import { publicProfile } from './profile-secrets'
import { ProfileBackupManager } from './profile-backup'
import { AppSessionTracker } from './app-session'
import { UpdateManager } from './update-manager'
import { migrateMacLegacyKernelSelection } from './browser-locator'
import { LicenseManager } from './license-manager'
import { WorkspaceMigrationManager } from './workspace-migration'
import { ElectronDeviceKeyProtector } from './electron-device-key-protector'
import { AutomationAuditLog } from './automation-audit'
import { ProAgentManager } from './pro-agent-manager'
import { SchedulerStore } from './scheduler-store'
import { SchedulerAuditLog } from './scheduler-audit'
import { SchedulerManager } from './scheduler-manager'
import { McpPermissionStore } from './mcp-permission-store'
import { McpAuditLog } from './mcp-audit'
import { McpControlManager } from './mcp-control-manager'
import { AnnouncementManager } from './announcement-manager'

let mainWindow: BrowserWindow | null = null
let launcher: BrowserLauncher | null = null
let logger: AppLogger | null = null
let appSession: AppSessionTracker | null = null
let automation: ProAgentManager | null = null
let scheduler: SchedulerManager | null = null
let mcp: McpControlManager | null = null

if (process.platform === 'win32') app.setAppUserModelId('com.prismbrowser.desktop')

if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_USER_DATA && isAbsolute(process.env.PRISM_E2E_USER_DATA)) {
  app.setPath('userData', process.env.PRISM_E2E_USER_DATA)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'Prism Browser',
    backgroundColor: '#f3f5f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') logger?.error('Renderer console error', event.message)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger?.error('Renderer load failed', { code, description, url })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.whenReady().then(async () => {
  const vaultPath = join(app.getPath('userData'), 'vault')
  logger = new AppLogger(vaultPath)
  appSession = new AppSessionTracker(vaultPath)
  const profiles = new ProfileStore(vaultPath, new ElectronSecretCodec())
  const settings = new SettingsStore(vaultPath)
  const extensions = new ExtensionStore(vaultPath, logger)
  const automationAudit = new AutomationAuditLog(vaultPath)
  const schedulerAudit = new SchedulerAuditLog(vaultPath)
  const mcpAudit = new McpAuditLog(vaultPath)
  await logger.initialize()
  await Promise.all([automationAudit.initialize(), schedulerAudit.initialize(), mcpAudit.initialize()])
  const appSessionSnapshot = await appSession.begin(app.getVersion())
  if (appSessionSnapshot.previousUnclean) {
    logger.error('检测到上次 Prism Browser 未正常退出', appSessionSnapshot.previousUnclean)
  }
  await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
  const kernelMigration = await migrateMacLegacyKernelSelection(settings, vaultPath)
  if (kernelMigration.migrated) {
    logger.info('已将 macOS 旧版托管内核切换为应用内置新版内核', {
      previousVersion: kernelMigration.previousVersion,
      bundledVersion: kernelMigration.bundledVersion
    })
  }
  const purgedTrashCount = await profiles.purgeTrashOlderThan(settings.get().recycleRetentionDays)
  if (purgedTrashCount) logger.info('已按保留策略自动清理环境回收站', { count: purgedTrashCount })
  const profileStorageHealth = profiles.storageHealth()
  if (profileStorageHealth.recoveredFromBackup) logger.error('环境元数据已从备份恢复', profileStorageHealth)
  if (!profileStorageHealth.backupHealthy) logger.error('环境元数据备份不可用', profileStorageHealth.backupError)
  logger.info('Prism Browser 已启动', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  launcher = new BrowserLauncher(profiles, settings, (profile) => {
    mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  }, extensions, logger)
  await launcher.initialize()
  const kernels = new KernelManager(vaultPath, settings, () => undefined, logger, (version) => profiles.kernelUsers(version))
  const cookies = new CookieManager(profiles, settings, logger)
  const backups = new ProfileBackupManager(profiles, app.getVersion(), logger)
  const workspaceMigration = new WorkspaceMigrationManager(profiles, extensions, app.getVersion(), logger)
  const updater = new UpdateManager(vaultPath, app.getVersion(), process.resourcesPath, (status) => {
    mainWindow?.webContents.send('updates:changed', status)
  }, logger)
  const announcements = new AnnouncementManager(process.resourcesPath, app.getVersion(), logger)
  const licensing = new LicenseManager(
    vaultPath,
    process.resourcesPath,
    app.getVersion(),
    new ElectronDeviceKeyProtector(),
    (status) => {
      mainWindow?.webContents.send('licensing:changed', status)
      if (status.plan !== 'pro') void automation?.stop(true).catch(() => undefined)
      if (status.plan !== 'pro') void mcp?.emergencyStop().catch(() => undefined)
      scheduler?.refreshEntitlement()
    },
    logger
  )
  await Promise.all([updater.initialize(), licensing.initialize()])
  launcher.setProKernelAccessCheck(() => licensing.status().plan === 'pro')
  kernels.setProKernelAccessCheck(() => licensing.status().plan === 'pro')
  mcp = new McpControlManager(
    new McpPermissionStore(vaultPath), profiles, launcher, licensing, mcpAudit,
    (status) => mainWindow?.webContents.send('mcp:changed', status)
  )
  await mcp.initialize()
  automation = new ProAgentManager(
    profiles,
    launcher,
    licensing,
    automationAudit,
    process.resourcesPath,
    (status) => mainWindow?.webContents.send('automation:changed', status),
    logger
  )
  automation.attachMcpBroker(mcp)
  scheduler = new SchedulerManager(
    new SchedulerStore(vaultPath),
    profiles,
    launcher,
    licensing,
    schedulerAudit,
    (tasks) => mainWindow?.webContents.send('scheduler:changed', tasks),
    logger
  )
  await scheduler.initialize()
  registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, updater, licensing, automation, scheduler, mcp, announcements })
  mainWindow = createWindow()
  if (app.isPackaged && process.env.PRISM_E2E !== '1') {
    setTimeout(() => void updater.check().catch(() => undefined), 10_000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}).catch(async (error) => {
  logger?.error('Prism Browser 启动失败', error)
  await logger?.flush()
  dialog.showErrorBox(
    'Prism Browser 无法启动',
    '应用启动失败，但现有环境数据没有被修改。请重新启动；如仍然失败，请查看日志文件。'
  )
  app.quit()
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('before-quit', (event) => {
  if (!launcher) return
  event.preventDefault()
  const current = launcher
  launcher = null
  void Promise.allSettled([scheduler?.shutdown() ?? Promise.resolve(), mcp?.shutdown() ?? Promise.resolve()]).then(() => Promise.allSettled([
    current.closeAll(), automation?.stop(false) ?? Promise.resolve()
  ])).finally(async () => {
    logger?.info('Prism Browser 已退出')
    await appSession?.complete().catch((error) => logger?.error('清理应用会话标记失败', error))
    await logger?.flush()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtExceptionMonitor', (error) => {
  logger?.error('主进程未捕获异常', error)
})

process.on('unhandledRejection', (reason) => {
  logger?.error('主进程未处理 Promise 拒绝', reason)
  console.error(reason)
})
