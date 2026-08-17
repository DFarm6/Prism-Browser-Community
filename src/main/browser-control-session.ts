import type { Readable, Writable } from 'node:stream'

const MAX_PAGE_NODES = 300
const MAX_PAGE_TEXT = 24_000
const MAX_INPUT_TEXT = 4_000
const ACTIONABLE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox'
])
const EDITABLE_ROLES = new Set(['combobox', 'searchbox', 'spinbutton', 'textbox'])

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface CdpMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
}

export interface CdpTransport {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  close(): void
}

export class PipeCdpTransport implements CdpTransport {
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private closed = false
  private readonly pending = new Map<number, PendingCommand>()

  constructor(private readonly readable: Readable, private readonly writable: Writable) {
    readable.on('data', (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    readable.once('close', () => this.rejectAll(new Error('浏览器控制管道已关闭')))
    readable.once('error', (error) => this.rejectAll(error))
    writable.once('error', (error) => this.rejectAll(error))
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('浏览器控制管道不可用'))
    const id = ++this.sequence
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器操作超时：${method}`))
      }, 20_000)
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject
      })
      this.writable.write(`${JSON.stringify(payload)}\0`)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.writable.end()
    this.readable.destroy()
    this.rejectAll(new Error('浏览器控制管道已关闭'))
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const delimiter = this.buffer.indexOf(0)
      if (delimiter < 0) return
      const text = this.buffer.subarray(0, delimiter).toString('utf8')
      this.buffer = this.buffer.subarray(delimiter + 1)
      if (!text) continue
      let message: CdpMessage
      try { message = JSON.parse(text) as CdpMessage }
      catch { this.rejectAll(new Error('浏览器控制协议返回了无效消息')); continue }
      if (!message.id) continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? '浏览器操作失败'))
      else pending.resolve(message.result)
    }
  }

  private rejectAll(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
}

interface AxValue { value?: unknown }
interface AxNode {
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  backendDOMNodeId?: number
  properties?: Array<{ name: string; value?: AxValue }>
}

interface ElementReference {
  backendNodeId: number
  role: string
  sessionId: string
  targetId: string
}

function boundedText(value: unknown, maximum = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) : ''
}

function validateWebUrl(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) throw new Error('网址长度无效')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP 只允许打开 HTTP 或 HTTPS 网页')
  if (url.username || url.password) throw new Error('网址中不能包含账号或密码')
  return url.toString()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class BrowserControlSession {
  private targetId?: string
  private sessionId?: string
  private snapshotVersion = 0
  private readonly references = new Map<string, ElementReference>()

  constructor(private readonly cdp: CdpTransport) {}

  async open(urlValue: string): Promise<{ url: string; title: string; readyState: string }> {
    const url = validateWebUrl(urlValue)
    const created = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    await this.attach(created.targetId)
    const navigation = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url }, this.sessionId)
    if (navigation.errorText) throw new Error(`无法打开网页：${navigation.errorText}`)
    await this.waitForDocument()
    this.references.clear()
    return this.pageState()
  }

  async snapshot(): Promise<{
    url: string
    title: string
    readyState: string
    elements: Array<Record<string, unknown>>
    truncated: boolean
  }> {
    await this.ensurePage()
    const tree = await this.cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, this.sessionId)
    this.references.clear()
    this.snapshotVersion += 1
    const elements: Array<Record<string, unknown>> = []
    let textLength = 0
    let truncated = false
    for (const node of tree.nodes ?? []) {
      if (node.ignored) continue
      const role = boundedText(node.role?.value, 80).toLowerCase()
      const name = boundedText(node.name?.value)
      const actionable = ACTIONABLE_ROLES.has(role) && Number.isInteger(node.backendDOMNodeId)
      if (!name && !actionable) continue
      if (elements.length >= MAX_PAGE_NODES || textLength + name.length > MAX_PAGE_TEXT) {
        truncated = true
        break
      }
      const item: Record<string, unknown> = { role: role || 'text' }
      if (name) item.name = name
      const properties = new Map((node.properties ?? []).map((property) => [property.name, property.value?.value]))
      for (const property of ['checked', 'disabled', 'expanded', 'selected']) {
        if (properties.has(property)) item[property] = properties.get(property)
      }
      if (actionable) {
        const ref = `p${this.snapshotVersion}-e${this.references.size + 1}`
        item.ref = ref
        this.references.set(ref, {
          backendNodeId: node.backendDOMNodeId!, role, sessionId: this.sessionId!, targetId: this.targetId!
        })
      }
      elements.push(item)
      textLength += name.length
    }
    return { ...(await this.pageState()), elements, truncated }
  }

  async click(ref: string): Promise<{ url: string; title: string; readyState: string }> {
    const reference = this.reference(ref)
    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: reference.backendNodeId }, reference.sessionId)
    const { model } = await this.cdp.send<{ model: { border?: number[]; content?: number[] } }>(
      'DOM.getBoxModel', { backendNodeId: reference.backendNodeId }, reference.sessionId
    )
    const quad = model.content ?? model.border
    if (!quad || quad.length !== 8) throw new Error('目标元素当前不可点击')
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, reference.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, reference.sessionId)
    this.references.clear()
    await delay(150)
    return this.pageState()
  }

  async type(ref: string, text: string, clear = true): Promise<{ url: string; title: string; readyState: string }> {
    if (typeof text !== 'string' || text.length > MAX_INPUT_TEXT) throw new Error(`输入文本不能超过 ${MAX_INPUT_TEXT} 个字符`)
    const reference = this.reference(ref)
    if (!EDITABLE_ROLES.has(reference.role)) throw new Error('目标元素不支持文本输入')
    await this.cdp.send('DOM.focus', { backendNodeId: reference.backendNodeId }, reference.sessionId)
    if (clear) {
      const modifiers = process.platform === 'darwin' ? 4 : 2
      const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control'
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifierKey, modifiers }, reference.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers }, reference.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers }, reference.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifierKey }, reference.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' }, reference.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' }, reference.sessionId)
    }
    await this.cdp.send('Input.insertText', { text }, reference.sessionId)
    this.references.clear()
    return this.pageState()
  }

  close(): void {
    this.references.clear()
    this.cdp.close()
  }

  private async ensurePage(): Promise<void> {
    if (this.targetId && this.sessionId) {
      try {
        await this.cdp.send('Target.getTargetInfo', { targetId: this.targetId })
        return
      } catch {
        this.targetId = undefined
        this.sessionId = undefined
      }
    }
    const targets = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    const pages = (targets.targetInfos ?? []).filter((target) => target.type === 'page' && !target.url.startsWith('devtools:'))
    const target = pages[pages.length - 1] ?? await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    await this.attach(target.targetId)
  }

  private async attach(targetId: string): Promise<void> {
    const attached = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    this.targetId = targetId
    this.sessionId = attached.sessionId
    await Promise.all([
      this.cdp.send('Page.enable', {}, attached.sessionId),
      this.cdp.send('DOM.enable', {}, attached.sessionId),
      this.cdp.send('Accessibility.enable', {}, attached.sessionId)
    ])
  }

  private reference(ref: string): ElementReference {
    if (typeof ref !== 'string' || !/^p\d+-e\d+$/.test(ref)) throw new Error('页面元素引用无效')
    const reference = this.references.get(ref)
    if (!reference || reference.targetId !== this.targetId || reference.sessionId !== this.sessionId) {
      throw new Error('页面元素引用已失效，请重新读取页面')
    }
    return reference
  }

  private async pageState(): Promise<{ url: string; title: string; readyState: string }> {
    await this.ensurePage()
    const result = await this.cdp.send<{
      result?: { value?: { url?: string; title?: string; readyState?: string } }
      exceptionDetails?: unknown
    }>('Runtime.evaluate', {
      expression: '({url: location.href, title: document.title, readyState: document.readyState})',
      returnByValue: true
    }, this.sessionId)
    if (result.exceptionDetails) throw new Error('无法读取当前页面状态')
    return {
      url: boundedText(result.result?.value?.url, 2_048),
      title: boundedText(result.result?.value?.title, 500),
      readyState: boundedText(result.result?.value?.readyState, 40) || 'unknown'
    }
  }

  private async waitForDocument(): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const state = await this.pageState().catch(() => null)
      if (state?.readyState === 'complete' && state.url && state.url !== 'about:blank') return
      await delay(100)
    }
    throw new Error('等待网页加载完成超时')
  }
}
