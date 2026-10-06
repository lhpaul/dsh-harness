/**
 * Composes the plugin with the REAL installed fs fence (`dsh-fs-sandbox`) and
 * Seatbelt provider (`dsh-sandbox-local`) in a Cordis context, then writes
 * through both enforcement paths on a fixture tree. Requires the pinned
 * runtime in node_modules with the multi-root patch applied.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import WorkspaceRootsPolicyService, { assertPatchedRuntime, renderPolicyContext } from '../packages/workspace-roots/src/index.js'
import { EXIT, run } from '../patch/dsh-multi-root.mjs'
import { INSTALL_ROOT, buildFixture, isMac, memoryStorageDomain, tempHomeDir, writeJson } from './helpers.mjs'

const UPSTREAM_WORKSPACE_WRITE = (root) => `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(root)}. Some platform temporary areas may also be writable.`

describe('WorkspaceRootsPolicyService (real composition)', () => {
  let base, cleanup, p, ctx, contextText
  const modes = new Map()
  const session = (id, cwd) => ({ id, header: { cwd } })

  before(async () => {
    assert.equal(
      run({ installRoot: INSTALL_ROOT, mode: 'check', log: () => {}, error: () => {} }),
      EXIT.ok,
      'the pinned runtime must be patched: run `npm run patch` (bootstrap.sh does it)',
    )
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    ctx = new Context()
    ctx.provide('storageDomain', memoryStorageDomain())
    ctx.provide('sessionProjections', {
      register: () => () => {},
      stateOf: (s, key) => (key === 'sandboxMode' ? modes.get(s.id) ?? null : null),
    })
    ctx.provide('systemPrompt', {
      context: (c) => { contextText = c.text; return () => {} },
      getContextOrder: () => 0,
    })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxedFileSystem, {})
    assert.ok(ctx.get('sandboxPolicy') instanceof WorkspaceRootsPolicyService)
    assert.ok(ctx.get('fs'), 'the real fs fence mounted on top of the plugin')
  })
  after(() => cleanup?.())

  const policyFor = (s, mode) => ctx.get('sandboxPolicy').resolve(mode === undefined ? { session: s } : { session: s, mode })

  async function bashWrite(s, dir, mode) {
    const policy = policyFor(s, mode)
    if (policy.mode === 'danger-full-access') return true
    const target = join(dir, `bash-${s.id}.txt`)
    const { argv } = await ctx.get('sandbox').confine(['/bin/sh', '-c', `printf x > '${target}'`], policy)
    try {
      execFileSync(argv[0], argv.slice(1), { stdio: 'pipe' })
      return true
    } catch {
      // The confined write failed: Seatbelt denied it.
      return false
    }
  }

  async function fsWrite(s, dir, mode) {
    const fs = ctx.get('fs')
    try {
      await fs.writeText(await fs.resolve(join(dir, `fs-${s.id}.txt`)), 'x', undefined, undefined, policyFor(s, mode))
      return true
    } catch (error) {
      if (error?.code === 'FS_SANDBOX_DENIED') return false
      throw error
    }
  }

  async function canWrite(s, dir, mode) {
    const viaFs = await fsWrite(s, dir, mode)
    if (!isMac) return viaFs
    const viaBash = await bashWrite(s, dir, mode)
    assert.equal(viaBash, viaFs, `bash and fs fence disagree for ${dir}`)
    return viaFs
  }

  test('a Blum session can write its repo, Blum assets and the vault', async () => {
    const s = session('blum', p.blum)
    assert.equal(await canWrite(s, p.blumRepo), true)
    assert.equal(await canWrite(s, p.assetsBlum), true)
    assert.equal(await canWrite(s, p.vault), true)
    assert.equal(await canWrite(s, p.principios), true)
  })

  test('a Leasity session can write Leasity assets but NOT Blum assets', async () => {
    const s = session('leasity', p.leasityRepo)
    assert.equal(await canWrite(s, p.assetsLeasity), true)
    assert.equal(await canWrite(s, p.vault), true)
    assert.equal(await canWrite(s, p.assetsBlum), false)
  })

  test('Diarios stays denied inside the writable vault', async () => {
    assert.equal(await canWrite(session('blum-d', p.blum), p.diarios), false)
    assert.equal(await canWrite(session('vault-d', p.vault), p.diarios), false, 'also when the vault is the primary root')
  })

  test('writes outside every root are denied in workspace-write', async () => {
    const s = session('blum-out', p.blum)
    assert.equal(await canWrite(s, p.outside), false)
    assert.equal(await canWrite(s, p.leasityRepo), false)
  })

  test('a session outside ~/Git gets no extra roots', async () => {
    const s = session('outside', p.outside)
    assert.equal(policyFor(s).workspaceRoots, undefined)
    assert.equal(await canWrite(s, p.outside), true)
    assert.equal(await canWrite(s, p.vault), false)
  })

  test('read-only override denies everything; danger-full-access bypasses', async () => {
    const s = session('ro', p.blum)
    modes.set('ro', 'read-only')
    assert.equal(policyFor(s).mode, 'read-only')
    assert.equal(await fsWrite(s, p.assetsBlum), false)
    assert.equal(policyFor(s, 'danger-full-access').mode, 'danger-full-access', 'explicit approved mode outranks the session override')
    modes.delete('ro')
  })

  test('roots are resolved per call: a workspace edit applies without restart', async () => {
    const s = session('live', p.leasity)
    assert.equal(await canWrite(s, p.shared), false)
    const file = join(p.leasity, 'Leasity - Shared.code-workspace')
    writeJson(file, { folders: [{ path: '../../Documents/LH/Negocios/Shared' }] })
    assert.equal(await canWrite(s, p.shared), true)
  })

  test('the policy keeps the upstream fields', () => {
    const s = session('shape', p.blum)
    const policy = policyFor(s)
    assert.equal(policy.mode, 'workspace-write')
    assert.equal(policy.workspaceRoot, p.blum)
    assert.equal(policy.sessionId, 'shape')
    assert.deepEqual(policy.deniedWritePaths, [p.diarios])
    const agentless = ctx.get('sandboxPolicy').resolve()
    assert.equal(agentless.workspaceRoot, p.outside)
    assert.equal(agentless.sessionId, undefined)
  })

  test('context names the extra roots and the denied path; upstream text when none apply', () => {
    const text = contextText({ agent: { session: session('ctx', p.blum) } })
    assert.match(text, /additional workspace roots: /)
    assert.ok(text.includes(JSON.stringify(p.assetsBlum)) && text.includes(JSON.stringify(p.vault)))
    assert.ok(text.includes(`Writes under ${JSON.stringify(p.diarios)} are denied.`))
    assert.equal(contextText({ agent: { session: session('ctx2', p.outside) } }), UPSTREAM_WORKSPACE_WRITE(p.outside))
    assert.equal(contextText({}), '')
    assert.equal(renderPolicyContext({ mode: 'workspace-write', workspaceRoot: '/w' }), UPSTREAM_WORKSPACE_WRITE('/w'))
  })

  test('the runtime check rejects an unpatched install', () => {
    const [dir, done] = tempHomeDir()
    try {
      for (const pkg of ['dsh-sandbox-local', 'dsh-fs-sandbox']) {
        mkdirSync(join(dir, pkg), { recursive: true })
        writeFileSync(join(dir, pkg, 'index.js'), '// pristine\n')
      }
      const fake = (specifier) => pathToFileURL(join(dir, specifier.split('/')[1], 'index.js')).href
      assert.throws(() => assertPatchedRuntime(fake), /not patched for multi-root.*dsh-sandbox-local.*dsh-fs-sandbox/s)
      for (const pkg of ['dsh-sandbox-local', 'dsh-fs-sandbox']) {
        copyFileSync(join(INSTALL_ROOT, pkg, 'lib', 'index.js'), join(dir, pkg, 'index.js'))
      }
      assert.doesNotThrow(() => assertPatchedRuntime(fake))
    } finally {
      done()
    }
  })

  test('invalid configuration fails at load', async () => {
    const c = new Context()
    c.provide('storageDomain', memoryStorageDomain())
    c.provide('sessionProjections', { register: () => () => {}, stateOf: () => null })
    await assert.rejects(
      async () => { await c.plugin(WorkspaceRootsPolicyService, { mode: 'workspace-write', scopesRoot: 'relative', deniedWritePaths: [] }) },
      /scopesRoot must be an absolute path/,
    )
    await assert.rejects(
      async () => { await c.plugin(WorkspaceRootsPolicyService, { mode: 'workspace-write', scopesRoot: '/x', deniedWritePaths: ['rel'] }) },
      /deniedWritePaths entries must be absolute/,
    )
    await assert.rejects(async () => { await c.plugin(WorkspaceRootsPolicyService, { mode: 'workspace-write' }) })
  })
})
