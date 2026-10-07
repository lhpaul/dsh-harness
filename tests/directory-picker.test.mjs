import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tempHomeDir } from './helpers.mjs'
import { workspaceBrowseList, workspacePick, installWorkspaceBrowse } from '../packages/workspace-roots/src/directory-picker.js'

test('browse lists bounded workspace leaves, preserves folders and cancellation', async () => {
  const [base, cleanup] = tempHomeDir()
  try {
    const folder = join(base, 'a-folder')
    mkdirSync(folder)
    const file = join(base, 'b.code-workspace')
    writeFileSync(file, '{}')
    writeFileSync(join(base, 'ignore.txt'), '')
    const list = workspaceBrowseList(2)
    assert.deepEqual((await list(base)).entries.map(e => e.name), ['a-folder', 'b.code-workspace'])
    assert.equal((await list(base)).truncated, false)
    const leaf = await list(file)
    assert.equal(leaf.path, file)
    assert.deepEqual(leaf.entries, [])
    assert.equal(leaf.crumbs.at(-1).path, file)
    const bounded = await workspaceBrowseList(1)(base)
    assert.equal(bounded.entries.length, 1)
    assert.equal(bounded.truncated, true)
    const abort = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(list(base, abort), /cancelled/)
  } finally { cleanup() }
})

test('browse keeps upstream path validation and follows directory symlinks', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  const target = join(base, 'target')
  mkdirSync(target)
  writeFileSync(join(base, 'source.code-workspace'), '{}')
  symlinkSync(target, join(base, '.linked-folder'))
  symlinkSync(join(base, 'missing'), join(base, 'broken'))
  symlinkSync(join(base, 'source.code-workspace'), join(base, 'linked.code-workspace'))
  const list = workspaceBrowseList()
  const listing = await list(base)
  assert.deepEqual(listing.entries.map(entry => entry.name), ['.linked-folder', 'linked.code-workspace', 'source.code-workspace', 'target'])
  assert.equal(listing.entries[0].hidden, true)
  assert.equal(listing.truncated, false)
  assert.deepEqual((await list(join(base, 'linked.code-workspace'))).entries, [])
  await assert.rejects(list('relative'), /not a fully qualified path/)
  await assert.rejects(list(join(base, 'missing')), /cannot list/)
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

test('folders and workspace files share the sorted result limit in one scan', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  mkdirSync(join(base, 'b-folder'))
  mkdirSync(join(base, 'c-folder'))
  writeFileSync(join(base, 'a.code-workspace'), '{}')
  const listing = await workspaceBrowseList(2)(base)
  assert.deepEqual(listing.entries.map(entry => entry.name), ['a.code-workspace', 'b-folder'])
  assert.equal(listing.truncated, true)
  assert.equal(listing.path, base)
  assert.equal(listing.crumbs.at(-1).path, base)
})

test('browse caps all dirent reads, including ignored regular files, and closes early', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  let reads = 0, closes = 0, opens = 0
  const level = {
    async read() {
      reads++
      assert.ok(reads <= 20, 'must not read beyond 10 * maxEntries')
      return { name: `${reads}.txt`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
    },
    async close() { closes++ },
  }
  const open = async () => { opens++; return level }
  const listing = await workspaceBrowseList(2, open)(base, new AbortController().signal)
  assert.deepEqual(listing.entries, [])
  assert.equal(listing.truncated, true)
  assert.equal(reads, 20)
  assert.equal(closes, 1)
  assert.equal(opens, 1)
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
    const open = () => {
      if (step === 'open') { started.resolve(); return stalled.promise }
      return Promise.resolve(level)
    }
    const controller = new AbortController()
    const reason = new Error('cancelled stalled scan')
    const listing = workspaceBrowseList(1000, open)(base, controller.signal)
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

test('picker aborts a stalled file stat instead of returning a successful selection', async (t) => {
  const [base, cleanup] = tempHomeDir()
  t.after(cleanup)
  const started = deferred()
  const stalled = deferred()
  const controller = new AbortController()
  const reason = new Error('cancelled file stat')
  let titled = false, reported = false
  const pick = workspacePick(async () => join(base, 'a.code-workspace'),
    { async openPicked() { return base } },
    async () => { titled = true }, () => { reported = true },
    () => { started.resolve(); return stalled.promise })
  const selection = pick(controller.signal)
  let timer
  try {
    await started.promise
    const rejected = assert.rejects(selection, error => error === reason)
    controller.abort(reason)
    await Promise.race([rejected, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('stat cancellation did not settle promptly')), 500)
    })])
    stalled.reject(new Error('late stat failure'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(titled, false)
    assert.equal(reported, false)
  } finally {
    clearTimeout(timer)
    stalled.resolve({ isFile: () => true })
    await selection.catch(() => {})
  }
})

test('picker tolerates a real file stat failure and reports it', async () => {
  const failure = new Error('stat failed')
  const errors = []
  const pick = workspacePick(async () => '/fixture/a.code-workspace',
    { async openPicked() { return '/fixture' } },
    async () => assert.fail('must not title without a file'), error => errors.push(error),
    async () => { throw failure })
  assert.equal(await pick(new AbortController().signal), '/fixture')
  assert.deepEqual(errors, [failure])
})
