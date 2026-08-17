import { safeStorage } from 'electron'
import type { DeviceKeyProtector } from './device-identity'

const PREFIX = 'safe-storage:v1:'
const LEGACY_MAC_PREFIX = 'keychain:v1:'

function protectionLabel(): string {
  return process.platform === 'win32' ? 'Windows DPAPI' : process.platform === 'darwin' ? 'macOS 钥匙串' : '系统安全存储'
}

export class ElectronDeviceKeyProtector implements DeviceKeyProtector {
  protect(value: string): string {
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('当前系统不支持 Prism Pro 设备密钥保护')
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`${protectionLabel()}当前不可用，不能安全创建设备身份`)
    return `${PREFIX}${safeStorage.encryptString(value).toString('base64')}`
  }

  unprotect(value: string): string {
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('当前系统不支持 Prism Pro 设备密钥保护')
    const prefix = value.startsWith(PREFIX) ? PREFIX
      : process.platform === 'darwin' && value.startsWith(LEGACY_MAC_PREFIX) ? LEGACY_MAC_PREFIX
        : null
    if (!prefix || !safeStorage.isEncryptionAvailable()) {
      throw new Error(`设备私钥未由${protectionLabel()}保护或安全存储当前不可用`)
    }
    return safeStorage.decryptString(Buffer.from(value.slice(prefix.length), 'base64'))
  }
}
