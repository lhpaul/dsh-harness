import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempHomeDir } from './helpers.mjs'
import { workspaceBrowseList, installWorkspaceBrowse } from '../packages/workspace-roots/src/directory-picker.js'

test('browse lists bounded workspace leaves, preserves folders and cancellation', async () => {
  const [base, cleanup] = tempHomeDir()
  try {
    const folder = join(base, 'a-folder')
    mkdirSync(folder)
    const file = join(base, 'b.code-workspace')
    writeFileSync(file, '{}')
    writeFileSync(join(base, 'ignore.txt'), '')
    const upstream = async (path = base) => ({ path, home: base, crumbs: [],
      entries: [{ name: 'a-folder', path: folder, hidden: false }], truncated: false })
    const list = workspaceBrowseList(upstream, 2)
    assert.deepEqual((await list(base)).entries.map(e => e.name), ['a-folder', 'b.code-workspace'])
    const leaf = await list(file)
    assert.equal(leaf.path, file)
    assert.deepEqual(leaf.entries, [])
    assert.equal(leaf.crumbs.at(-1).path, file)
    const bounded = await workspaceBrowseList(upstream, 1)(base)
    assert.equal(bounded.entries.length, 1)
    assert.equal(bounded.truncated, true)
    const abort = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(list(base, abort), /cancelled/)
  } finally { cleanup() }
})

test('browse create resolves, titles and reuses workspace, rejects invalid files and restores seams', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  const workspaceFile = join(base, 'Project.code-workspace')
  writeFileSync(workspaceFile, '{}')
  const calls = []
  const capability = { list: async () => ({}) }
  const list = capability.list
  const controller = { async create(request) { calls.push(request.path); return request } }
  const create = controller.create
  const policy = { async openPicked(path) {
    if (path === '/invalid.code-workspace') throw new Error('invalid scope')
    return path.endsWith('.code-workspace') ? '/scope/repo' : path
  } }
  const registry = { async resolveByPath() { return undefined },
    async create(path, title) { calls.push([path, title]) } }
  const restore = installWorkspaceBrowse(capability, controller, policy, registry)
  assert.equal((await controller.create({ path: workspaceFile })).path, '/scope/repo')
  assert.deepEqual(calls, [['/scope/repo', 'Project'], '/scope/repo'])
  await controller.create({ path: '/scope' })
  assert.equal(calls.at(-1), '/scope')
  const folder = join(base, 'x.code-workspace')
  mkdirSync(folder)
  const normalPolicy = { async openPicked(path) { return path } }
  restore()
  const restoreFolder = installWorkspaceBrowse(capability, controller, normalPolicy, registry)
  const before = calls.length
  assert.equal((await controller.create({ path: folder })).path, folder)
  assert.deepEqual(calls.slice(before), [folder], 'folder title must not be changed through the registry')
  restoreFolder()
  const restoreAgain = installWorkspaceBrowse(capability, controller, policy, registry)
  await assert.rejects(controller.create({ path: '/invalid.code-workspace' }), /invalid scope/)
  restoreAgain()
  assert.equal(capability.list, list)
  assert.equal(controller.create, create)
})

test('browse stops the workspace scan at maxEntries and closes early', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  const files = Array.from({ length: 5 }, (_, i) => `${i}.code-workspace`)
  for (const file of files) writeFileSync(join(base, file), '{}')
  let reads = 0, closes = 0, opens = 0
  const level = {
    async read() {
      reads++
      assert.ok(reads <= 2, 'must stop before reading the remaining directory entries')
      return { name: files[reads - 1], isFile: () => true }
    },
    async close() { closes++ },
  }
  const upstream = async () => ({ path: base, crumbs: [], entries: [], truncated: false })
  const open = async () => { opens++; return level }
  const listing = await workspaceBrowseList(upstream, 2, open)(base, new AbortController().signal)
  assert.equal(listing.entries.length, 2)
  assert.equal(listing.truncated, true)
  assert.equal(reads, 2)
  assert.equal(closes, 1)
  const full = async () => ({ ...listing, truncated: false })
  assert.equal((await workspaceBrowseList(full, 2, open)(base)).truncated, true)
  assert.equal(opens, 1, 'a full upstream listing must not start another scan')
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const step of ['open', 'read', 'close']) {
  test(`browse aborts a stalled ${step} promptly and closes the abandoned handle`, async () => {
    const [base, cleanup] = tempHomeDir()
    const started = deferred()
    const stalled = deferred()
    const closing = deferred()
    const closed = deferred()
    let closeCalls = 0
    const level = {
      read() {
        if (step === 'close') return Promise.resolve(null)
        started.resolve()
        return stalled.promise
      },
      close() {
        closeCalls++
        if (step === 'close') started.resolve()
        closed.resolve()
        return closing.promise
      },
    }
    const upstream = async () => ({ path: base, crumbs: [], entries: [], truncated: false })
    const open = () => {
      if (step === 'open') { started.resolve(); return stalled.promise }
      return Promise.resolve(level)
    }
    const controller = new AbortController()
    const reason = new Error('cancelled stalled scan')
    const listing = workspaceBrowseList(upstream, 1000, open)(base, controller.signal)
    let timer
    try {
      await started.promise
      // The filesystem operation and close remain pending until after rejection.
      const rejected = assert.rejects(listing, error => error === reason)
      controller.abort(reason)
      await Promise.race([rejected, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('abort did not settle promptly')), 500)
      })])
      if (step === 'open') stalled.resolve(level)
      await closed.promise
      assert.equal(closeCalls, 1)
      // Late read/close errors must be consumed rather than become unhandled.
      if (step === 'read') stalled.reject(new Error('late read failure'))
      closing.reject(new Error('late close failure'))
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      clearTimeout(timer)
      stalled.resolve(step === 'open' ? level : null)
      closing.resolve()
      await listing.catch(() => {})
      cleanup()
    }
  })
}
