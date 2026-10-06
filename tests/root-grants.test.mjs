/**
 * Session-granted roots: the `workspaceRootGrants` fold, the
 * `add_workspace_root` tool (validation, approval, durable meta), and the
 * grant reaching the REAL Seatbelt provider and fs fence through resolve().
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import WorkspaceRootsPolicyService, { renderPolicyContext } from '../packages/workspace-roots/src/index.js'
import {
  ADD_ROOT_TOOL,
  GRANTS_PROJECTION,
  addWorkspaceRootTool,
  applyGrant,
  initGrants,
} from '../packages/workspace-roots/src/root-grants.js'
import { buildFixture, isMac, tempHomeDir } from './helpers.mjs'

const call = (callId, name = ADD_ROOT_TOOL) => ({ type: 'tool/call', data: { name, callId, arguments: '{}', turn: 1, step: 1 } })
const result = (callId, meta, { isError = false, surfaceOp = 'append' } = {}) => ({
  type: 'tool/result',
  surfaceOp,
  data: { turn: 1, step: 1, message: { toolCallId: callId, isError, source: { kind: 'tool', callId } }, ...meta === undefined ? {} : { meta } },
})
const fold = (events) => events.reduce(applyGrant, initGrants())

describe('workspaceRootGrants fold', () => {
  test('a granted add_workspace_root result adds its root once', () => {
    const state = fold([
      call('c1'), result('c1', { grantedRoot: '/a' }),
      call('c2'), result('c2', { grantedRoot: '/a' }),
    ])
    assert.deepEqual(state, { pending: [], roots: ['/a'] })
  })

  test('non-grants are ignored: null meta, error results, other tools, replacements, relative paths', () => {
    const state = fold([
      call('c1'), result('c1', null),
      call('c2'), result('c2', { grantedRoot: '/b' }, { isError: true }),
      call('c3', 'read'), result('c3', { grantedRoot: '/c' }),
      call('c4'), result('c4', { grantedRoot: '/d' }, { surfaceOp: 'replace' }),
      result('c4', { grantedRoot: 'relative' }),
      result('orphan', { grantedRoot: '/e' }),
    ])
    assert.deepEqual(state.roots, [])
  })

  test('turn/end drops calls whose result never landed', () => {
    const state = fold([call('c1'), { type: 'turn/end', data: {} }, result('c1', { grantedRoot: '/a' })])
    assert.deepEqual(state, { pending: [], roots: [] })
  })
})

describe('add_workspace_root (real sandbox composition)', () => {
  let base, cleanup, p, ctx, tool
  const logs = new Map()
  const approvals = []
  let answer = 'allowed-once'
  let seq = 0

  const session = (id, cwd) => {
    logs.set(id, [])
    return { id, header: { cwd } }
  }
  /** Run the tool like the registry does and append its tool/call + tool/result to the session log. */
  async function invoke(s, args, extra = {}) {
    const callId = `call-${++seq}`
    const exec = { callId, name: ADD_ROOT_TOOL, agent: { session: s }, signal: new AbortController().signal, ...extra }
    logs.get(s.id).push(call(callId))
    try {
      const value = await tool.execute(args, exec)
      logs.get(s.id).push(result(callId, tool.output.presentationMeta(args, value)))
      return value
    } catch (error) {
      logs.get(s.id).push(result(callId, undefined, { isError: true }))
      throw error
    }
  }
  const policyFor = (s) => ctx.get('sandboxPolicy').resolve({ session: s })

  async function canWrite(s, dir) {
    const policy = policyFor(s)
    const target = join(dir, `grant-${s.id}-${++seq}.txt`)
    const { argv } = await ctx.get('sandbox').confine(['/bin/sh', '-c', `printf x > '${target}'`], policy)
    let bash = true
    try {
      execFileSync(argv[0], argv.slice(1), { stdio: 'pipe' })
    } catch {
      // The confined write failed: Seatbelt denied it.
      bash = false
    }
    let fs = true
    try {
      await ctx.get('fs').writeText(await ctx.get('fs').resolve(`${target}.fs`), 'x', undefined, undefined, policy)
    } catch (error) {
      if (error.code !== 'FS_SANDBOX_DENIED') throw error
      fs = false
    }
    assert.equal(bash, fs, `bash and fs must agree for ${dir}`)
    return bash
  }

  before(async () => {
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    p.extra = join(p.home, 'Documents', 'LH', 'Personal', 'Extra')
    mkdirSync(p.extra, { recursive: true })
    ctx = new Context()
    ctx.provide('sessionProjections', {
      register: () => () => {},
      stateOf: (s, key) => (key === GRANTS_PROJECTION ? fold(logs.get(s.id) ?? []) : null),
    })
    ctx.provide('tools', {
      register: (definition) => { if (definition.name === ADD_ROOT_TOOL) tool = definition; return () => {} },
    })
    ctx.provide('approval', {
      request: async (req) => { approvals.push(req); return answer },
    })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxedFileSystem, {})
    assert.ok(tool, 'the policy service registers add_workspace_root')
  })
  after(() => cleanup?.())

  test('an approved grant makes the directory writable for that session only', { skip: !isMac }, async () => {
    const blum = session('blum-grant', p.blum)
    const leasity = session('leasity-grant', p.leasityRepo)
    assert.equal(await canWrite(blum, p.extra), false)
    approvals.length = 0
    answer = 'allowed-once'
    const value = await invoke(blum, { path: p.extra, reason: 'Export the Blum report there.' })
    assert.deepEqual(value, { status: 'granted', path: p.extra })
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].toolName, ADD_ROOT_TOOL)
    assert.ok(approvals[0].reason.includes(p.extra) && approvals[0].reason.includes('Export the Blum report there.'))
    assert.ok(policyFor(blum).workspaceRoots.includes(p.extra))
    assert.equal(await canWrite(blum, p.extra), true)
    assert.equal(await canWrite(leasity, p.extra), false, 'grants do not leak to other sessions')
    assert.equal(await canWrite(blum, p.outside), false, 'other directories stay denied')
  })

  test('the granted root appears in the model-visible policy context', async () => {
    const s = session('context', p.blum)
    answer = 'allowed-once'
    await invoke(s, { path: p.extra, reason: 'Needed.' })
    assert.ok(renderPolicyContext(policyFor(s)).includes(JSON.stringify(p.extra)))
  })

  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    test(`a ${outcome} request grants nothing`, { skip: !isMac }, async () => {
      const s = session(`no-${outcome}`, p.blum)
      answer = outcome
      assert.deepEqual(await invoke(s, { path: p.extra, reason: 'Needed.' }), { status: outcome, path: p.extra })
      assert.ok(!(policyFor(s).workspaceRoots ?? []).includes(p.extra))
      assert.equal(await canWrite(s, p.extra), false)
    })
  }

  test('a directory inside a current root is already writable and asks nothing', async () => {
    const s = session('already', p.blum)
    const inside = join(p.assetsBlum, 'sub')
    mkdirSync(inside, { recursive: true })
    approvals.length = 0
    assert.deepEqual(await invoke(s, { path: inside, reason: 'Needed.' }), { status: 'already-writable', path: inside })
    assert.equal(approvals.length, 0)
  })

  test('~/ paths are expanded and canonicalized', async () => {
    const s = session('tilde', p.blum)
    answer = 'allowed-once'
    const value = await invoke(s, { path: `~/${relative(homedir(), p.extra)}/`, reason: 'Needed.' })
    assert.deepEqual(value, { status: 'granted', path: p.extra })
  })

  test('invalid requests fail before asking', async () => {
    const s = session('invalid', p.blum)
    const file = join(p.extra, 'a-file.txt')
    writeFileSync(file, 'x')
    approvals.length = 0
    const cases = [
      [{ path: 'relative/dir', reason: 'x' }, /must be absolute/],
      [{ path: join(p.home, 'missing'), reason: 'x' }, /not an existing directory/],
      [{ path: file, reason: 'x' }, /not an existing directory/],
      [{ path: '/', reason: 'x' }, /filesystem root/],
      [{ path: homedir(), reason: 'x' }, /home directory/],
      [{ path: p.diarios, reason: 'x' }, /denies writes/],
      [{ path: join(p.diarios, 'sub'), reason: 'x' }, /not an existing directory/],
      [{ path: p.extra, reason: '   ' }, /non-empty/],
    ]
    for (const [args, pattern] of cases) {
      await assert.rejects(invoke(s, args), pattern, JSON.stringify(args))
    }
    assert.equal(approvals.length, 0)
  })

  test('calls from inside code (PTC sub-dispatch) are refused', async () => {
    const s = session('ptc', p.blum)
    await assert.rejects(invoke(s, { path: p.extra, reason: 'x' }, { parent: 'token' }), /called directly/)
  })

  test('without an approval service the request is unavailable', async () => {
    const policy = ctx.get('sandboxPolicy')
    const bare = addWorkspaceRootTool(policy, () => undefined)
    const s = session('bare', p.blum)
    const value = await bare.execute({ path: p.extra, reason: 'x' }, { callId: 'b1', name: ADD_ROOT_TOOL, agent: { session: s }, signal: new AbortController().signal })
    assert.deepEqual(value, { status: 'unavailable', path: p.extra })
    assert.equal(bare.output.presentationMeta({}, value), null)
  })

  test('a granted root that disappears from disk is dropped', async () => {
    const gone = join(p.home, 'Documents', 'LH', 'Personal', 'Gone')
    mkdirSync(gone, { recursive: true })
    const s = session('gone', p.blum)
    answer = 'allowed-once'
    await invoke(s, { path: gone, reason: 'x' })
    assert.ok(policyFor(s).workspaceRoots.includes(gone))
    rmSync(gone, { recursive: true })
    assert.ok(!(policyFor(s).workspaceRoots ?? []).includes(gone))
  })

  test('result text tells the model what happened', () => {
    const text = (status) => tool.output.render({}, { status, path: '/x' })[0].text
    assert.match(text('granted'), /writable workspace root for the rest of this session/)
    assert.match(text('rejected'), /rejected/)
  })
})
