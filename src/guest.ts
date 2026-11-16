import { BrowserError } from './errors.ts'
import { SNAPSHOT_SCRIPT } from './injected.ts'
import type { SnapshotOptions } from './injected.ts'
import type { BrowserSnapshot } from './types.ts'
import type { SidebarAction } from './sidebar-protocol.ts'
import { assertAllowedUrl } from './url-policy.ts'
import { abortable } from './abort.ts'

interface Rect { x: number; y: number; width: number; height: number }

export interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoadingMainFrame(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(code: string): Promise<unknown>
  sendInputEvent(event: object): Promise<void>
  capturePage(rect?: Rect): Promise<{ toDataURL(): string }>
}

export interface DesktopBrowser {
  acquire(owner: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, callback: (url: string) => void): () => void
}

type ActionResult<T> = { value: T } | { error: 'REF_NOT_FOUND' | 'ACTION_UNSUPPORTED' | 'URL_NOT_ALLOWED'; message: string }

// This function is serialized into the guest. All arguments cross as JSON;
// the only arbitrary-expression entry is the opt-in evaluate tool.
function interact(input: { action: SidebarAction; domains: readonly string[] }): ActionResult<unknown> {
  const { action, domains } = input
  const { kind } = action
  const ref = 'ref' in action ? action.ref : undefined
  let element: HTMLElement | undefined
  if (ref) {
    const documents = [document]
    for (let index = 0; index < documents.length && !element && index < 32; index++) {
      const root = documents[index]!
      element = root.querySelector<HTMLElement>('[data-dsh-ref="' + CSS.escape(ref) + '"]') ?? undefined
      for (const frame of root.querySelectorAll('iframe')) {
        if (frame.contentDocument) documents.push(frame.contentDocument)
      }
    }
    if (!element?.isConnected || !element.getClientRects().length) {
      return { error: 'REF_NOT_FOUND', message: 'That reference is stale or hidden. Take a new snapshot.' }
    }
  }
  if (kind === 'scroll') {
    if (element) element.scrollIntoView({ block: 'nearest' })
    window.scrollBy(0, action.delta)
    return { value: null }
  }
  if (!element) return { error: 'REF_NOT_FOUND', message: 'An element reference is required.' }
  if (kind === 'click') {
    if (element.matches(':disabled, [aria-disabled="true"]')) {
      return { error: 'ACTION_UNSUPPORTED', message: 'The element is disabled.' }
    }
    const anchor = element.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) {
      const url = new URL(anchor.href)
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (domains.length > 0 && !domains.some(domain => host === domain || host.endsWith('.' + domain)))) {
        return { error: 'URL_NOT_ALLOWED', message: 'The link target is outside the navigation policy.' }
      }
    }
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = element.getBoundingClientRect()
    let x = Math.floor(rect.left + rect.width / 2)
    let y = Math.floor(rect.top + rect.height / 2)
    const hit = element.ownerDocument.elementFromPoint(x, y)
    if (!hit || !element.contains(hit)) {
      return { error: 'ACTION_UNSUPPORTED', message: 'The target is outside the viewport or covered.' }
    }
    let root = element.ownerDocument
    while (root !== document) {
      const frame = root.defaultView?.frameElement
      if (!frame) return { error: 'ACTION_UNSUPPORTED', message: 'The frame target is unavailable.' }
      const position = frame.getBoundingClientRect()
      x += Math.floor(position.left + frame.clientLeft)
      y += Math.floor(position.top + frame.clientTop)
      root = frame.ownerDocument
      if (root.elementFromPoint(x, y) !== frame) {
        return { error: 'ACTION_UNSUPPORTED', message: 'The frame is outside the viewport or covered.' }
      }
    }
    return { value: { x, y } }
  }
  if (kind === 'fill') {
    const view = element.ownerDocument.defaultView ?? window
    const tag = element.tagName.toLowerCase()
    const control = element as HTMLInputElement
    if (control.disabled || control.readOnly || /^(file|password)$/i.test(control.type ?? '')) {
      return { error: 'ACTION_UNSUPPORTED', message: 'Use the sidebar directly for this input.' }
    }
    element.focus()
    if (tag === 'select') {
      const select = element as HTMLSelectElement
      const option = Array.from(select.options).find(item => item.label === action.text && !item.disabled)
      if (!option) return { error: 'REF_NOT_FOUND', message: 'No enabled option has that label.' }
      select.selectedIndex = option.index
    } else if (tag === 'input' || tag === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
      if (!setter) return { error: 'ACTION_UNSUPPORTED', message: 'The field cannot be filled.' }
      setter.call(element, action.text)
    } else if (element.isContentEditable) {
      element.textContent = action.text
    } else return { error: 'ACTION_UNSUPPORTED', message: 'The element is not a text or select field.' }
    element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }))
    element.dispatchEvent(new view.Event('change', { bubbles: true }))
    return { value: null }
  }
  element.scrollIntoView({ block: 'center' })
  if (kind === 'press') {
    element.focus()
    return { value: null }
  }
  if (element.ownerDocument !== document) {
    return { error: 'ACTION_UNSUPPORTED', message: 'Element screenshots inside frames are unsupported.' }
  }
  const bounds = element.getBoundingClientRect()
  const x = Math.max(0, Math.floor(bounds.x))
  const y = Math.max(0, Math.floor(bounds.y))
  return { value: { x, y, width: Math.floor(Math.min(innerWidth, bounds.right) - x),
    height: Math.floor(Math.min(innerHeight, bounds.bottom) - y) } }
}

const callSource = (fn: Function, args: unknown) => '(' + fn.toString() + ')(' + JSON.stringify(args) + ')'
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class SidebarGuest {
  readonly element = document.createElement('webview') as Webview
  domains: readonly string[]
  #lease?: string
  #unsubscribe?: () => void
  #disposed = false
  #navigation = 0
  #events = new AbortController()

  constructor(readonly desktop: DesktopBrowser, readonly partitionOwner: string, domains: readonly string[],
    onChange: () => void, onPopup: (url: string) => void) {
    this.domains = domains
    this.element.dataset.sidebarAgentWebview = 'true'
    this.element.setAttribute('aria-label', 'Agent browser page')
    Object.assign(this.element.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
    this.element.addEventListener('did-start-navigation', event => {
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame) this.#navigation++
    }, { signal: this.#events.signal })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) {
      this.element.addEventListener(event, onChange, { signal: this.#events.signal })
    }
    this.onPopup = onPopup
  }
  private readonly onPopup: (url: string) => void

  async attach(host: HTMLElement, signal: AbortSignal): Promise<void> {
    const reservation = await this.desktop.acquire(this.partitionOwner)
    if (signal.aborted || this.#disposed) {
      await this.desktop.release(reservation.lease)
      throw new BrowserError('SESSION_CLOSED', 'The sidebar closed during initialization.')
    }
    this.#lease = reservation.lease
    this.element.setAttribute('partition', reservation.partition)
    this.element.setAttribute('name', reservation.lease)
    this.element.setAttribute('allowpopups', '')
    this.element.setAttribute('src', 'about:blank#' + reservation.lease)
    this.#unsubscribe = this.desktop.onOpenRequested(reservation.lease, this.onPopup)
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      const ready = () => { signal.removeEventListener('abort', aborted); resolve() }
      signal.addEventListener('abort', aborted, { once: true })
      this.element.addEventListener('dom-ready', ready, { once: true, signal })
      host.append(this.element)
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#events.abort()
    this.#unsubscribe?.()
    this.element.remove()
    if (this.#lease) void this.desktop.release(this.#lease).catch(() => {})
  }

  info(): { url: string; title: string } {
    try {
      const url = this.element.getURL()
      return { url: url.startsWith('about:blank#') ? 'about:blank' : url, title: this.element.getTitle() }
    } catch { return { url: 'about:blank', title: '' } }
  }

  async navigate(raw: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<void> {
    const url = assertAllowedUrl(raw, this.domains).href
    await authorize()
    signal.throwIfAborted()
    const stop = () => { try { this.element.stop() } catch { /* guest already detached */ } }
    signal.addEventListener('abort', stop, { once: true })
    try { await abortable(this.element.loadURL(url), signal) }
    finally { signal.removeEventListener('abort', stop) }
    this.checkLocation()
  }

  checkLocation(): void {
    const { url } = this.info()
    if (url !== 'about:blank') assertAllowedUrl(url, this.domains)
  }

  async snapshot(options: SnapshotOptions = {}, signal?: AbortSignal,
    authorize?: () => Promise<void>): Promise<BrowserSnapshot> {
    await this.settle(signal)
    await authorize?.()
    signal?.throwIfAborted()
    this.assertShown()
    this.checkLocation()
    const snapshot = await this.element.executeJavaScript(SNAPSHOT_SCRIPT + '\nwindow.__dshSnapshot(' + JSON.stringify(options) + ')')
    this.checkLocation()
    return { ...snapshot as Omit<BrowserSnapshot, 'url' | 'title'>, ...this.info() }
  }

  async settle(signal?: AbortSignal): Promise<void> {
    // Give any synchronously triggered navigation an event-loop turn.
    await delay(30)
    while (this.element.isLoadingMainFrame()) {
      signal?.throwIfAborted()
      if (this.#disposed) throw new BrowserError('SESSION_CLOSED', 'The side panel was closed.')
      await delay(50)
    }
    signal?.throwIfAborted()
  }

  async action(action: SidebarAction, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown> {
    if (action.kind === 'snapshot') return this.snapshot(action.options, signal, authorize)
    await this.settle(signal)
    await authorize()
    signal.throwIfAborted()
    this.assertShown()
    this.checkLocation()
    switch (action.kind) {
      case 'click': {
        const navigation = this.#navigation
        const coordinates = await this.interact<{ x: number; y: number }>(action)
        this.assertInputTarget(navigation, signal)
        signal.throwIfAborted()
        this.element.focus()
        const pointer = { ...coordinates, button: 'left', clickCount: 1 }
        await this.element.sendInputEvent({ type: 'mouseDown', ...pointer })
        await this.element.sendInputEvent({ type: 'mouseUp', ...pointer })
        return this.snapshot({}, signal, authorize)
      }
      case 'fill':
      case 'scroll':
        await this.interact(action)
        return this.snapshot({}, signal, authorize)
      case 'press': {
        const navigation = this.#navigation
        await this.interact(action)
        this.assertInputTarget(navigation, signal)
        const parts = action.key.split('+')
        const key = parts.pop() ?? ''
        const modifiers = parts.map(part => part.toLowerCase().replace(/^ctrl$/, 'control'))
        if (!key || modifiers.some(part => !['control', 'alt', 'shift', 'meta'].includes(part))) {
          throw new BrowserError('ACTION_UNSUPPORTED', 'Unsupported key combination.')
        }
        const keyCode = key.replace(/^Arrow/, '')
        this.element.focus()
        this.assertInputTarget(navigation, signal)
        await this.element.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        if (key.length === 1 && !modifiers.length) await this.element.sendInputEvent({ type: 'char', keyCode })
        await this.element.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        return this.snapshot({}, signal, authorize)
      }
      case 'back':
        if (this.element.canGoBack()) this.element.goBack()
        return this.snapshot({}, signal, authorize)
      case 'forward':
        if (this.element.canGoForward()) this.element.goForward()
        return this.snapshot({}, signal, authorize)
      case 'screenshot': {
        if (action.fullPage) throw new BrowserError('ACTION_UNSUPPORTED', 'Use viewport or element capture in the sidebar.')
        const { url } = this.info()
        const rect = action.ref ? await this.interact<Rect>(action) : undefined
        if (rect && (rect.width < 1 || rect.height < 1)) throw new BrowserError('REF_NOT_FOUND', 'The element is outside the viewport.')
        const capture = await this.element.capturePage(rect)
        if (this.info().url !== url) throw new BrowserError('ACTION_FAILED', 'The page changed during capture. Try again.')
        const data = capture.toDataURL().split(',', 2)[1]
        if (!data || data.length > 15 * 1024 * 1024) throw new BrowserError('ACTION_FAILED', 'The viewport capture is empty or too large.')
        return { url, data }
      }
      case 'pageData':
        return this.element.executeJavaScript(SNAPSHOT_SCRIPT + '\nwindow.__dshPageData({})')
      case 'evaluate':
        return this.element.executeJavaScript('(' + action.expression + ')')
      default:
        throw new BrowserError('ACTION_UNSUPPORTED', 'This command targets the sidebar tab group.')
    }
  }

  private assertShown(): void {
    if (!this.element.isConnected || this.element.getBoundingClientRect().width < 1) {
      throw new BrowserError('SIDEBAR_UNAVAILABLE', 'The selected guest is no longer visible.')
    }
  }

  private assertInputTarget(navigation: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.assertShown()
    if (navigation !== this.#navigation) throw new BrowserError('REF_NOT_FOUND', 'The webpage changed. Take a new snapshot.')
    this.checkLocation()
  }

  private async unwrap<T>(operation: Promise<unknown>): Promise<T> {
    const result = await operation as ActionResult<T>
    if ('error' in result) throw new BrowserError(result.error, result.message)
    return result.value
  }

  private interact<T>(action: SidebarAction): Promise<T> {
    return this.unwrap(this.element.executeJavaScript(callSource(interact, { action, domains: this.domains })))
  }
}
