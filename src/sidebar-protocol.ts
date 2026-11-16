import type { SnapshotOptions } from './injected.ts'
import type { LoadState } from './types.ts'

export const packageName = 'dsh-sidebar-browser-playwrite'
export const channel = '/dsh-sidebar-browser-playwrite'
export const tabKind = 'sidebar-agent-browser'

export type SidebarAction =
  | { kind: 'navigate' | 'openTab'; url: string; waitUntil?: LoadState; domains?: readonly string[] }
  | { kind: 'snapshot'; options?: SnapshotOptions }
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'scroll'; delta: number; ref?: string }
  | { kind: 'back' | 'forward' | 'tabs' | 'close' | 'pageData' }
  | { kind: 'switchTab' | 'closeTab'; index: number }
  | { kind: 'screenshot'; ref?: string; fullPage?: boolean }
  | { kind: 'evaluate'; expression: string }

export interface SidebarCommand {
  id: string
  action: SidebarAction
  deadline: number
}

export type SidebarOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string }
