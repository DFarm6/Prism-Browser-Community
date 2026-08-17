import { randomUUID } from 'node:crypto'
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { BrowserExtension } from '../shared/types'
import type { Logger } from './app-logger'

interface ChromeExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  description?: string
}

const MAX_EXTENSION_BYTES = 200 * 1024 * 1024
const MAX_EXTENSION_FILES = 20_000

async function inspectDirectory(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('扩展目录不能包含符号链接')
    if (!info.isDirectory()) {
      bytes += info.size
      files += 1
      if (bytes > MAX_EXTENSION_BYTES) throw new Error('扩展目录不能超过 200 MB')
      if (files > MAX_EXTENSION_FILES) throw new Error('扩展文件数量不能超过 20000 个')
      return
    }
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  await visit(root)
  return { bytes, files }
}

export class ExtensionStore {
  private readonly root: string
  private readonly extensions = new Map<string, BrowserExtension>()

  constructor(private readonly vaultPath: string, private readonly logger?: Logger) {
    this.root = join(vaultPath, 'extensions')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const metadata = JSON.parse(await readFile(join(this.root, entry.name, 'metadata.json'), 'utf8')) as BrowserExtension
        if (metadata.id !== entry.name || !/^[a-f\d-]{36}$/i.test(metadata.id)) throw new Error('扩展元数据 ID 无效')
        await access(join(this.root, entry.name, 'extension', 'manifest.json'))
        this.extensions.set(metadata.id, { ...metadata, path: join(this.root, entry.name, 'extension') })
      } catch (error) {
        this.logger?.error('忽略不完整的本地扩展', { id: entry.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  list(): BrowserExtension[] {
    return [...this.extensions.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((item) => ({ ...item }))
  }

  paths(ids: string[]): string[] {
    return ids.map((id) => {
      const extension = this.extensions.get(id)
      if (!extension) throw new Error(`环境引用的扩展 ${id.slice(0, 8)} 不存在，请编辑环境配置`)
      return extension.path
    })
  }

  async importDirectory(sourceInput: string): Promise<BrowserExtension> {
    const source = resolve(sourceInput)
    const root = resolve(this.root)
    if (source === root || source.startsWith(`${root}${sep}`)) throw new Error('不能从扩展仓库内部重复导入')
    const manifestPath = join(source, 'manifest.json')
    let manifest: ChromeExtensionManifest
    try {
      if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('扩展 manifest.json 不能超过 1 MB')
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ChromeExtensionManifest
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('扩展 manifest.json 不是有效 JSON')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('所选目录缺少 manifest.json')
      throw error
    }
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('只支持 Manifest V2 或 V3 扩展')
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('扩展 manifest 缺少名称')
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
      throw new Error('扩展 manifest 版本号无效')
    }
    await inspectDirectory(source)

    const id = randomUUID()
    const staging = join(this.root, `.import-${id}`)
    const target = join(this.root, id)
    await mkdir(staging, { recursive: true })
    try {
      await cp(source, join(staging, 'extension'), { recursive: true, errorOnExist: true })
      const extension: BrowserExtension = {
        id,
        name: manifest.name.startsWith('__MSG_') ? basename(source) : manifest.name.trim(),
        version: manifest.version,
        description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
        manifestVersion: manifest.manifest_version,
        installedAt: new Date().toISOString(),
        path: join(target, 'extension')
      }
      await writeFile(join(staging, 'metadata.json'), JSON.stringify(extension, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.extensions.set(id, extension)
      this.logger?.info('浏览器扩展已导入', { extensionId: id, name: extension.name, version: extension.version })
      return { ...extension }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id) || !this.extensions.has(id)) throw new Error('浏览器扩展不存在')
    const recycle = join(this.vaultPath, 'recycle-bin', 'extensions')
    await mkdir(recycle, { recursive: true })
    await rename(join(this.root, id), join(recycle, `${id}-${Date.now()}`))
    this.extensions.delete(id)
    this.logger?.info('浏览器扩展已移入回收目录', { extensionId: id })
  }

  async rollbackMigrationImports(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.extensions.has(id)) continue
      this.extensions.delete(id)
      await rm(join(this.root, id), { recursive: true, force: true })
    }
  }
}
