/**
 * Opening a workspace file from Add workspace selects it for its scope; each
 * session keeps the file that was active when its roots were first resolved.
 * Fixture Blum has two files: `Blum` (vault + Blum assets) and
 * `Blum - BAUM` (vault + Shared).
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WorkspaceRootsPolicyService from '../packages/workspace-roots/src/index.js'
import { titleWorkspace, workspacePick } from '../packages/workspace-roots/src/directory-picker.js'
import { WorkspaceSelection } from '../packages/workspace-roots/src/workspace-selection.js'
import { buildFixture, memoryStorageDomain, tempHomeDir, writeJson } from './helpers.mjs'

describe('workspace-file selection', () => {
  let cleanup, p, policy, storage, blumFile, baumFile
  const warnings = []
  const session = (id, cwd, parentSession) => ({ id, header: { id, cwd, ...parentSession === undefined ? {} : { parentSession } } })
  const rootsOf = (s) => policy.resolve({ session: s }).workspaceRoots ?? []

  before(async () => {
    let base
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    blumFile = join(p.blum, 'Blum.code-workspace')
    baumFile = join(p.blum, 'Blum - BAUM.code-workspace')
    const ctx = new Context()
    storage = memoryStorageDomain()
    ctx.provide('storageDomain', storage)
    ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => null })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    policy = ctx.get('sandboxPolicy')
    policy.logger = { warn: (message) => warnings.push(message) }
    policy.roots.onWarning = (message) => warnings.push(message)
  })
  after(() => cleanup?.())

  test('without an active file a session keeps the union of the scope files', () => {
    assert.deepEqual(rootsOf(session('union', p.blumRepo)), [p.shared, p.assetsBlum, p.vault].sort())
  })

  test('opening a workspace file returns its first folder and narrows new sessions to that file', async () => {
    const before = session('before-pick', p.blum)
    rootsOf(before)
    assert.equal(await policy.openPicked(blumFile), p.blumRepo)
    assert.deepEqual(rootsOf(session('after-pick', p.blumRepo)), [p.assetsBlum, p.vault].sort())
    assert.ok(rootsOf(before).includes(p.shared), 'a session resolved before the pick keeps its pin')
  })

  test('switching the active file changes only new sessions; forks inherit the parent pin', async () => {
    const pinned = session('pinned-blum', p.blum)
    assert.ok(!rootsOf(pinned).includes(p.shared))
    await policy.openPicked(baumFile)
    assert.deepEqual(rootsOf(session('baum', p.blum)), [p.shared, p.vault].sort())
    assert.ok(!rootsOf(pinned).includes(p.shared))
    assert.deepEqual(rootsOf(session('fork', p.blum, 'pinned-blum')), rootsOf(pinned))
  })

  test('opening the scope folder clears the active file; other folders pass through', async () => {
    await policy.openPicked(blumFile)
    assert.equal(await policy.openPicked(p.blum), p.blum)
    assert.ok(rootsOf(session('cleared', p.blum)).includes(p.shared))
    assert.equal(await policy.openPicked(p.blumRepo), p.blumRepo)
    assert.equal(await policy.openPicked(p.outside), p.outside)
  })

  test('a workspace file outside a scope folder is refused', async () => {
    const stray = join(p.outside, 'stray.code-workspace')
    writeJson(stray, { folders: [] })
    await assert.rejects(policy.openPicked(stray), /not a workspace file directly inside/)
    const nested = join(p.blumRepo, 'nested.code-workspace')
    writeJson(nested, { folders: [] })
    await assert.rejects(policy.openPicked(nested), /not a workspace file directly inside/)
  })

  test('a session in one repo of the opened file also gets its other in-scope repos', async () => {
    const scope = join(p.git, 'Multi')
    const [app, api, notes] = ['app', 'api', 'notes'].map((name) => join(scope, name))
    for (const dir of [app, join(api, 'src'), notes]) mkdirSync(dir, { recursive: true })
    const file = join(scope, 'Multi.code-workspace')
    writeJson(file, { folders: [{ path: 'app' }, { path: 'api' }, { path: '../../Documents/LH/Negocios/Shared' }] })
    assert.equal(await policy.openPicked(file), app)
    assert.deepEqual(rootsOf(session('multi-app', app)), [api, p.shared].sort())
    assert.deepEqual(rootsOf(session('multi-deep', join(api, 'src'))), [api, app, p.shared].sort(), 'a listed repo above the cwd is reached too')
    assert.deepEqual(rootsOf(session('multi-scope', scope)), [p.shared])
    assert.deepEqual(rootsOf(session('multi-unlisted', notes)), [p.shared])
    await policy.openPicked(scope)
    assert.deepEqual(rootsOf(session('multi-union', app)), [p.shared], 'without a file, no sibling repos')
  })

  test('a workspace file whose first folder is not a repo of the scope opens the scope folder', async () => {
    const outsideFirst = join(p.leasity, 'Leasity - Assets first.code-workspace')
    writeJson(outsideFirst, { folders: [{ path: '../../Documents/LH/Negocios/Proyectos/Leasity' }, { path: 'leasity-mvp-webapp' }] })
    assert.equal(await policy.openPicked(outsideFirst), p.leasity)
    const missingFirst = join(p.leasity, 'Leasity - Missing first.code-workspace')
    writeJson(missingFirst, { folders: [{ path: 'gone' }, { path: 'leasity-mvp-webapp' }] })
    assert.equal(await policy.openPicked(missingFirst), p.leasity)
    rmSync(outsideFirst)
    rmSync(missingFirst)
    await policy.openPicked(p.leasity)
  })

  test('a pinned file that disappears yields no file roots', async () => {
    const temp = join(p.leasity, 'Leasity - Temp.code-workspace')
    writeJson(temp, { folders: [{ path: '../../Documents/LH/Negocios/Shared' }] })
    assert.equal(await policy.openPicked(temp), p.leasity)
    const s = session('temp', p.leasityRepo)
    assert.deepEqual(rootsOf(s), [p.shared])
    rmSync(temp)
    assert.deepEqual(rootsOf(s), [])
    assert.ok(warnings.some((message) => message.includes('Leasity - Temp')))
    await policy.openPicked(p.leasity)
  })

  test('pins and active files persist in the storage domain; stored sessions read their pin', async () => {
    await policy.openPicked(blumFile)
    rootsOf(session('stored', p.blum))
    await new Promise((resolve) => setImmediate(resolve))
    const tables = storage.domains.get('dsh_lh_workspace_roots')
    assert.deepEqual(tables.get('active_files').get(p.blum), { file: blumFile })
    assert.deepEqual(tables.get('session_files').get('stored'), { file: blumFile })
    await policy.openPicked(baumFile)
    assert.ok(!policy.storedSessionRoots('stored', p.blum).includes(p.shared))
    assert.ok(policy.storedSessionRoots('never-loaded', p.blum).includes(p.shared), 'unpinned sessions use the active file')
    await policy.openPicked(p.blum)
  })

  test('a pin is read back before its write is durable', async () => {
    let release
    const writes = []
    const table = (records) => ({
      get: (key) => records.get(key),
      put: (key, value) => { writes.push(key); return new Promise((resolve) => { release = () => { records.set(key, value); resolve() } }) },
      delete: async (key) => { records.delete(key) },
    })
    const tables = { active_files: table(new Map([['/s', { file: '/s/a.code-workspace' }]])), session_files: table(new Map()) }
    const selection = new WorkspaceSelection({ table: (name) => tables[name] })
    assert.equal(selection.fileFor({ id: 'x' }, '/s'), '/s/a.code-workspace')
    tables.active_files.get = () => ({ file: '/s/b.code-workspace' })
    assert.equal(selection.fileFor({ id: 'x' }, '/s'), '/s/a.code-workspace')
    assert.deepEqual(writes, ['x'])
    release()
  })

  test('the picker override maps a picked workspace file to its scope and passes cancel through', async () => {
    const opened = []
    const fakePolicy = { openPicked: async (path) => { opened.push(path); return '/scope' } }
    assert.equal(await workspacePick(async () => '/scope/A.code-workspace', fakePolicy)(new AbortController().signal), '/scope')
    assert.equal(await workspacePick(async () => null, fakePolicy)(new AbortController().signal), null)
    assert.deepEqual(opened, ['/scope/A.code-workspace'])
  })

  test('a picked workspace file titles its workspace; folders and failures do not block the pick', async () => {
    const titled = []
    const errors = []
    const fakePolicy = { openPicked: async (path) => (path.endsWith('.code-workspace') ? '/scope/repo' : path) }
    const onFile = async (directory, file) => { titled.push([directory, file]); if (file.includes('Broken')) throw new Error('boom') }
    const pick = (path) => workspacePick(async () => path, fakePolicy, onFile, (error) => errors.push(error.message))(new AbortController().signal)
    const broken = join(p.blum, 'Broken.code-workspace')
    writeJson(broken, { folders: [] })
    assert.equal(await pick(blumFile), '/scope/repo')
    assert.equal(await pick('/scope/other'), '/scope/other')
    assert.equal(await pick(broken), '/scope/repo')
    assert.deepEqual(titled, [['/scope/repo', blumFile], ['/scope/repo', broken]])
    assert.deepEqual(errors, ['boom'])
  })

  test('titleWorkspace creates the workspace with the file name or retitles an existing one', async () => {
    const calls = []
    const existing = { title: 'seia', setTitle: async (title) => { calls.push(['setTitle', title]); existing.title = title } }
    const registry = (found) => ({
      resolveByPath: async (path) => { calls.push(['resolve', path]); return found },
      create: async (path, title) => { calls.push(['create', path, title]) },
    })
    await titleWorkspace(registry(undefined), '/s/seia', '/s/Radar Insights.code-workspace')
    await titleWorkspace(registry(existing), '/s/seia', '/s/Radar Insights.code-workspace')
    await titleWorkspace(registry(existing), '/s/seia', '/s/Radar Insights.code-workspace')
    assert.deepEqual(calls, [
      ['resolve', '/s/seia'], ['create', '/s/seia', 'Radar Insights'],
      ['resolve', '/s/seia'], ['setTitle', 'Radar Insights'],
      ['resolve', '/s/seia'],
    ])
  })
})
