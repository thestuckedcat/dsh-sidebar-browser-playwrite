import { createElement, useEffect, useRef } from 'react'
import { BrowserError } from './errors.ts'
import { SidebarGuest } from './guest.ts'
import type { DesktopBrowser } from './guest.ts'
import { channel, packageName, tabKind } from './sidebar-protocol.ts'
import type { SidebarAction, SidebarCommand, SidebarOutcome } from './sidebar-protocol.ts'
import { assertAllowedUrl } from './url-policy.ts'
import { abortable } from './abort.ts'

interface PaneProps {
  owner: string
  useTabInfo(): { tab: { id: string; visible: boolean; actions: { close(): void } } }
}

interface ClientContext {
  connection: { rpc: {
    call(channel: string, method: string, payload: object, signal: AbortSignal): Promise<{ ok: boolean; value?: unknown }>
  } }
  uiSession: { adapter: { current: { getSnapshot(): { key?: string }; subscribe(listener: () => void): () => void } } }
  sidebarRight: {
    openTab(kind: string): void
    active(): { id: string } | undefined
    focus(tabId: string): void
    isExpanded(): boolean
    toggleExpanded(): void
  }
  sidebarRightTabs: { register(definition: object): () => void }
  slots: {
    inject(name: string, install: () => () => void): () => void
    register(options: object, component: (props: PaneProps) => ReturnType<typeof createElement>): () => void
  }
  effect(install: () => () => void, name: string): void
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const asMessage = (error: unknown) => error instanceof BrowserError ? error.message : 'The sidebar could not complete this action.'
const manualAction = async () => {}

function button(label: string, title: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.title = title
  element.setAttribute('aria-label', title)
  element.textContent = label
  element.addEventListener('click', action)
  return element
}

class Pages {
  readonly #items: SidebarGuest[] = []
  readonly #lifetime = new AbortController()
  readonly #viewport = document.createElement('div')
  readonly #select = document.createElement('select')
  readonly #address = document.createElement('input')
  readonly #status = document.createElement('div')
  readonly #partitionOwner: string
  #index = 0
  #domains: readonly string[] = []

  constructor(readonly desktop: DesktopBrowser, owner: string, host: HTMLElement, readonly closePane: () => void) {
    this.#partitionOwner = packageName + ':' + owner
    const toolbar = document.createElement('form')
    Object.assign(toolbar.style, { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px' })
    Object.assign(this.#viewport.style, { position: 'relative', flex: '1', minHeight: '0' })
    Object.assign(this.#address.style, { flex: '1', minWidth: '30px' })
    this.#status.setAttribute('role', 'status')
    this.#status.hidden = true
    this.#address.type = 'url'
    this.#address.placeholder = 'https://'
    this.#address.setAttribute('aria-label', 'Page address')
    this.#select.setAttribute('aria-label', 'Browser tabs')
    this.#select.style.maxWidth = '90px'
    this.#select.addEventListener('change', () => this.#selectTab(Number(this.#select.value)))
    const manual = (action: () => void | Promise<unknown>) => {
      void Promise.resolve().then(action).then(() => this.#notice(''), error => this.#notice(asMessage(error)))
    }
    toolbar.append(
      button('‹', 'Back', () => manual(() => this.#active()?.element.goBack())),
      button('›', 'Forward', () => manual(() => this.#active()?.element.goForward())),
      button('↻', 'Reload', () => manual(() => this.#active()?.element.reload())),
      this.#select, this.#address,
      button('+', 'New tab', () => manual(() => this.#open(undefined, this.#lifetime.signal, manualAction))),
      button('×', 'Close tab', () => manual(() => this.#closeTab(this.#index))),
    )
    toolbar.addEventListener('submit', event => {
      event.preventDefault()
      manual(() => this.run({ kind: 'navigate', url: this.#address.value }, this.#lifetime.signal))
    })
    host.append(toolbar, this.#status, this.#viewport)
    this.#render()
  }

  async run(action: SidebarAction, commandSignal: AbortSignal, authorize = manualAction): Promise<unknown> {
    const signal = AbortSignal.any([this.#lifetime.signal, commandSignal])
    signal.throwIfAborted()
    switch (action.kind) {
      case 'tabs':
        return this.#items.map((page, index) => ({ index, ...page.info() }))
      case 'close':
        this.closePane()
        return null
      case 'closeTab':
        this.#closeTab(action.index)
        return null
      case 'switchTab':
      {
        const page = this.#selectTab(action.index)
        return page.snapshot({}, signal, this.#authorizePage(page, authorize))
      }
      case 'openTab':
      case 'navigate': {
        if (action.waitUntil === 'networkidle') {
          throw new BrowserError('ACTION_UNSUPPORTED', 'Use load or domcontentloaded for Electron sidebar navigation.')
        }
        if (action.domains) this.#domains = action.domains
        const page = action.kind === 'openTab' ? undefined : this.#active()
        if (!page) {
          const opened = await this.#open(action.url, signal, authorize)
          return opened.snapshot({}, signal, this.#authorizePage(opened, authorize))
        }
        page.domains = this.#domains
        await page.navigate(action.url, signal, this.#authorizePage(page, authorize))
        return page.snapshot({}, signal, this.#authorizePage(page, authorize))
      }
      default: {
        const active = this.#active()
        if (!active) throw new BrowserError('SIDEBAR_UNAVAILABLE', 'Open a webpage in the sidebar first.')
        return active.action(action, signal, this.#authorizePage(active, authorize))
      }
    }
  }

  dispose(): void {
    this.#lifetime.abort()
    for (const page of this.#items.splice(0)) page.dispose()
  }

  #active() { return this.#items[this.#index] }

  #authorizePage(page: SidebarGuest, authorize: () => Promise<void>) {
    return async () => {
      await authorize()
      if (this.#active() !== page) throw new BrowserError('SIDEBAR_UNAVAILABLE', 'The selected browser tab changed.')
    }
  }

  async #open(url: string | undefined, signal: AbortSignal, authorize: () => Promise<void>, select = true): Promise<SidebarGuest> {
    if (url) assertAllowedUrl(url, this.#domains)
    if (this.#items.length >= 12) throw new BrowserError('ACTION_UNSUPPORTED', 'Close a tab before opening another.')
    const page = new SidebarGuest(this.desktop, this.#partitionOwner, this.#domains,
      () => this.#render(), target => {
        void this.#open(target, this.#lifetime.signal, manualAction, false).catch(error => this.#notice(asMessage(error)))
      })
    const previous = this.#index
    this.#items.push(page)
    if (select) this.#index = this.#items.length - 1
    this.#render()
    try {
      await page.attach(this.#viewport, AbortSignal.any([signal, AbortSignal.timeout(8000)]))
      this.#render()
      signal.throwIfAborted()
      if (url) await page.navigate(url, signal, select ? this.#authorizePage(page, authorize) : authorize)
      return page
    } catch (error) {
      const index = this.#items.indexOf(page)
      if (index >= 0) this.#items.splice(index, 1)
      page.dispose()
      this.#index = Math.max(0, Math.min(previous, this.#items.length - 1))
      this.#render()
      throw error
    }
  }

  #selectTab(index: number): SidebarGuest {
    const page = this.#items[index]
    if (!page) throw new BrowserError('REF_NOT_FOUND', 'No sidebar tab has this index.')
    this.#index = index
    this.#render()
    return page
  }

  #closeTab(index: number): void {
    if (!this.#items[index]) throw new BrowserError('REF_NOT_FOUND', 'No sidebar tab has this index.')
    const [page] = this.#items.splice(index, 1)
    page?.dispose()
    if (index < this.#index) this.#index--
    this.#index = Math.max(0, Math.min(this.#index, this.#items.length - 1))
    this.#render()
  }

  #notice(message: string): void {
    this.#status.textContent = message
    this.#status.hidden = message === ''
  }

  #render(): void {
    this.#select.replaceChildren()
    this.#items.forEach((page, index) => {
      page.element.hidden = index !== this.#index
      page.element.style.display = page.element.hidden ? 'none' : 'flex'
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = page.info().title || 'New tab'
      this.#select.append(option)
    })
    this.#select.value = String(this.#index)
    this.#select.hidden = this.#items.length < 2
    if (document.activeElement !== this.#address) {
      const url = this.#active()?.info().url
      this.#address.value = url && url !== 'about:blank' ? url : ''
    }
  }
}

export const inject = ['connection', 'sidebarRight', 'sidebarRightTabs', 'slots', 'uiSession']

export function apply(ctx: ClientContext): void {
  const desktop = (globalThis as { dshDesktop?: { protocolVersion: number; browser?: DesktopBrowser } }).dshDesktop
  const browser = desktop?.protocolVersion === 1 ? desktop.browser : undefined
  if (!browser) return
  const pages = new Map<string, { id: string; group: Pages; visible(): boolean }[]>()
  const openOccurrence = (owner: string) => {
    const groups = pages.get(owner)
    const selected = ctx.sidebarRight.active()?.id
    return groups?.find(group => group.id === selected) ?? groups?.[0]
  }
  const current = ctx.uiSession.adapter.current
  const activeOwner = () => current.getSnapshot().key
  const receiver = crypto.randomUUID()

  function Pane({ owner, useTabInfo }: PaneProps) {
    const host = useRef<HTMLDivElement>(null)
    const tab = useTabInfo().tab
    const liveTab = useRef(tab)
    liveTab.current = tab
    useEffect(() => {
      if (!host.current) return
      const element = host.current
      const group = new Pages(browser!, owner, element, () => liveTab.current.actions.close())
      const occurrence = { id: tab.id, group, visible: () => liveTab.current.visible && element.getBoundingClientRect().width > 0 }
      const siblings = pages.get(owner) ?? []
      siblings.push(occurrence)
      pages.set(owner, siblings)
      return () => {
        siblings.splice(siblings.indexOf(occurrence), 1)
        if (!siblings.length) pages.delete(owner)
        group.dispose()
        element.replaceChildren()
      }
    }, [owner, tab.id])
    return createElement('div', { ref: host, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } })
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: packageName, kind: tabKind, multiple: false, priority: 'extension', keepMounted: true,
    title: () => 'Agent Browser',
  }), 'register Agent Browser tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: packageName,
    inject: (owner: string) => ({ owner }),
  }, Pane)), 'mount Agent Browser tab')

  ctx.effect(() => {
    const lifetime = new AbortController()
    let busy = false
    const call = async (method: string, owner: string, extra = {}) => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])
      const result = await ctx.connection.rpc.call(channel, method, { owner, receiver, ...extra }, signal)
      if (!result.ok) throw new Error('Sidebar RPC failed')
      return result.value
    }
    async function run(owner: string, command: SidebarCommand): Promise<unknown> {
      const { id, action, deadline } = command
      const selection = new AbortController()
      const cancelled = new AbortController()
      const stop = current.subscribe(() => {
        if (activeOwner() !== owner) selection.abort()
      })
      const signal = AbortSignal.any([lifetime.signal, selection.signal, cancelled.signal,
        AbortSignal.timeout(Math.max(0, deadline - Date.now()))])
      const assertCurrent = () => {
        if (activeOwner() !== owner) throw new BrowserError('SIDEBAR_UNAVAILABLE', 'The active conversation changed.')
        signal.throwIfAborted()
      }
      const confirm = async () => {
        if (!await abortable(call('current', owner, { id }), signal)) {
          cancelled.abort(new BrowserError('ACTION_TIMEOUT', 'The Host cancelled or expired the action.'))
        }
        assertCurrent()
      }
      let checking = false
      const timer = setInterval(() => {
        if (checking || signal.aborted) return
        checking = true
        void confirm().catch(error => cancelled.abort(error)).finally(() => { checking = false })
      }, 250)
      try {
        await confirm()
        let occurrence = openOccurrence(owner)
        if (action.kind === 'tabs' && !occurrence) return []
        if (action.kind === 'close' && !occurrence) return null
        if (!occurrence && action.kind !== 'navigate' && action.kind !== 'openTab') {
          throw new BrowserError('SIDEBAR_UNAVAILABLE', 'Use browser_navigate to open the sidebar first.')
        }
        const reveal = action.kind !== 'tabs' && action.kind !== 'close'
        if (!occurrence) ctx.sidebarRight.openTab(tabKind)
        else if (reveal && !occurrence.visible()) {
          ctx.sidebarRight.focus(occurrence.id)
          if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
        }
        for (let attempt = 0; (!occurrence || (reveal && !occurrence.visible())) && attempt < 50; attempt++) {
          await pause(40)
          assertCurrent()
          occurrence ??= openOccurrence(owner)
        }
        if (!occurrence) throw new BrowserError('SIDEBAR_UNAVAILABLE', 'The Agent Browser tab did not mount.')
        const target = occurrence
        const authorize = async () => {
          await confirm()
          if (reveal && !target.visible()) {
            throw new BrowserError('SIDEBAR_UNAVAILABLE', 'The Agent Browser tab is hidden.')
          }
        }
        await authorize()
        return await abortable(target.group.run(action, signal, authorize), signal) ?? null
      } finally { clearInterval(timer); stop() }
    }
    const poll = async () => {
      const owner = activeOwner()
      if (!owner || busy || lifetime.signal.aborted) return
      busy = true
      try {
        const command = await call('claim', owner) as SidebarCommand | null
        if (!command) return
        let outcome: SidebarOutcome
        try { outcome = { ok: true, value: await run(owner, command) } }
        catch (error) {
          outcome = { ok: false, code: error instanceof BrowserError ? error.code : 'ACTION_FAILED', message: asMessage(error) }
        }
        await call('finish', owner, { id: command.id, outcome })
      } catch {
        // The Host times out a claimed command if its client disconnects.
      } finally { busy = false }
    }
    const timer = setInterval(() => { void poll() }, 350)
    return () => { lifetime.abort(); clearInterval(timer) }
  }, 'receive Agent Browser commands')
}
