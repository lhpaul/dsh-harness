/**
 * The repo-skills plugin lists the skills of the repos a scope's workspace
 * files name, only for lookups whose cwd is the scope folder itself.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WorkspaceRootsPolicyService from '../packages/workspace-roots/src/index.js'
import { PROVIDER, RepoSkillProvider } from '../packages/workspace-roots/src/repo-skills.js'
import { buildFixture, memoryStorageDomain, tempHomeDir, writeJson } from './helpers.mjs'

function writeSkill(dir, skillName, description) {
  writeJson(join(dir, skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: ${description}\n---\n\nBody of ${skillName}.\n`)
}

describe('repo skills for workspace-file sessions', () => {
  let cleanup, p, policy, ctx, lifecycle, provider

  before(async () => {
    let base
    ;[base, cleanup] = tempHomeDir()
    p = buildFixture(base)
    writeSkill(join(p.blumRepo, '.agents', 'skills'), 'run-work', 'Run the next work item')
    writeSkill(join(p.leasityRepo, '.agents', 'skills'), 'leasity-only', 'Not in the Blum scope')
    ctx = new Context()
    ctx.provide('storageDomain', memoryStorageDomain())
    ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => null })
    await ctx.plugin(WorkspaceRootsPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: p.outside,
      scopesRoot: p.git,
      deniedWritePaths: [p.diarios],
    })
    policy = ctx.get('sandboxPolicy')
    lifecycle = new AbortController()
    provider = new RepoSkillProvider(ctx, { signal: lifecycle.signal, invalidate: () => {} }, (cwd) => policy.scopeFolders(cwd))
  })
  after(() => {
    lifecycle?.abort()
    cleanup?.()
  })

  test('scopeFolders lists the repos inside the scope only for the scope folder itself', async () => {
    assert.deepEqual(policy.scopeFolders(p.blum), [p.blumRepo])
    assert.deepEqual(policy.scopeFolders(p.blumRepo), [])
    assert.deepEqual(policy.scopeFolders(p.outside), [])
    assert.deepEqual(policy.scopeFolders(p.git), [])
    assert.deepEqual(policy.scopeFolders(p.leasity), [p.leasityRepo])
  })

  test('scopeFolders follows the active workspace file', async () => {
    await policy.selection.setActiveFile(p.leasity, join(p.leasity, 'Leasity - Core.code-workspace'))
    try {
      assert.deepEqual(policy.scopeFolders(p.leasity), [p.leasityRepo])
    } finally {
      await policy.selection.setActiveFile(p.leasity, null)
    }
  })

  test('a scope-folder lookup lists and loads the repo skills', async () => {
    const listed = await provider.list({ cwd: p.blum })
    assert.ok(Array.isArray(listed))
    assert.deepEqual(listed.map((skill) => skill.name), ['run-work'])
    assert.equal(listed[0].provider ?? PROVIDER, PROVIDER)
    const loaded = await provider.get(listed[0], { cwd: p.blum })
    assert.equal(loaded.name, 'run-work')
    assert.match(loaded.content, /Body of run-work\./)
  })

  test('lookups from inside a repo, outside the scopes or without a cwd list nothing', async () => {
    assert.deepEqual(await provider.list({ cwd: p.blumRepo }), [])
    assert.deepEqual(await provider.list({ cwd: p.outside }), [])
    assert.deepEqual(await provider.list({}), [])
  })
})
