import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { canonicalJson } from './license-crypto'

const execFileAsync = promisify(execFile)

export interface ProAgentManifestPayload {
  schemaVersion: 1
  product: 'prism-pro-agent'
  version: string
  target: 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
  osSignaturePolicy?: 'adhoc-internal' | 'developer-id' | 'internal-unsigned' | 'authenticode'
  executableFile: string
  executableSize: number
  executableSha256: string
  issuedAt: string
}

export interface SignedProAgentManifest {
  payload: ProAgentManifestPayload
  signature: string
}

export type OsSignatureVerifier = (executablePath: string) => Promise<void>

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

function validateManifest(value: unknown): SignedProAgentManifest {
  const manifest = value as Partial<SignedProAgentManifest>
  const payload = manifest?.payload as Partial<ProAgentManifestPayload>
  if (!manifest || !payload || payload.schemaVersion !== 1 || payload.product !== 'prism-pro-agent'
    || typeof payload.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(payload.version)
    || !['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(String(payload.target))
    || (payload.osSignaturePolicy !== undefined
      && !['adhoc-internal', 'developer-id', 'internal-unsigned', 'authenticode'].includes(payload.osSignaturePolicy))
    || typeof payload.executableFile !== 'string' || basename(payload.executableFile) !== payload.executableFile
    || (payload.target === 'win32-x64'
      ? !/^prism-pro-agent(?:-[A-Za-z0-9._-]+)?\.exe$/.test(payload.executableFile)
      : !/^prism-pro-agent(?:-[A-Za-z0-9._-]+)?$/.test(payload.executableFile))
    || typeof payload.executableSize !== 'number' || !Number.isSafeInteger(payload.executableSize) || payload.executableSize <= 0
    || typeof payload.executableSha256 !== 'string' || !/^[a-f\d]{64}$/.test(payload.executableSha256)
    || typeof payload.issuedAt !== 'string' || !Number.isFinite(Date.parse(payload.issuedAt))
    || typeof manifest.signature !== 'string' || Buffer.from(manifest.signature, 'base64').length !== 64) {
    throw new Error('Prism Pro Agent 清单格式无效')
  }
  return manifest as SignedProAgentManifest
}

export async function verifyProAgentBundle(options: {
  manifestPath: string
  releasePublicKey: string
  platform?: NodeJS.Platform
  architecture?: string
  verifyOsSignature?: OsSignatureVerifier
}): Promise<{ manifest: SignedProAgentManifest; executablePath: string }> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const supported = platform === 'darwin' && ['arm64', 'x64'].includes(architecture)
    || platform === 'win32' && architecture === 'x64'
  if (!supported) throw new Error('Prism Pro Agent 当前只支持 macOS arm64/x64 和 Windows x64')
  const manifest = validateManifest(JSON.parse(await readFile(options.manifestPath, 'utf8')))
  const publicKey = createPublicKey(options.releasePublicKey)
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(canonicalJson(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) {
    throw new Error('Prism Pro Agent 发布签名无效')
  }
  if (manifest.payload.target !== `${platform}-${architecture}`) throw new Error('Prism Pro Agent 与当前系统架构不匹配')
  const expectedPath = resolve(dirname(options.manifestPath), manifest.payload.executableFile)
  const executablePath = expectedPath
  if ((await lstat(executablePath)).isSymbolicLink()) throw new Error('Prism Pro Agent 不允许使用符号链接')
  const file = await stat(executablePath)
  if (!file.isFile() || file.size !== manifest.payload.executableSize) throw new Error('Prism Pro Agent 文件大小不匹配')
  if (await sha256File(executablePath) !== manifest.payload.executableSha256) throw new Error('Prism Pro Agent 文件哈希不匹配')
  if (options.verifyOsSignature) await options.verifyOsSignature(executablePath)
  else if (platform === 'darwin') await verifyMacCodeSignature(executablePath)
  else if (manifest.payload.osSignaturePolicy === 'authenticode') await verifyWindowsAuthenticode(executablePath)
  else if (manifest.payload.osSignaturePolicy !== 'internal-unsigned') {
    throw new Error('Prism Pro Agent 的 Windows 签名策略无效')
  }
  return { manifest, executablePath }
}

export async function verifyWindowsAuthenticode(executablePath: string): Promise<void> {
  const escaped = executablePath.replaceAll("'", "''")
  const command = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { exit 7 }`
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 20_000,
      encoding: 'utf8',
      windowsHide: true
    })
  } catch {
    throw new Error('Prism Pro Agent 的 Windows Authenticode 签名无效')
  }
}

export async function verifyMacCodeSignature(executablePath: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', executablePath], {
      timeout: 15_000,
      encoding: 'utf8'
    })
  } catch {
    throw new Error('Prism Pro Agent 的 macOS 代码签名无效')
  }
}
