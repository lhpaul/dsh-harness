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

test('browse create resolves, titles and reuses workspace, rejects invalid files and restores seams', async () => {
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
  assert.equal((await controller.create({ path: '/scope/Project.code-workspace' })).path, '/scope/repo')
  assert.deepEqual(calls, [['/scope/repo', 'Project'], '/scope/repo'])
  await controller.create({ path: '/scope' })
  assert.equal(calls.at(-1), '/scope')
  await assert.rejects(controller.create({ path: '/invalid.code-workspace' }), /invalid scope/)
  restore()
  assert.equal(capability.list, list)
  assert.equal(controller.create, create)
})
