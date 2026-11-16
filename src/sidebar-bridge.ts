import { randomUUID } from 'node:crypto'
import { BrowserError } from './errors.ts'
import type { BrowserErrorCode } from './errors.ts'
import type { SidebarAction, SidebarCommand, SidebarOutcome } from './sidebar-protocol.ts'

interface Pending {
  command: SidebarCommand
  receiver?: string
  complete(outcome?: SidebarOutcome, error?: unknown): void
}

const clientErrors = new Set<string>([
  'ACTION_FAILED', 'ACTION_TIMEOUT', 'ACTION_UNSUPPORTED', 'REF_NOT_FOUND',
  'SESSION_CLOSED', 'SIDEBAR_UNAVAILABLE', 'URL_NOT_ALLOWED',
])

export class SidebarBridge {
  readonly #pending = new Map<string, Pending>()
  readonly #timeoutMs: number

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs
  }

  run(owner: string, action: SidebarAction, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.#pending.has(owner)) {
      return Promise.reject(new BrowserError('SIDEBAR_BUSY', 'Another browser action is in progress for this session.'))
    }
    return new Promise((resolve, reject) => {
      const command = { id: randomUUID(), action, deadline: Date.now() + this.#timeoutMs }
      const abort = () => pending.complete(undefined, signal?.reason)
      const timer = setTimeout(() => {
        pending.complete(undefined, new BrowserError('ACTION_TIMEOUT',
          pending.receiver === undefined
            ? 'No DSH Desktop client claimed the action. Show its conversation and retry.'
            : 'The sidebar did not confirm the action in time. Inspect the page before retrying.'))
      }, this.#timeoutMs)
      const pending: Pending = {
        command,
        complete: (outcome, error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          this.#pending.delete(owner)
          if (outcome?.ok) resolve(outcome.value)
          else if (outcome) {
            const code = clientErrors.has(outcome.code) ? outcome.code as BrowserErrorCode : 'ACTION_FAILED'
            reject(new BrowserError(code, outcome.message))
          } else reject(error)
        },
      }
      this.#pending.set(owner, pending)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  claim(owner: string, receiver: string): SidebarCommand | null {
    const pending = this.#pending.get(owner)
    if (!pending || pending.receiver !== undefined || Date.now() >= pending.command.deadline) return null
    pending.receiver = receiver
    return pending.command
  }

  isCurrent(owner: string, receiver: string, id: string): boolean {
    const pending = this.#pending.get(owner)
    return pending?.command.id === id && pending.receiver === receiver && Date.now() < pending.command.deadline
  }

  finish(owner: string, receiver: string, id: string, outcome: SidebarOutcome): boolean {
    if (!this.isCurrent(owner, receiver, id)) return false
    this.#pending.get(owner)?.complete(outcome)
    return true
  }

  cancel(owner: string): void {
    this.#pending.get(owner)?.complete(undefined, new BrowserError('SESSION_CLOSED', 'The browser session closed.'))
  }

  dispose(): void {
    for (const owner of this.#pending.keys()) this.cancel(owner)
  }
}
