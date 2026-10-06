import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { WorkspaceRootsResolver } from '../packages/workspace-roots/src/roots.js'
import { buildFixture, tempHomeDir, writeJson } from './helpers.mjs'

describe('WorkspaceRootsResolver', () => {
  let base, cleanup, p
  before(() => {
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
  })
  after(() => cleanup())

  const make = (warnings = []) => new WorkspaceRootsResolver({
    scopesRoot: p.git,
    homeDir: p.home,
    onWarning: (m) => warnings.push(m),
  })

  test('scope is the first-level directory under scopesRoot', () => {
    const r = make()
    assert.equal(r.scopeOf(p.blum), p.blum)
    assert.equal(r.scopeOf(join(p.blumRepo, 'src', 'deep')), p.blum)
    assert.equal(r.scopeOf(p.git), undefined, 'scopesRoot itself has no scope')
    assert.equal(r.scopeOf(p.outside), undefined)
    assert.equal(r.scopeOf('relative/path'), undefined)
  })

  test('folders outside the scope are extra roots, unioned and deduplicated across files', () => {
    assert.deepEqual(make().extraRoots(p.blumRepo), [p.shared, p.assetsBlum, p.vault].sort())
  })

  test('a Leasity session gets Leasity assets and the vault, not Blum assets', () => {
    const roots = make().extraRoots(p.leasityRepo)
    assert.deepEqual(roots, [p.assetsLeasity, p.vault].sort())
    assert.ok(!roots.includes(p.assetsBlum))
  })

  test('a malformed workspace file is reported and skipped without throwing', () => {
    const warnings = []
    make(warnings).extraRoots(p.leasity)
    assert.ok(warnings.some((w) => w.includes('broken.code-workspace')), warnings.join('\n'))
  })

  test('sessions outside the scopes root get no extra roots', () => {
    assert.deepEqual(make().extraRoots(p.outside), [])
    assert.deepEqual(make().extraRoots(p.home), [])
  })

  test('non-existent folders are skipped and appear once created, without cache invalidation', () => {
    const r = make()
    const missing = join(p.home, 'Documents', 'LH', 'Negocios', 'does-not-exist')
    assert.ok(!r.extraRoots(p.blum).includes(missing))
    mkdirSync(missing)
    try {
      assert.ok(r.extraRoots(p.blum).includes(missing))
    } finally {
      rmSync(missing, { recursive: true })
    }
  })

  test('edits to workspace files apply on the next call (cache invalidation)', () => {
    const r = make()
    const file = join(p.leasity, 'Leasity - Extra.code-workspace')
    assert.ok(!r.extraRoots(p.leasity).includes(p.shared))
    writeJson(file, { folders: [{ path: '../../Documents/LH/Negocios/Shared' }] })
    assert.ok(r.extraRoots(p.leasity).includes(p.shared), 'added file is picked up')
    writeJson(file, { folders: [] })
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    assert.ok(!r.extraRoots(p.leasity).includes(p.shared), 'edited file is re-read')
    unlinkSync(file)
    assert.ok(!r.extraRoots(p.leasity).includes(p.shared), 'removed file drops its roots')
  })

  test('home, its ancestors, the filesystem root and the scopes root parent are rejected', () => {
    const scope = join(p.git, 'Danger')
    writeJson(join(scope, 'Danger.code-workspace'), {
      folders: [{ path: '/' }, { path: '~' }, { path: '..' }, { path: '../..' }, { path: '~/outside' }],
    })
    const warnings = []
    assert.deepEqual(make(warnings).extraRoots(scope), [p.outside])
    assert.equal(warnings.length, 4, warnings.join('\n'))
  })

  test('file: URIs are honored; remote URIs are ignored', () => {
    const scope = join(p.git, 'Uri')
    writeJson(join(scope, 'Uri.code-workspace'), {
      folders: [{ uri: `file://${p.outside}` }, { uri: 'vscode-remote://ssh-remote+box/home/x' }],
    })
    assert.deepEqual(make().extraRoots(scope), [p.outside])
  })

  test('a symlinked cwd resolves to its canonical scope', () => {
    const link = join(p.home, 'blum-link')
    symlinkSync(p.blumRepo, link)
    try {
      assert.equal(make().scopeOf(link), p.blum)
    } finally {
      unlinkSync(link)
    }
  })

  test('a scope without workspace files has no extra roots', () => {
    const scope = join(p.git, 'Empty')
    mkdirSync(scope, { recursive: true })
    writeFileSync(join(scope, 'README.md'), 'x')
    assert.deepEqual(make().extraRoots(scope), [])
  })

  test('firstFolder is the first in-scope directory entry, else the scope', () => {
    const r = make()
    assert.equal(r.firstFolder(join(p.blum, 'Blum.code-workspace'), p.blum), p.blumRepo)
    const scope = join(p.git, 'First')
    mkdirSync(join(scope, 'repo'), { recursive: true })
    const file = join(scope, 'First.code-workspace')
    writeJson(file, { folders: [{ path: '.' }, { path: 'repo' }] })
    assert.equal(r.firstFolder(file, scope), scope, 'the scope itself')
    writeJson(file, { folders: [] })
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    assert.equal(r.firstFolder(file, scope), scope, 'no folders')
  })

  test('sibling repos of a named file are extra roots only for sessions in one of its folders', () => {
    const r = make()
    const scope = join(p.git, 'Siblings')
    const [a, b] = [join(scope, 'a'), join(scope, 'b')]
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    mkdirSync(join(scope, 'c'), { recursive: true })
    const file = join(scope, 'Siblings.code-workspace')
    writeJson(file, { folders: [{ path: 'a' }, { path: 'b' }] })
    assert.deepEqual(r.extraRoots(a, file), [b])
    assert.deepEqual(r.extraRoots(scope, file), [])
    assert.deepEqual(r.extraRoots(join(scope, 'c'), file), [])
    assert.deepEqual(r.extraRoots(a), [], 'the union never adds siblings')
    assert.deepEqual(r.scopeFolders(scope, file), [a, b])
    assert.deepEqual(r.scopeFolders(a, file), [b])
    assert.deepEqual(r.scopeFolders(a), [])
  })

  test('scopesRoot must be absolute', () => {
    assert.throws(() => new WorkspaceRootsResolver({ scopesRoot: 'Git' }), /absolute/)
  })
})
