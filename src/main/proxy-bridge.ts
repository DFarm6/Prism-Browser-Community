import proxyChain from 'proxy-chain'
import { isIP } from 'node:net'
import type { ProxyConfig } from '../shared/types'

export interface ProxyBridgeObserver {
  onFailure?: (error: unknown) => void
  onTraffic?: () => void
}

const bridges = new Map<string, proxyChain.Server>()

export function upstreamProxyUrl(proxy: ProxyConfig): string | undefined {
  if (proxy.protocol === 'direct') return undefined
  const credentials = proxy.username || proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const host = isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${credentials}${host}:${proxy.port}`
}

export async function openProxyBridge(proxy: ProxyConfig, observer: ProxyBridgeObserver = {}): Promise<string | undefined> {
  const upstream = upstreamProxyUrl(proxy)
  if (!upstream) return undefined
  const server = new proxyChain.Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream })
  })
  server.on('requestFailed', ({ error }: { error: unknown }) => observer.onFailure?.(error))
  server.on('connectionClosed', ({ stats }: { stats?: proxyChain.ConnectionStats }) => {
    const transferred = (stats?.trgRxBytes ?? 0) + (stats?.trgTxBytes ?? 0)
    if (transferred > 0) observer.onTraffic?.()
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.port}`
  bridges.set(url, server)
  return url
}

export async function closeProxyBridge(url?: string): Promise<void> {
  if (!url) return
  const server = bridges.get(url)
  bridges.delete(url)
  await server?.close(true).catch(() => undefined)
}
