import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SidebarBridge } from '../src/sidebar-bridge.ts'
import { abortable } from '../src/abort.ts'

test('a command reaches only its owning session and one client can complete it', async () => {
  const bridge = new SidebarBridge(500)
  const request = bridge.run('session-a', { kind: 'navigate', url: 'https://example.com' })
  assert.equal(bridge.claim('session-b', 'other'), null)
  const command = bridge.claim('session-a', 'first')
  assert.ok(command)
  assert.deepEqual(command.action, { kind: 'navigate', url: 'https://example.com' })
  assert.equal(bridge.claim('session-a', 'second'), null)
  assert.equal(bridge.finish('session-a', 'second', command.id, { ok: true, value: 'wrong' }), false)
  assert.equal(bridge.finish('session-a', 'first', command.id, { ok: true, value: 'correct' }), true)
  assert.equal(await request, 'correct')
})

test('a queued or claimed command is cleared on abort and late completions cannot settle the next one', async () => {
  const bridge = new SidebarBridge(500)
  const controller = new AbortController()
  const request = bridge.run('session-a', { kind: 'snapshot' }, controller.signal)
  const old = bridge.claim('session-a', 'first')
  assert.ok(old)
  assert.equal(bridge.isCurrent('session-a', 'first', old.id), true)
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(bridge.isCurrent('session-a', 'first', old.id), false)
  const next = bridge.run('session-a', { kind: 'snapshot' })
  const command = bridge.claim('session-a', 'first')
  assert.ok(command)
  assert.equal(bridge.finish('session-a', 'first', old.id, { ok: true, value: 'late' }), false)
  assert.equal(bridge.finish('session-a', 'first', command.id, { ok: true, value: 'new' }), true)
  assert.equal(await next, 'new')
})

test('an absent desktop client times out and the request cannot be opened later', async () => {
  const bridge = new SidebarBridge(20)
  await assert.rejects(bridge.run('session-a', { kind: 'snapshot' }), { code: 'ACTION_TIMEOUT' })
  assert.equal(bridge.claim('session-a', 'late'), null)
})

test('a non-cooperative guest operation stops blocking the receiver on cancellation', async () => {
  const controller = new AbortController()
  let finish!: (value: string) => void
  const pending = new Promise<string>(resolve => { finish = resolve })
  const action = abortable(pending, controller.signal)
  controller.abort()
  await assert.rejects(action, { name: 'AbortError' })
  finish('late result')
  assert.equal(await abortable(Promise.resolve('next result'), new AbortController().signal), 'next result')
})
