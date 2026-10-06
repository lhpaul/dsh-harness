/**
 * The workspace-files plugin re-anchors listings and watches of extra-root
 * paths to the owning root before upstream WorkspaceFiles confines them.
 * Upstream's own behavior (fs access, containment, typert dispatch) is covered
 * by the boot smoke.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Context, symbols } from '@deepseek-ai/cordis'
import WorkspaceRootsPolicyService from '../packages/workspace-roots/src/index.js'
import { ROOTS_LISTING, anchorScope, apply, rootsListing } from '../packages/workspace-roots/src/workspace-files.js'
import { buildFixture, memoryStorageDomain, tempHomeDir } from './helpers.mjs'

describe('workspace-files extra-root anchoring', () => {
  let cleanup, p, policy
  const live = new Map()
  const grants = new Map()
  const scope = (sessionId, workspaceRoot) => ({ sessionId, workspaceRoot })

  /** A fake upstream service behind a Cordis view, recording what upstream receives. */
  function install() {
    const calls = []
    class Upstream {
      list(s, path) { calls.push(['list', this, s.workspaceRoot, path]); return 'listing' }
      changes(s, path) { calls.push(['changes', this, s.workspaceRoot, path]); return 'stream' }
    }
    const target = new Upstream()
    const disposers = []
    const ctx = {
      workspaceFiles: { [symbols.original]: target },
      sandboxPolicy: policy,
      sessions: { get: (id) => live.get(id) },
      effect: (fn) => { disposers.push(fn()) },
    }
    apply(ctx)
    return { target, calls, ctx, dispose: () => disposers.forEach((dispose) => dispose()) }
  }

  before(async () => {
    let base
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    const ctx = new Context()
    ctx.provide('storageDomain', memoryStorageDomain())
    ctx.provide('sessionProjections', {
      register: () => () => {},
      stateOf: (session, key) => (key === 'workspaceRootGrants' ? grants.get(session.id) ?? null : null),
    })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    policy = ctx.get('sandboxPolicy')
    live.set('blum', { id: 'blum', header: { cwd: p.blum } })
  })
  after(() => cleanup?.())

  test('paths inside the cwd and relative paths keep the session scope', () => {
    const blum = scope('blum', p.blum)
    const unused = () => assert.fail('extra roots read for a cwd path')
    assert.equal(anchorScope(blum, join(p.blumRepo, 'x'), unused), blum)
    assert.equal(anchorScope(blum, 'docs', unused), blum)
  })

  test('the innermost extra root containing the path wins', () => {
    const roots = () => [p.vault, p.principios]
    assert.deepEqual(anchorScope(scope('s', p.blum), join(p.principios, 'a.md'), roots), scope('s', p.principios))
    assert.deepEqual(anchorScope(scope('s', p.blum), join(p.vault, 'b'), roots), scope('s', p.vault))
    assert.equal(anchorScope(scope('s', p.blum), p.outside, roots).workspaceRoot, p.blum)
  })

  test('installed list and changes anchor extra-root paths and delegate with the same receiver', () => {
    const { target, calls, dispose } = install()
    const view = {}
    assert.equal(target.list.call(view, scope('blum', p.blum), join(p.vault, '20 - Proyectos')), 'listing')
    assert.equal(target.changes.call(view, scope('blum', p.blum), 'docs'), 'stream')
    target.list.call(view, scope('blum', p.blum), p.assetsLeasity)
    assert.deepEqual(calls, [
      ['list', view, p.vault, join(p.vault, '20 - Proyectos')],
      ['changes', view, p.blum, 'docs'],
      ['list', view, p.blum, p.assetsLeasity],
    ])
    dispose()
  })

  test('a loaded session also reaches its granted roots', () => {
    const { target, calls, dispose } = install()
    live.set('granted', { id: 'granted', header: { cwd: p.blum } })
    grants.set('granted', { pending: [], roots: [p.outside] })
    target.list(scope('granted', p.blum), join(p.outside, 'a'))
    target.list(scope('blum', p.blum), join(p.outside, 'a'))
    assert.deepEqual(calls.map((call) => call[2]), [p.outside, p.blum])
    dispose()
  })

  test('a session that is not loaded uses its workspace-file roots', () => {
    const { target, calls, dispose } = install()
    target.list(scope('stored', p.leasityRepo), p.assetsLeasity)
    target.list(scope('stored', p.leasityRepo), p.assetsBlum)
    assert.deepEqual(calls.map((call) => call[2]), [p.assetsLeasity, p.leasityRepo])
    dispose()
  })

  test('the reserved listing answers with the workspace file and roots without calling upstream', async () => {
    const { target, calls, dispose } = install()
    const stored = await target.list(scope('stored-union', p.leasityRepo), ROOTS_LISTING)
    assert.equal(stored.path, ROOTS_LISTING)
    assert.equal(stored.truncated, false)
    assert.deepEqual(new Set(stored.entries.map((entry) => `${entry.type}:${entry.name}`)),
      new Set([`directory:${p.vault}`, `directory:${p.assetsLeasity}`]))
    const outside = await target.list(scope('stored-outside', p.outside), ROOTS_LISTING)
    assert.deepEqual(outside.entries, [])
    assert.deepEqual(calls, [])
    dispose()
  })

  test('the reserved listing pins a loaded session but only reads an unloaded one', async () => {
    const { target, dispose } = install()
    const file = join(p.blum, 'Blum - BAUM.code-workspace')
    await policy.selection.setActiveFile(p.blum, file)
    try {
      live.set('hovered', { id: 'hovered', header: { id: 'hovered', cwd: p.blum } })
      const loaded = await target.list(scope('hovered', p.blum), ROOTS_LISTING)
      assert.deepEqual(loaded.entries[0], { name: file, type: 'file' })
      assert.ok(loaded.entries.some((entry) => entry.name === p.shared))
      assert.ok(!loaded.entries.some((entry) => entry.name === p.assetsBlum))
      assert.equal(policy.selection.pinOf('hovered'), file)

      const unloaded = await target.list(scope('stored-blum', p.blum), ROOTS_LISTING)
      assert.deepEqual(unloaded.entries[0], { name: file, type: 'file' })
      assert.equal(policy.selection.pinOf('stored-blum'), undefined)
    } finally {
      await policy.selection.setActiveFile(p.blum, null)
    }
    dispose()
  })

  test('rootsListing omits the file entry for the union of a scope\'s files', () => {
    assert.deepEqual(rootsListing(null, ['/a']).entries, [{ name: '/a', type: 'directory' }])
  })

  test('disposal restores the upstream methods; a second install is refused', () => {
    const first = install()
    assert.ok(Object.hasOwn(first.target, 'list') && Object.hasOwn(first.target, 'changes'))
    assert.throws(() => apply(first.ctx), /refusing to override twice/)
    first.dispose()
    assert.ok(!Object.hasOwn(first.target, 'list') && !Object.hasOwn(first.target, 'changes'))
    first.target.list(scope('blum', p.blum), p.vault)
    assert.equal(first.calls.at(-1)[2], p.blum)
  })
})
