import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserApi, BrowserProfileView, ProfileBatchClassification, ProfileDraft, ProfileLaunchOptions } from '../shared/types'

const api: BrowserApi = {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (draft: ProfileDraft) => ipcRenderer.invoke('profiles:create', draft),
    update: (id: string, draft: ProfileDraft) => ipcRenderer.invoke('profiles:update', id, draft),
    duplicate: (id: string) => ipcRenderer.invoke('profiles:duplicate', id),
    exportConfig: (id: string) => ipcRenderer.invoke('profiles:export-config', id),
    importConfig: () => ipcRenderer.invoke('profiles:import-config'),
    importBatchCsv: () => ipcRenderer.invoke('profiles:import-batch-csv'),
    exportBatchTemplate: () => ipcRenderer.invoke('profiles:export-batch-template'),
    storageHealth: () => ipcRenderer.invoke('profiles:storage-health'),
    storageInfo: (id: string) => ipcRenderer.invoke('profiles:storage-info', id),
    storageOverview: () => ipcRenderer.invoke('profiles:storage-overview'),
    openDataFolder: (id: string) => ipcRenderer.invoke('profiles:open-data-folder', id),
    clearCache: (id: string) => ipcRenderer.invoke('profiles:clear-cache', id),
    exportBackup: (id: string) => ipcRenderer.invoke('profiles:export-backup', id),
    importBackup: () => ipcRenderer.invoke('profiles:import-backup'),
    exportWorkspace: (password: string) => ipcRenderer.invoke('profiles:export-workspace', password),
    importWorkspace: (password: string, conflictPolicy: 'rename' | 'skip') => ipcRenderer.invoke('profiles:import-workspace', password, conflictPolicy),
    trash: () => ipcRenderer.invoke('profiles:trash'),
    restore: (trashId: string) => ipcRenderer.invoke('profiles:restore', trashId),
    purgeTrash: (trashId: string) => ipcRenderer.invoke('profiles:purge-trash', trashId),
    emptyTrash: () => ipcRenderer.invoke('profiles:empty-trash'),
    recycleRetention: () => ipcRenderer.invoke('profiles:recycle-retention'),
    setRecycleRetention: (days) => ipcRenderer.invoke('profiles:set-recycle-retention', days),
    exportCookies: (id: string) => ipcRenderer.invoke('profiles:export-cookies', id),
    importCookies: (id: string) => ipcRenderer.invoke('profiles:import-cookies', id),
    remove: (id: string) => ipcRenderer.invoke('profiles:remove', id),
    launch: (id: string, options?: ProfileLaunchOptions) => ipcRenderer.invoke('profiles:launch', id, options),
    close: (id: string) => ipcRenderer.invoke('profiles:close', id),
    closeAll: () => ipcRenderer.invoke('profiles:close-all'),
    testProxy: (id: string) => ipcRenderer.invoke('profiles:test-proxy', id),
    diagnose: (id: string) => ipcRenderer.invoke('profiles:diagnose', id),
    crashHistory: (id: string) => ipcRenderer.invoke('profiles:crash-history', id),
    setFavorite: (id: string, favorite: boolean) => ipcRenderer.invoke('profiles:set-favorite', id, favorite),
    classifyMany: (ids: string[], patch: ProfileBatchClassification) => ipcRenderer.invoke('profiles:classify-many', ids, patch),
    removeMany: (ids: string[]) => ipcRenderer.invoke('profiles:remove-many', ids),
    onChanged: (listener: (profile: BrowserProfileView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, profile: BrowserProfileView): void => listener(profile)
      ipcRenderer.on('profiles:changed', handler)
      return () => ipcRenderer.removeListener('profiles:changed', handler)
    }
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    bundled: () => ipcRenderer.invoke('engine:bundled'),
    activateBundled: () => ipcRenderer.invoke('engine:activate-bundled'),
    select: () => ipcRenderer.invoke('engine:select'),
    importLocal: () => ipcRenderer.invoke('engine:import-local'),
    useSystem: () => ipcRenderer.invoke('engine:use-system'),
    installed: () => ipcRenderer.invoke('engine:installed'),
    activate: (version: string) => ipcRenderer.invoke('engine:activate', version),
    rollbackAvailable: () => ipcRenderer.invoke('engine:rollback-available'),
    rollback: () => ipcRenderer.invoke('engine:rollback'),
    remove: (version: string) => ipcRenderer.invoke('engine:remove', version),
    verify: (version: string) => ipcRenderer.invoke('engine:verify', version)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    openInstaller: () => ipcRenderer.invoke('updates:open-installer'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on('updates:changed', handler)
      return () => ipcRenderer.removeListener('updates:changed', handler)
    }
  },
  announcements: {
    status: () => ipcRenderer.invoke('announcements:status'),
    check: () => ipcRenderer.invoke('announcements:check'),
    openAction: () => ipcRenderer.invoke('announcements:open-action')
  },
  proxy: {
    test: (config, profileId) => ipcRenderer.invoke('proxy:test', config, profileId)
  },
  diagnostics: {
    sessionHealth: () => ipcRenderer.invoke('diagnostics:session-health'),
    e2eQuit: () => ipcRenderer.invoke('diagnostics:e2e-quit')
  },
  licensing: {
    status: () => ipcRenderer.invoke('licensing:status'),
    sync: () => ipcRenderer.invoke('licensing:sync'),
    activate: (activationCode: string) => ipcRenderer.invoke('licensing:activate', activationCode),
    deactivate: () => ipcRenderer.invoke('licensing:deactivate'),
    openPurchase: () => ipcRenderer.invoke('licensing:open-purchase'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on('licensing:changed', handler)
      return () => ipcRenderer.removeListener('licensing:changed', handler)
    }
  },
  automation: {
    status: () => ipcRenderer.invoke('automation:status'),
    start: () => ipcRenderer.invoke('automation:start'),
    stop: () => ipcRenderer.invoke('automation:stop'),
    emergencyStop: () => ipcRenderer.invoke('automation:emergency-stop'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on('automation:changed', handler)
      return () => ipcRenderer.removeListener('automation:changed', handler)
    }
  },
  scheduler: {
    list: () => ipcRenderer.invoke('scheduler:list'),
    create: (draft) => ipcRenderer.invoke('scheduler:create', draft),
    update: (id, draft) => ipcRenderer.invoke('scheduler:update', id, draft),
    remove: (id) => ipcRenderer.invoke('scheduler:remove', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('scheduler:set-enabled', id, enabled),
    runNow: (id) => ipcRenderer.invoke('scheduler:run-now', id),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, tasks: Parameters<typeof listener>[0]) => listener(tasks)
      ipcRenderer.on('scheduler:changed', handler)
      return () => ipcRenderer.removeListener('scheduler:changed', handler)
    }
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    permissions: () => ipcRenderer.invoke('mcp:permissions'),
    setPermission: (profileId, enabled) => ipcRenderer.invoke('mcp:set-permission', profileId, enabled),
    start: () => ipcRenderer.invoke('mcp:start'),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    emergencyStop: () => ipcRenderer.invoke('mcp:emergency-stop'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on('mcp:changed', handler)
      return () => ipcRenderer.removeListener('mcp:changed', handler)
    }
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    importDirectory: () => ipcRenderer.invoke('extensions:import-directory'),
    remove: (id: string) => ipcRenderer.invoke('extensions:remove', id)
  }
}

contextBridge.exposeInMainWorld('browserApi', api)
