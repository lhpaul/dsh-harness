#!/usr/bin/env node
/**
 * dsh-multi-root-verify — end-to-end check of the multi-root patch through the
 * REAL installed modules: `LocalSandboxProvider.confine()` (Seatbelt via
 * /usr/bin/sandbox-exec) and `SandboxedFileSystem.writeText()` (the in-process
 * fs fence), against temp directories under $HOME (never /tmp, which every
 * workspace-write policy grants).
 *
 * Expectations under workspace-write with
 *   workspaceRoot = project, workspaceRoots = [second], deniedWritePaths = [second/Private]:
 *   project          ALLOW   primary root
 *   second           ALLOW   extra root
 *   second/Private   DENY    denied path inside an extra root
 *   rename second/Private away (bash only)  DENY
 *   outside          DENY    negative control
 *
 * Usage: node patch/dsh-multi-root-verify.mjs [--install-root DIR]
 * Exit: 0 pass, 1 fail, 2 not macOS / not installed.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const idx = argv.indexOf('--install-root')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installRoot = idx !== -1
  ? resolve(argv[idx + 1])
  : resolve(process.env.DSH_INSTALL_ROOT ?? join(repo, 'node_modules', '@deepseek-ai'))

if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
  console.error('dsh-multi-root-verify: macOS Seatbelt only (see README for the Linux gap)')
  process.exit(2)
}
const lib = (pkg) => join(installRoot, pkg, 'lib', 'index.js')
if (!existsSync(lib('dsh-sandbox-local'))) {
  console.error(`dsh-multi-root-verify: no runtime under ${installRoot}`)
  process.exit(2)
}

const load = (pkg) => import(pathToFileURL(lib(pkg)).href)
const { Context } = await load('cordis')
const { LocalSandboxProvider } = await load('dsh-sandbox-local')
const { SandboxedFileSystem } = await load('dsh-fs-sandbox')

const base = realpathSync(mkdtempSync(join(homedir(), '.dsh-harness-verify-')))
const dirs = {
  project: join(base, 'project'),
  second: join(base, 'second'),
  denied: join(base, 'second', 'Private'),
  outside: join(base, 'outside'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

const policy = {
  mode: 'workspace-write',
  workspaceRoot: dirs.project,
  workspaceRoots: [dirs.second],
  deniedWritePaths: [dirs.denied],
}

const ctx = new Context()
ctx.provide('sandboxPolicy', { resolve: () => policy, defaultMode: policy.mode, workspaceRoot: dirs.project })
await ctx.plugin(LocalSandboxProvider, {})
await ctx.plugin(SandboxedFileSystem, {})

async function bash(command) {
  const { argv: wrapped } = await ctx.get('sandbox').confine(['/bin/sh', '-c', command], policy)
  try {
    execFileSync(wrapped[0], wrapped.slice(1), { stdio: 'pipe' })
    return true
  } catch {
    // The confined command failed: Seatbelt denied the write (or the shell errored), reported as DENY.
    return false
  }
}

async function fsWrite(path) {
  const fs = ctx.get('fs')
  try {
    await fs.writeText(await fs.resolve(path), 'x', undefined, undefined, policy)
    return true
  } catch (error) {
    if (error?.code === 'FS_SANDBOX_DENIED') return false
    throw error
  }
}

const q = (p) => `'${p.replaceAll("'", "'\\''")}'`
const cases = [
  ['project', true, () => bash(`printf x > ${q(join(dirs.project, 'b.txt'))}`), () => fsWrite(join(dirs.project, 'f.txt'))],
  ['second (extra root)', true, () => bash(`printf x > ${q(join(dirs.second, 'b.txt'))}`), () => fsWrite(join(dirs.second, 'f.txt'))],
  ['second/Private (denied)', false, () => bash(`printf x > ${q(join(dirs.denied, 'b.txt'))}`), () => fsWrite(join(dirs.denied, 'f.txt'))],
  ['rename denied dir away', false, () => bash(`mv ${q(dirs.denied)} ${q(join(dirs.second, 'moved'))}`), null],
  ['outside (control)', false, () => bash(`printf x > ${q(join(dirs.outside, 'b.txt'))}`), () => fsWrite(join(dirs.outside, 'f.txt'))],
]

let failures = 0
console.log(`install root: ${installRoot}\n`)
console.log('case                        expect  bash    fs      verdict')
console.log('-------------------------------------------------------------')
for (const [label, expected, viaBash, viaFs] of cases) {
  const b = await viaBash()
  const f = viaFs === null ? null : await viaFs()
  const ok = b === expected && (f === null || f === expected)
  if (!ok) failures += 1
  const cell = (v) => (v === null ? '-     ' : v ? 'ALLOW ' : 'DENY  ')
  console.log(`${label.padEnd(28)}${cell(expected)}  ${cell(b)}  ${cell(f)}  ${ok ? 'PASS' : 'FAIL'}`)
}

ctx.registry.delete?.(LocalSandboxProvider)
rmSync(base, { recursive: true, force: true })

console.log()
if (failures === 0) {
  console.log('PASS — extra roots are writable, denied paths and everything outside stay denied.')
  process.exit(0)
}
console.log(`FAIL — ${failures} case(s) behaved unexpectedly (is the patch applied? node patch/dsh-multi-root.mjs --check)`)
process.exit(1)
