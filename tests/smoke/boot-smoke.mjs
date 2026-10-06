#!/usr/bin/env node
/**
 * Boot smoke: boots the real `dsh web` app from bin/dsh with the
 * dsh-lh-workspace-roots bundle in an ISOLATED setup — a temp DSH_HOME and a
 * temp HOME holding a fixture ~/Git (Blum, Leasity, vault with Diarios) — plus
 * a probe plugin (via --patch) that resolves policies for fixture sessions and
 * writes through the app's own ctx.sandbox (Seatbelt) and ctx.fs (fs fence),
 * using real agents/sessions, then queries ctx.fileReferences (`@` completion)
 * across roots and checks the add_workspace_root tool and grants projection.
 * Never touches ~/.dsh or the real ~/Git.
 *
 * Usage: node tests/smoke/boot-smoke.mjs   (exit 0 pass, 1 fail)
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { REPO, buildFixture, tempHomeDir } from '../helpers.mjs'

const [base, cleanup] = tempHomeDir('.dsh-harness-smoke-')
const p = buildFixture(base)
const dshHome = join(base, 'dsh-home')
const out = join(base, 'probe.json')
const DSH = join(REPO, 'bin', 'dsh')

const probe = `
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'lh-smoke-probe'
export const inject = ['sandboxPolicy', 'sandbox', 'fs', 'fileReferences', 'agents', 'sessionProjections', 'tools', 'workspaceFiles', 'typertGateway', 'clientModules', 'directoryPicker', 'skills']
export function apply(ctx, config) {
  const cases = config.cases
  const run = async () => {
    const result = { provider: ctx.sandboxPolicy.constructor.name, deniedWritePaths: ctx.sandboxPolicy.deniedWritePaths, cases: [] }
    const handles = new Map()
    const agentFor = async (cwd) => {
      if (!handles.has(cwd)) handles.set(cwd, await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd } }))
      return handles.get(cwd).agent
    }
    for (const c of cases) {
      const session = (await agentFor(c.cwd)).session
      const policy = ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' })
      const target = join(c.dir, 'smoke-' + c.id)
      const { argv } = await ctx.sandbox.confine(['/bin/sh', '-c', "printf x > '" + target + ".bash'"], policy)
      const bash = spawnSync(argv[0], argv.slice(1)).status === 0
      let fs
      try { await ctx.fs.writeText(await ctx.fs.resolve(target + '.fs'), 'x', undefined, undefined, policy); fs = true }
      catch (e) { fs = e.code === 'FS_SANDBOX_DENIED' ? false : String(e) }
      result.cases.push({ ...c, bash, fs, workspaceRoots: policy.workspaceRoots ?? [] })
    }
    const blum = await agentFor(config.refs.cwd)
    result.grants = {
      tool: ctx.tools.get('add_workspace_root', blum) !== undefined,
      state: ctx.sessionProjections.stateOf(blum.session, 'workspaceRootGrants'),
    }
    const signal = new AbortController().signal
    result.refs = {
      provider: ctx.fileReferences.constructor.name,
      asset: await ctx.fileReferences.list(blum, 'smoke-blum-assets', signal),
      diarios: await ctx.fileReferences.list(blum, 'secret-entry', signal),
    }
    const listVia = (path) => ctx.typertGateway
      .invoke({ namespace: 'workspaceFiles', method: 'list', args: { workspaceFileScopeId: blum.session.id, path } })
      .then((listing) => listing.entries.map((entry) => entry.name), (e) => 'error:' + (e.code ?? e.message))
    const original = ctx.workspaceFiles[Symbol.for('cordis.original')] ?? ctx.workspaceFiles
    result.files = {
      provider: ctx.workspaceFiles.constructor.name,
      anchored: Object.hasOwn(original, 'list') && Object.hasOwn(original, 'changes'),
      extraRoot: await listVia(config.files.extraRoot),
      outside: await listVia(config.files.outside),
      rootsListing: await listVia('/.dsh-lh-workspace-roots'),
      clientBundles: ['dsh-lh-workspace-roots', '@deepseek-ai/dsh-api-workspace-files'].filter((id) => ctx.clientModules.table.has(id)),
    }
    const skillNames = async (cwd) => (await ctx.skills.list({ cwd, scope: await agentFor(cwd) }))
      .filter((skill) => skill.name.startsWith('smoke-')).map((skill) => skill.name + '@' + skill.provider)
    result.skills = { scope: await skillNames(config.skills.scope), repo: await skillNames(config.skills.repo) }
    const capability = ctx.directoryPicker.capability()
    const rootsOf = (session) => ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }).workspaceRoots ?? []
    const opened = await ctx.sandboxPolicy.openPicked(config.selection.file)
    const fresh = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: config.selection.scope } })
    result.selection = {
      pickerKind: capability.kind,
      pickerOverridden: String(capability.pick).includes('openPicked'),
      opened,
      fresh: rootsOf(fresh.agent.session),
      earlier: rootsOf(blum.session),
    }
    await ctx.sandboxPolicy.openPicked(config.selection.scope)
    await fresh.dispose()
    for (const handle of handles.values()) await handle.dispose()
    writeFileSync(config.out, JSON.stringify(result, null, 2))
  }
  run().catch((e) => writeFileSync(config.out, JSON.stringify({ error: String(e && e.stack || e) })))
}
`
const cases = [
  { id: 'blum-assets', cwd: p.blum, dir: p.assetsBlum, expect: true },
  { id: 'blum-vault', cwd: p.blum, dir: p.vault, expect: true },
  { id: 'blum-diarios', cwd: p.blum, dir: p.diarios, expect: false },
  { id: 'blum-outside', cwd: p.blum, dir: p.outside, expect: false },
  { id: 'leasity-assets', cwd: p.leasityRepo, dir: p.assetsLeasity, expect: true },
  { id: 'leasity-blum', cwd: p.leasityRepo, dir: p.assetsBlum, expect: false },
]
writeFileSync(join(p.diarios, 'secret-entry.md'), 'x')
mkdirSync(join(p.blumRepo, '.agents', 'skills', 'smoke-repo-skill'), { recursive: true })
writeFileSync(join(p.blumRepo, '.agents', 'skills', 'smoke-repo-skill', 'SKILL.md'), '---\nname: smoke-repo-skill\ndescription: Repo skill of the smoke fixture\n---\n\nBody.\n')
writeFileSync(join(base, 'probe.mjs'), probe)
writeFileSync(join(base, 'probe.patch.yml'), `- insert:\n    - id: lh-smoke-probe\n      name: ./probe.mjs\n      config: ${JSON.stringify({ out, cases, refs: { cwd: p.blum }, files: { extraRoot: p.assetsBlum, outside: p.outside }, selection: { file: join(p.blum, 'Blum - BAUM.code-workspace'), scope: p.blum }, skills: { scope: p.blum, repo: p.blumRepo } })}\n`)

let child
let code = 1
try {
  const env = { ...process.env, DSH_HOME: dshHome }
  const add = spawnSync(DSH, ['plugin', '--profile', 'web', 'add', join(REPO, 'packages', 'workspace-roots')], { env, encoding: 'utf8' })
  if (add.status !== 0) throw new Error(`plugin add failed:\n${add.stdout}\n${add.stderr}`)
  const port = String(38000 + Math.floor(Math.random() * 1000))
  child = spawn(DSH, ['--profile', 'web', '--patch', join(base, 'probe.patch.yml'), '--no-open', '--port', port], {
    env: { ...env, HOME: p.home },
    cwd: p.home,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  const deadline = Date.now() + 60_000
  while (!existsSync(out) && Date.now() < deadline && child.exitCode === null) await sleep(250)
  if (!existsSync(out)) throw new Error(`probe produced no result (exit ${child.exitCode}).\n${log}`)
  const result = JSON.parse(readFileSync(out, 'utf8'))
  if (result.error) throw new Error(`probe failed: ${result.error}\n${log}`)
  console.log(`ctx.sandboxPolicy provider: ${result.provider}`)
  console.log(`deniedWritePaths (from bundle config, HOME-relative): ${JSON.stringify(result.deniedWritePaths)}`)
  let failures = result.provider === 'WorkspaceRootsPolicyService' && result.deniedWritePaths?.[0] === p.diarios ? 0 : 1
  for (const c of result.cases) {
    const ok = c.bash === c.expect && c.fs === c.expect
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(16)} expect=${c.expect ? 'ALLOW' : 'DENY '} bash=${c.bash} fs=${c.fs}`)
  }
  const refs = result.refs
  const assetPaths = refs.asset.map((c) => c.path)
  const refsOk = refs.provider === 'MultiRootFileReferenceService'
    && assetPaths.includes(join(p.assetsBlum, 'smoke-blum-assets.bash'))
    && refs.diarios.length === 0
  if (!refsOk) failures += 1
  console.log(`${refsOk ? 'PASS' : 'FAIL'}  @ completion     provider=${refs.provider} extra-root=${JSON.stringify(assetPaths)} diarios=${JSON.stringify(refs.diarios)}`)
  const grantsOk = result.grants.tool === true
    && JSON.stringify(result.grants.state) === JSON.stringify({ pending: [], roots: [] })
  if (!grantsOk) failures += 1
  console.log(`${grantsOk ? 'PASS' : 'FAIL'}  root grants      add_workspace_root registered=${result.grants.tool} projection=${JSON.stringify(result.grants.state)}`)
  const files = result.files
  const loaderErrors = log.split('\n').filter((line) => /typert-loader:|client-modules:/.test(line))
  const filesOk = files.provider === 'WorkspaceFiles'
    && files.anchored === true
    && Array.isArray(files.extraRoot) && files.extraRoot.includes('smoke-blum-assets.bash')
    && files.outside === 'error:workspace-file/outside-workspace'
    && Array.isArray(files.rootsListing) && files.rootsListing.includes(p.assetsBlum) && files.rootsListing.includes(p.vault)
    && files.clientBundles.length === 2
    && loaderErrors.length === 0
  if (!filesOk) failures += 1
  console.log(`${filesOk ? 'PASS' : 'FAIL'}  web file tree    provider=${files.provider} anchored=${files.anchored} extra-root=${JSON.stringify(files.extraRoot)} outside=${files.outside} roots-listing=${JSON.stringify(files.rootsListing)} client-bundles=${JSON.stringify(files.clientBundles)}${loaderErrors.length ? ` errors=${JSON.stringify(loaderErrors)}` : ''}`)
  const sel = result.selection
  const selectionOk = sel.pickerKind === 'native'
    && sel.pickerOverridden === true
    && sel.opened === p.blum
    && sel.fresh.includes(p.shared) && !sel.fresh.includes(p.assetsBlum)
    && sel.earlier.includes(p.assetsBlum)
  if (!selectionOk) failures += 1
  console.log(`${selectionOk ? 'PASS' : 'FAIL'}  workspace file   picker=${sel.pickerKind} overridden=${sel.pickerOverridden} opened=${sel.opened} new-session=${JSON.stringify(sel.fresh)} earlier-session=${JSON.stringify(sel.earlier)}`)
  const skills = result.skills
  // Probe agents mount no preset, so upstream's per-preset skill-filesystem lists nothing here.
  const skillsOk = JSON.stringify(skills.scope) === '["smoke-repo-skill@lh-workspace-repos"]'
    && !skills.repo.includes('smoke-repo-skill@lh-workspace-repos')
  if (!skillsOk) failures += 1
  console.log(`${skillsOk ? 'PASS' : 'FAIL'}  repo skills      scope-folder=${JSON.stringify(skills.scope)} inside-repo=${JSON.stringify(skills.repo)}`)
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(10_000)])
  code = failures === 0 ? 0 : 1
  console.log(code === 0 ? 'PASS — the booted app enforces per-session roots' : `FAIL — ${failures} problem(s)`)
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  cleanup()
}
process.exit(code)
