import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface DeviceKeyProtector {
  protect(value: string): string
  unprotect(value: string): string
}

export interface DeviceIdentity {
  deviceId: string
  publicKey: string
  privateKey: string
  createdAt: string
}

interface StoredDeviceIdentity {
  schemaVersion: 1
  publicKey: string
  protectedPrivateKey: string
  createdAt: string
}

function deviceIdFor(publicKey: string): string {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('设备公钥类型无效')
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

function validatePair(publicKey: string, privateKey: string): void {
  const publicObject = createPublicKey(publicKey)
  const privateObject = createPrivateKey(privateKey)
  if (publicObject.asymmetricKeyType !== 'ed25519' || privateObject.asymmetricKeyType !== 'ed25519') {
    throw new Error('设备密钥类型无效')
  }
  const challenge = Buffer.from('prism-device-key-integrity-v1')
  const signature = sign(null, challenge, privateObject)
  if (!verify(null, challenge, publicObject, signature)) throw new Error('设备公私钥不匹配')
}

export class DeviceIdentityStore {
  readonly path: string

  constructor(vaultPath: string, private readonly protector: DeviceKeyProtector) {
    this.path = join(vaultPath, 'license', 'device.json')
  }

  async loadOrCreate(): Promise<DeviceIdentity> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredDeviceIdentity>
      if (value.schemaVersion !== 1 || typeof value.publicKey !== 'string'
        || typeof value.protectedPrivateKey !== 'string' || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))) {
        throw new Error('设备身份文件格式无效')
      }
      const privateKey = this.protector.unprotect(value.protectedPrivateKey)
      validatePair(value.publicKey, privateKey)
      return {
        deviceId: deviceIdFor(value.publicKey),
        publicKey: value.publicKey,
        privateKey,
        createdAt: value.createdAt
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const createdAt = new Date().toISOString()
    const stored: StoredDeviceIdentity = {
      schemaVersion: 1,
      publicKey: publicPem,
      protectedPrivateKey: this.protector.protect(privatePem),
      createdAt
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    return { deviceId: deviceIdFor(publicPem), publicKey: publicPem, privateKey: privatePem, createdAt }
  }
}

export { deviceIdFor }
