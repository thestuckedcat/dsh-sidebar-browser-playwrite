import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import z from '@deepseek-ai/schemastery'
import type {} from './service.ts'
import { SidebarBridge } from './sidebar-bridge.ts'
import { channel } from './sidebar-protocol.ts'
import type { SidebarAction, SidebarOutcome } from './sidebar-protocol.ts'
import type { BrowserProvider, BrowserSession, BrowserSnapshot, LoadState, ScreenshotCapture, TabInfo } from './types.ts'
import { BrowserError } from './errors.ts'
import { assertAllowedUrl } from './url-policy.ts'

export interface SidebarConfig {
  commandTimeoutMs: number
  allowedDomains: string[]
}

export const Config = z.object({
  commandTimeoutMs: z.natural().min(1000).max(120000).default(30000),
  allowedDomains: z.array(z.string()).default([]),
}) as unknown as z<SidebarConfig>

interface HostContext extends Context {
  connection: { admit(req: IncomingMessage): { rejection: number } | { peer: { principal: { kind: string } } } }
  webServer: {
    register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void
  }
}

export const name = 'sidebar-browser'
export const inject = ['browser']

export function apply(ctx: Context, config: SidebarConfig): void {
  const domains = config.allowedDomains.map(domain => domain.trim().toLowerCase().replace(/\.$/, ''))
  ctx.inject(['connection', 'webServer'], scope => {
    const host = scope as HostContext
    const bridge = new SidebarBridge(config.commandTimeoutMs)
    const provider: BrowserProvider = {
      id: 'sidebar',
      available: () => true,
      acquire: async owner => new SidebarSession(owner, bridge, domains),
      disposeOwner: async owner => bridge.cancel(owner),
      dispose: async () => bridge.dispose(),
    }
    scope.browser.registerProvider(provider)
    scope.effect(() => host.webServer.register({
      kind: 'prefix',
      path: channel,
      handler: (req, res) => { void handleRequest(host, bridge, req, res) },
    }), 'register side-panel browser RPC')
  })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

async function handleRequest(ctx: HostContext, bridge: SidebarBridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection).end(); return }
    if (admission.peer.principal.kind !== 'owner') { res.writeHead(403).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > 16 * 1024 * 1024) { res.writeHead(413).end(); return }
      chunks.push(data)
    }
    const envelope = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const payload = record(envelope.payload)
    const { rpcId, method } = envelope
    const { owner, receiver, id } = payload
    if (envelope.type !== 'client-request' || typeof rpcId !== 'string' || typeof method !== 'string'
      || req.url?.split('?')[0] !== channel + '/' + method
      || typeof owner !== 'string' || !owner || owner.length > 256
      || typeof receiver !== 'string' || receiver.length > 64) {
      res.writeHead(400).end()
      return
    }
    let value: unknown
    if (method === 'claim') value = bridge.claim(owner, receiver)
    else if (method === 'current' && typeof id === 'string') value = bridge.isCurrent(owner, receiver, id)
    else if (method === 'finish' && typeof id === 'string') {
      const result = record(payload.outcome)
      let outcome: SidebarOutcome
      if (result.ok === true) outcome = { ok: true, value: result.value }
      else if (result.ok === false && typeof result.code === 'string' && typeof result.message === 'string') {
        outcome = { ok: false, code: result.code, message: result.message.slice(0, 500) }
      } else { res.writeHead(400).end(); return }
      value = bridge.finish(owner, receiver, id, outcome)
    } else { res.writeHead(400).end(); return }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
  } catch {
    if (!res.headersSent) res.writeHead(400)
    res.end()
  }
}

class SidebarSession implements BrowserSession {
  constructor(readonly owner: string, readonly bridge: SidebarBridge, readonly domains: readonly string[]) {}

  #run<T>(action: SidebarAction, signal?: AbortSignal): Promise<T> {
    return this.bridge.run(this.owner, action, signal) as Promise<T>
  }

  #navigate(kind: 'navigate' | 'openTab', raw: string, waitUntil: LoadState, signal?: AbortSignal) {
    const url = assertAllowedUrl(raw, this.domains).href
    return this.#run<BrowserSnapshot>({ kind, url, waitUntil, domains: this.domains }, signal)
  }
  navigate(url: string, waitUntil: LoadState, signal?: AbortSignal) { return this.#navigate('navigate', url, waitUntil, signal) }
  openTab(url: string, waitUntil: LoadState, signal?: AbortSignal) { return this.#navigate('openTab', url, waitUntil, signal) }
  snapshot(options?: { readonly interactiveOnly?: boolean }, signal?: AbortSignal) {
    return this.#run<BrowserSnapshot>({ kind: 'snapshot', ...(options ? { options } : {}) }, signal)
  }
  click(ref: string, signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'click', ref }, signal) }
  fill(ref: string, text: string, signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'fill', ref, text }, signal) }
  press(ref: string, key: string, signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'press', ref, key }, signal) }
  scroll(direction: 'up' | 'down', amount: number, ref?: string, signal?: AbortSignal) {
    return this.#run<BrowserSnapshot>({ kind: 'scroll', delta: direction === 'up' ? -amount : amount, ...(ref ? { ref } : {}) }, signal)
  }
  back(signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'back' }, signal) }
  forward(signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'forward' }, signal) }
  wait(ms: number, signal?: AbortSignal): Promise<void> { return delay(ms, undefined, signal ? { signal } : {}) }
  tabs(signal?: AbortSignal) { return this.#run<readonly TabInfo[]>({ kind: 'tabs' }, signal) }
  switchTab(index: number, signal?: AbortSignal) { return this.#run<BrowserSnapshot>({ kind: 'switchTab', index }, signal) }
  async closeTab(index: number, signal?: AbortSignal) { await this.#run({ kind: 'closeTab', index }, signal) }
  async screenshot(options?: { readonly fullPage?: boolean; readonly ref?: string }, signal?: AbortSignal): Promise<ScreenshotCapture> {
    const { url, data } = await this.#run<{ url: string; data: string }>({ kind: 'screenshot', ...options }, signal)
    return { mime: 'image/png', url, bytes: Buffer.from(data, 'base64') }
  }
  pageData(signal?: AbortSignal) { return this.#run({ kind: 'pageData' }, signal) }
  evaluate(expression: string, signal?: AbortSignal) { return this.#run({ kind: 'evaluate', expression }, signal) }
  async close(signal?: AbortSignal) { await this.#run({ kind: 'close' }, signal) }
}
