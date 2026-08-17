import { app } from 'electron'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { AppSettings, EngineStatus } from '../shared/types'
import type { SettingsStore } from './settings-store'
import {
  validateKernelIntegrityFields,
  verifyKernelIntegrity,
  type KernelCriticalFile
} from './kernel-integrity'

const SYSTEM_CANDIDATES: Record<NodeJS.Platform, string[]> = {
  darwin: [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  win32: [
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] as string[],
  aix: [],
  android: [],
  freebsd: [],
  haiku: [],
  openbsd: [],
  sunos: [],
  cygwin: [],
  netbsd: []
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

interface ManagedKernelManifest {
  schemaVersion?: number
  version: string
  executableRelative: string
  target?: string
  criticalFiles?: KernelCriticalFile[]
  criticalFilesSha256?: string
}

interface ProfileBrowserRuntime {
  resourcesPath?: string
  preferBundledOverLegacyManaged?: boolean
}

export interface MacBundledKernelMigration {
  migrated: boolean
  previousVersion?: string
  bundledVersion?: string
}

function validKernelVersion(version: string): boolean {
  return /^\d+(?:\.\d+){3}$/.test(version)
}

/** Resolve a profile-pinned managed kernel without ever falling back to another browser. */
export async function locateBrowserForProfile(
  settingsStore: SettingsStore,
  vaultPath: string,
  kernelVersion: string,
  runtime: ProfileBrowserRuntime = {}
): Promise<EngineStatus> {
  const version = kernelVersion.trim()
  if (!version) return locateBrowser(settingsStore)
  if (!validKernelVersion(version)) throw new Error('环境绑定的内核版本号无效')

  const root = resolve(vaultPath, 'kernels', version)
  const missing = (reason: string): EngineStatus => ({
    executable: null,
    source: 'missing',
    fingerprintKernel: true,
    label: `环境绑定内核 ${version}（${reason}）`,
    version
  })
  let managedResult: EngineStatus
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Partial<ManagedKernelManifest>
    if (manifest.version !== version || typeof manifest.executableRelative !== 'string' || !manifest.executableRelative) {
      managedResult = missing('清单无效')
    } else {
      const executable = resolve(root, manifest.executableRelative)
      if (isAbsolute(manifest.executableRelative) || (executable !== root && !executable.startsWith(`${root}${sep}`))) {
        managedResult = missing('清单路径越界')
      } else if (manifest.target && manifest.target !== `${process.platform}-${process.arch}`) {
        managedResult = missing('平台不匹配')
      } else if (!await executableExists(executable)) {
        managedResult = missing('文件缺失')
      } else {
        const integrityShapeError = manifest.schemaVersion === 2 && (!manifest.criticalFiles || !manifest.criticalFilesSha256)
          ? '完整性清单缺失'
          : validateKernelIntegrityFields(manifest, manifest.executableRelative)
        if (integrityShapeError) {
          managedResult = missing(integrityShapeError)
        } else {
          const integrity = await verifyKernelIntegrity(root, manifest.executableRelative, manifest)
          if (integrity.status === 'corrupt') {
            managedResult = missing(`完整性校验失败：${integrity.reason}`)
          } else {
            const preferBundled = runtime.preferBundledOverLegacyManaged ?? process.platform === 'darwin'
            if (integrity.status === 'legacy' && preferBundled) {
              const bundled = await locateBundledBrowser(runtime.resourcesPath ?? process.resourcesPath, version)
              if (bundled?.executable && !bundled.label.includes('旧版完整性清单')) {
                return { ...bundled, source: 'profile', label: 'Fingerprint Chromium（环境固定 · 内置新版）' }
              }
            }
            return {
              executable,
              source: 'profile',
              fingerprintKernel: true,
              label: integrity.status === 'legacy'
                ? 'Fingerprint Chromium（环境固定 · 旧版完整性清单）'
                : 'Fingerprint Chromium（环境固定）',
              version
            }
          }
        }
      }
    }
  } catch (error) {
    managedResult = (error as NodeJS.ErrnoException).code === 'ENOENT' ? missing('未安装') : missing('清单损坏')
  }

  const bundled = await locateBundledBrowser(runtime.resourcesPath ?? process.resourcesPath, version)
  if (bundled?.executable) {
    return { ...bundled, source: 'profile', label: 'Fingerprint Chromium（环境固定 · 内置）' }
  }
  return managedResult
}

/**
 * One-way macOS upgrade migration for old managed fingerprint kernels.
 *
 * Early Prism builds persisted an unverified managed-kernel executable in
 * settings. A newer app bundle can carry a fully verified kernel, but the old
 * executable otherwise keeps shadowing it forever. Only legacy managed paths
 * inside this vault are migrated; explicit system/custom selections and the
 * Windows selection contract are deliberately untouched.
 */
export async function migrateMacLegacyKernelSelection(
  settingsStore: SettingsStore,
  vaultPath: string,
  resourcesPath = process.resourcesPath,
  platform: NodeJS.Platform = process.platform
): Promise<MacBundledKernelMigration> {
  if (platform !== 'darwin') return { migrated: false }
  const settings = settingsStore.get()
  if (!settings.browserExecutable || !settings.fingerprintKernel || settings.enginePreference !== 'auto') {
    return { migrated: false }
  }

  const previousVersion = inferFingerprintKernelVersion(settings.browserExecutable)
  if (!previousVersion) return { migrated: false }
  const managedRoot = resolve(vaultPath, 'kernels', previousVersion)
  const configured = resolve(settings.browserExecutable)
  if (configured !== managedRoot && !configured.startsWith(`${managedRoot}${sep}`)) return { migrated: false }

  try {
    const manifest = JSON.parse(await readFile(join(managedRoot, 'manifest.json'), 'utf8')) as Partial<ManagedKernelManifest>
    if (manifest.schemaVersion === 2 && manifest.criticalFiles && manifest.criticalFilesSha256) {
      return { migrated: false }
    }
  } catch {
    // A missing or unreadable legacy manifest is also safe to migrate away from.
  }

  const bundled = await locateBundledBrowser(resourcesPath)
  if (!bundled?.executable || bundled.label.includes('旧版完整性清单')) return { migrated: false }
  await settingsStore.update({ browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' })
  return { migrated: true, previousVersion, bundledVersion: bundled.version }
}

export function inferFingerprintKernelVersion(executable: string): string | undefined {
  const normalized = executable.replaceAll('\\', '/')
  return normalized.match(/\/kernels\/(\d+(?:\.\d+){3})(?:\/|$)/)?.[1]
}

export async function normalizeBrowserSelection(selection: string): Promise<string> {
  const info = await stat(selection)
  if (!info.isDirectory() || !selection.endsWith('.app')) return selection
  const appName = basename(selection, '.app')
  const candidates = [appName, 'Chromium', 'Google Chrome', 'Microsoft Edge']
  for (const executable of candidates) {
    const candidate = join(selection, 'Contents', 'MacOS', executable)
    if (await executableExists(candidate)) return candidate
  }
  throw new Error('所选 .app 中没有找到浏览器可执行文件')
}

export async function locateBundledBrowser(
  resourcesPath = process.resourcesPath,
  requiredVersion?: string
): Promise<EngineStatus | null> {
  if (!resourcesPath) return null
  const currentRoot = resolve(resourcesPath, 'kernels', 'current')
  const roots = requiredVersion
    ? [currentRoot, resolve(resourcesPath, 'kernels', 'available', requiredVersion)]
    : [currentRoot]
  for (const root of roots) {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Partial<ManagedKernelManifest>
      if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || !validKernelVersion(manifest.version ?? '')
        || typeof manifest.executableRelative !== 'string' || !manifest.executableRelative) continue
      if (requiredVersion && manifest.version !== requiredVersion) continue
      if (manifest.target && manifest.target !== `${process.platform}-${process.arch}`) continue
      const executable = resolve(root, manifest.executableRelative)
      if (isAbsolute(manifest.executableRelative) || (executable !== root && !executable.startsWith(`${root}${sep}`))) continue
      if (!await executableExists(executable)) continue
      if (manifest.schemaVersion === 2 && (!manifest.criticalFiles || !manifest.criticalFilesSha256)) continue
      if (validateKernelIntegrityFields(manifest, manifest.executableRelative)) continue
      const integrity = await verifyKernelIntegrity(root, manifest.executableRelative, manifest)
      if (integrity.status === 'corrupt') continue
      return {
        executable,
        source: 'bundled',
        fingerprintKernel: true,
        label: integrity.status === 'legacy' ? '内置 Fingerprint Chromium（旧版完整性清单）' : '内置 Fingerprint Chromium',
        version: manifest.version
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
  }

  if (requiredVersion) return null
  const legacyCandidates = process.platform === 'darwin'
    ? [
        join(currentRoot, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(currentRoot, 'Chromium')
      ]
    : [join(currentRoot, process.platform === 'win32' ? 'chrome.exe' : 'chrome')]
  for (const executable of legacyCandidates) {
    if (await executableExists(executable)) {
      return { executable, source: 'bundled', fingerprintKernel: true, label: '内置 Fingerprint Chromium' }
    }
  }
  return null
}

/** List the stable bundled kernel and optional side-by-side Pro kernels. */
export async function listBundledBrowsers(resourcesPath = process.resourcesPath): Promise<EngineStatus[]> {
  if (!resourcesPath) return []
  const engines: EngineStatus[] = []
  const current = await locateBundledBrowser(resourcesPath)
  if (current?.executable && current.version) engines.push(current)
  const availableRoot = resolve(resourcesPath, 'kernels', 'available')
  let versions: string[] = []
  try {
    versions = (await readdir(availableRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && validKernelVersion(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return engines
  }
  for (const version of versions) {
    if (engines.some((engine) => engine.version === version)) continue
    const engine = await locateBundledBrowser(resourcesPath, version)
    if (engine?.executable) engines.push(engine)
  }
  return engines.sort((first, second) => (second.version ?? '').localeCompare(first.version ?? '', undefined, { numeric: true }))
}

export async function locateBrowserSelection(settings: AppSettings, resourcesPath = process.resourcesPath): Promise<EngineStatus> {
  if (settings.browserExecutable && await executableExists(settings.browserExecutable)) {
    return {
      executable: settings.browserExecutable,
      source: 'configured',
      fingerprintKernel: settings.fingerprintKernel,
      label: settings.fingerprintKernel ? 'Fingerprint Chromium' : '自定义 Chromium（兼容模式）',
      version: settings.fingerprintKernel ? inferFingerprintKernelVersion(settings.browserExecutable) : undefined
    }
  }

  if (settings.enginePreference !== 'system') {
    const bundled = await locateBundledBrowser(resourcesPath)
    if (bundled) return bundled
    if (settings.enginePreference === 'bundled') {
      return { executable: null, source: 'missing', fingerprintKernel: true, label: '指定的内置指纹内核不可用' }
    }
  }

  for (const candidate of SYSTEM_CANDIDATES[process.platform] ?? []) {
    if (await executableExists(candidate)) {
      return { executable: candidate, source: 'system', fingerprintKernel: false, label: '系统浏览器（兼容模式）' }
    }
  }

  return { executable: null, source: 'missing', fingerprintKernel: false, label: '未配置浏览器内核' }
}

export async function locateBrowser(settingsStore: SettingsStore, resourcesPath = process.resourcesPath): Promise<EngineStatus> {
  return locateBrowserSelection(settingsStore.get(), resourcesPath)
}

export function appIconPath(): string | undefined {
  if (!app.isPackaged) return undefined
  return join(process.resourcesPath, 'icon.png')
}
