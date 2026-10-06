/**
 * Composes MultiRootFileReferenceService with the real
 * WorkspaceRootsPolicyService on the fixture tree and checks `@` completion
 * across the session cwd and its extra roots.
 */

import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WorkspaceRootsPolicyService from '../packages/workspace-roots/src/index.js'
import MultiRootFileReferenceService from '../packages/workspace-roots/src/file-references.js'
import { buildFixture, tempHomeDir } from './helpers.mjs'

describe('MultiRootFileReferenceService', () => {
  let base, cleanup, p, ctx
  const agent = (id, cwd) => ({ session: { id, header: { cwd } } })
  const list = (a, query) => ctx.get('fileReferences').list(a, query, new AbortController().signal)
  const paths = (candidates) => candidates.map((c) => c.path)

  before(async () => {
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    const touch = (path) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'x') }
    touch(join(p.blum, 'README.md'))
    touch(join(p.vault, 'Notas', '2026-10-plan.md'))
    touch(join(p.diarios, '2026-10-06.md'))
    touch(join(p.principios, 'valores.md'))
    touch(join(p.assetsBlum, 'contrato-blum.pdf'))
    touch(join(p.assetsLeasity, 'contrato-leasity.pdf'))
    ctx = new Context()
    ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => null })
    ctx.provide('agents', { list: () => [], get: () => undefined })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    await ctx.plugin(MultiRootFileReferenceService, {})
    assert.ok(ctx.get('fileReferences') instanceof MultiRootFileReferenceService)
  })
  after(() => cleanup?.())

  test('empty query: cwd entries stay relative, extra roots are offered as absolute directories', async () => {
    const found = await list(agent('blum', p.blum), '')
    assert.ok(paths(found).includes('README.md'))
    for (const root of [p.vault, p.assetsBlum, p.shared]) {
      assert.ok(found.some((c) => c.path === root && c.kind === 'directory'), `offers ${root}`)
    }
    assert.ok(!paths(found).includes(p.assetsLeasity))
  })

  test('fuzzy query ranks every root together; another scope stays out', async () => {
    const found = paths(await list(agent('blum', p.blum), 'contrato'))
    assert.deepEqual(found, [join(p.assetsBlum, 'contrato-blum.pdf')])
    const leasity = paths(await list(agent('leasity', p.leasityRepo), 'contrato'))
    assert.deepEqual(leasity, [join(p.assetsLeasity, 'contrato-leasity.pdf')])
  })

  test('fuzzy query matches an extra root by its basename', async () => {
    const found = await list(agent('blum', p.blum), 'Shared')
    assert.equal(found[0].path, p.shared)
  })

  test('denied paths are never offered', async () => {
    const fuzzy = paths(await list(agent('blum', p.blum), '2026-10'))
    assert.ok(fuzzy.includes(join(p.vault, 'Notas', '2026-10-plan.md')))
    assert.ok(!fuzzy.some((path) => path.startsWith(p.diarios)), JSON.stringify(fuzzy))
    const listing = paths(await list(agent('blum', p.blum), `${p.vault}/45 - Autoconocimiento/`))
    assert.ok(listing.includes(p.principios))
    assert.ok(!listing.includes(p.diarios))
    assert.deepEqual(await list(agent('blum', p.blum), `${p.diarios}/`), [])
  })

  test('denied paths stay hidden when the vault is the session cwd', async () => {
    const vault = agent('vault', p.vault)
    const listing = paths(await list(vault, '45 - Autoconocimiento/'))
    assert.ok(listing.includes('45 - Autoconocimiento/Principios'))
    assert.ok(!listing.includes('45 - Autoconocimiento/Diarios'))
    assert.ok(!paths(await list(vault, 'Diarios')).some((path) => path.includes('Diarios')))
  })

  test('absolute and ~/ queries descend into roots and complete root prefixes', async () => {
    const blum = agent('blum', p.blum)
    assert.deepEqual(paths(await list(blum, `${p.assetsBlum}/con`)), [join(p.assetsBlum, 'contrato-blum.pdf')])
    const tilde = `~/${relative(homedir(), p.assetsBlum)}`
    assert.deepEqual(paths(await list(blum, `${tilde}/`)), [join(p.assetsBlum, 'contrato-blum.pdf')])
    assert.deepEqual(paths(await list(blum, tilde.slice(0, -2))), [p.assetsBlum])
  })

  test('absolute queries outside every root find nothing', async () => {
    assert.deepEqual(await list(agent('blum', p.blum), `${p.assetsLeasity}/`), [])
    assert.deepEqual(await list(agent('blum', p.blum), `${p.outside}/`), [])
  })

  test('a session outside ~/Git behaves like upstream (cwd only)', async () => {
    writeFileSync(join(p.outside, 'notes.txt'), 'x')
    const outside = agent('outside', p.outside)
    assert.deepEqual(paths(await list(outside, '')), ['notes.txt'])
    assert.deepEqual(await list(outside, 'contrato'), [])
  })

  test('roots follow live workspace edits', async () => {
    const blum = agent('live', p.blum)
    assert.ok(paths(await list(blum, '')).includes(p.shared))
    const file = join(p.blum, 'Blum - BAUM.code-workspace')
    renameSync(file, `${file}.off`)
    try {
      assert.ok(!paths(await list(blum, '')).includes(p.shared))
      assert.deepEqual(await list(blum, `${p.shared}/`), [])
    } finally {
      renameSync(`${file}.off`, file)
    }
    assert.ok(paths(await list(blum, '')).includes(p.shared))
  })
})
