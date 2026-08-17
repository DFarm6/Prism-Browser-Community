import { createServer } from 'node:http'
import { createConnection, createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import proxyChain from 'proxy-chain'
import { ProxyAgent, request } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import { closeProxyBridge, openProxyBridge, upstreamProxyUrl } from './proxy-bridge'

async function authenticatedSocks5Server(username: string, password: string): Promise<TcpServer> {
  const server = createTcpServer((client) => {
    let stage: 'greeting' | 'authentication' | 'request' | 'relay' = 'greeting'
    let buffered = Buffer.alloc(0)
    client.on('data', (chunk) => {
      if (stage === 'relay') return
      buffered = Buffer.concat([buffered, chunk])
      if (stage === 'greeting') {
        if (buffered.length < 2) return
        if (buffered.length < 2 + buffered[1]) return
        buffered = buffered.subarray(2 + buffered[1])
        client.write(Buffer.from([5, 2]))
        stage = 'authentication'
      }
      if (stage === 'authentication') {
        if (buffered.length < 2) return
        const usernameLength = buffered[1]
        if (buffered.length < 2 + usernameLength + 1) return
        const passwordLength = buffered[2 + usernameLength]
        if (buffered.length < 3 + usernameLength + passwordLength) return
        const actualUsername = buffered.subarray(2, 2 + usernameLength).toString()
        const actualPassword = buffered.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString()
        buffered = buffered.subarray(3 + usernameLength + passwordLength)
        if (actualUsername !== username || actualPassword !== password) {
          client.end(Buffer.from([1, 1]))
          return
        }
        client.write(Buffer.from([1, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buffered.length < 7) return
        const addressType = buffered[3]
        let host = ''
        let offset = 4
        if (addressType === 1) {
          if (buffered.length < 10) return
          host = [...buffered.subarray(offset, offset + 4)].join('.')
          offset += 4
        } else if (addressType === 3) {
          const length = buffered[offset]
          if (buffered.length < offset + 1 + length + 2) return
          host = buffered.subarray(offset + 1, offset + 1 + length).toString()
          offset += 1 + length
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
          return
        }
        const port = buffered.readUInt16BE(offset)
        const upstream = createConnection({ host, port })
        upstream.once('connect', () => {
          stage = 'relay'
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.once('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

describe('upstreamProxyUrl', () => {
  it('keeps direct connections free of proxy flags', () => {
    expect(upstreamProxyUrl({ protocol: 'direct', host: '', username: '', password: '' })).toBeUndefined()
  })

  it('safely encodes proxy credentials', () => {
    expect(upstreamProxyUrl({
      protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'user@example.com', password: 'p@ss/word'
    })).toBe('socks5://user%40example.com:p%40ss%2Fword@proxy.example.com:1080')
  })

  it('brackets IPv6 upstreams and does not silently drop password-only credentials', () => {
    expect(upstreamProxyUrl({
      protocol: 'https', host: '2001:db8::15', port: 8443, username: '', password: 'token'
    })).toBe('https://:token@[2001:db8::15]:8443')
  })

  it('passes Basic authentication to an upstream HTTP proxy', async () => {
    const target = createServer((_request, response) => response.end('authenticated'))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetAddress = target.address()
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target server did not start')
    const upstream = new proxyChain.Server({
      host: '127.0.0.1',
      port: 0,
      prepareRequestFunction: ({ username, password }) => ({
        requestAuthentication: username !== 'proxy-user' || password !== 'p@ss/word'
      })
    })
    await upstream.listen()
    const bridge = await openProxyBridge({
      protocol: 'http',
      host: '127.0.0.1',
      port: upstream.port,
      username: 'proxy-user',
      password: 'p@ss/word'
    })
    const dispatcher = new ProxyAgent(bridge!)
    try {
      const response = await request(`http://127.0.0.1:${targetAddress.port}/`, { dispatcher })
      expect(await response.body.text()).toBe('authenticated')
    } finally {
      await dispatcher.close().catch(() => undefined)
      await closeProxyBridge(bridge)
      await upstream.close(true)
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('relays through an authenticated SOCKS5 upstream without local DNS fallback', async () => {
    const target = createServer((_request, response) => response.end('socks-ok'))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetAddress = target.address()
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target server did not start')
    const socks = await authenticatedSocks5Server('socks-user', 'socks-password')
    const socksAddress = socks.address()
    if (!socksAddress || typeof socksAddress === 'string') throw new Error('SOCKS server did not start')
    const bridge = await openProxyBridge({
      protocol: 'socks5',
      host: '127.0.0.1',
      port: socksAddress.port,
      username: 'socks-user',
      password: 'socks-password'
    })
    const dispatcher = new ProxyAgent(bridge!)
    try {
      const response = await request(`http://127.0.0.1:${targetAddress.port}/`, { dispatcher })
      expect(await response.body.text()).toBe('socks-ok')
    } finally {
      await dispatcher.close().catch(() => undefined)
      await closeProxyBridge(bridge)
      await new Promise<void>((resolve, reject) => socks.close((error) => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('relays traffic through an observable and closable local bridge', async () => {
    const target = createServer((_request, response) => response.end('bridge-ok'))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetAddress = target.address()
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target server did not start')
    const upstream = new proxyChain.Server({ host: '127.0.0.1', port: 0 })
    await upstream.listen()
    const onTraffic = vi.fn()
    const bridge = await openProxyBridge({
      protocol: 'http', host: '127.0.0.1', port: upstream.port, username: '', password: ''
    }, { onTraffic })
    const dispatcher = new ProxyAgent(bridge!)
    try {
      const response = await request(`http://127.0.0.1:${targetAddress.port}/`, { dispatcher })
      expect(await response.body.text()).toBe('bridge-ok')
      await dispatcher.close()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(onTraffic).toHaveBeenCalled()
    } finally {
      await dispatcher.close().catch(() => undefined)
      await closeProxyBridge(bridge)
      await upstream.close(true)
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()))
    }
  })
})
