#!/usr/bin/env node
/**
 * dsh-multi-root — teach an installed DeepSeek Harness runtime to enforce
 * extra writable roots and denied write paths carried on the sandbox policy.
 *
 * The policy fields are produced per session by the `dsh-lh-workspace-roots`
 * plugin (packages/workspace-roots). Upstream derives the writable allow-list in
 * one helper, `writableRoots(policy)` in `@deepseek-ai/dsh-sandbox`, consumed by
 * the macOS Seatbelt profile (`dsh-sandbox-local`) and the in-process fs fence
 * (`dsh-fs-sandbox`) through direct imports. A plugin cannot reach those, so
 * three hunks are applied to the built `lib/index.js` files:
 *
 *   1. dsh-sandbox       writableRoots() also returns policy.workspaceRoots
 *   2. dsh-sandbox-local Seatbelt profile denies writes under policy.deniedWritePaths
 *                        (subpath) and to each ancestor directory (literal), so
 *                        the denied tree cannot be renamed away
 *   3. dsh-fs-sandbox    write/edit fence rejects targets under policy.deniedWritePaths
 *
 * Linux (bwrap / Landlock) is NOT covered: those dialects read the scalar
 * workspaceRoot. See README.md.
 *
 * Contract:
 *   - Every hunk is an exact string anchor that must match exactly once.
 *   - All-or-nothing: if any anchor is missing or ambiguous, nothing is written
 *     and the script exits 1 with the list of failed hunks.
 *   - Idempotent: an already-patched file is left byte-identical (not rewritten).
 *   - Every patched file is syntax-checked with `node --check` before an atomic
 *     rename replaces the original.
 *   - --revert reverse-applies the hunks (no backup files needed) and restores
 *     files left by the legacy ~/.dsh/local script from their .dsh-multiroot.bak.
 *
 * Usage:
 *   node patch/dsh-multi-root.mjs                    apply
 *   node patch/dsh-multi-root.mjs --check            report only; exit 0 applied, 3 not applied, 1 broken
 *   node patch/dsh-multi-root.mjs --revert           restore the pristine files
 *   node patch/dsh-multi-root.mjs --install-root DIR target DIR (= .../node_modules/@deepseek-ai)
 *   DSH_INSTALL_ROOT=DIR node patch/dsh-multi-root.mjs
 *
 * Default install root: <repo>/node_modules/@deepseek-ai (the pinned runtime).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER = '/* dsh-harness:multi-root */'
const LEGACY_BAK = '.dsh-multiroot.bak'

/** Exit codes, also used by bootstrap.sh. */
export const EXIT = { ok: 0, broken: 1, usage: 2, notApplied: 3 }

/**
 * The hunks, keyed by package. `from` is the pristine upstream text,
 * `to` the patched text; `legacy` lists texts an earlier script produced
 * that are upgraded in place.
 */
export const HUNKS = [
  {
    pkg: 'dsh-sandbox',
    label: 'dsh-sandbox: writableRoots() honors policy.workspaceRoots',
    from: `\treturn [...new Set([
\t\tpolicy.workspaceRoot,
\t\t"/tmp",
\t\ttmpdir()
\t].map(canonicalPath))];`,
    to: `\treturn [...new Set([
\t\tpolicy.workspaceRoot,
\t\t...(policy.workspaceRoots ?? []), ${MARKER}
\t\t"/tmp",
\t\ttmpdir()
\t].map(canonicalPath))];`,
    legacy: [`\treturn [...new Set([
\t\tpolicy.workspaceRoot,
\t\t...(policy.workspaceRoots ?? []),
\t\t"/tmp",
\t\ttmpdir()
\t].map(canonicalPath))];`],
  },
  {
    pkg: 'dsh-sandbox-local',
    label: 'dsh-sandbox-local: Seatbelt profile denies policy.deniedWritePaths',
    from: `\tif (roots.length > 0) forms.push(\`(allow file-write* \${roots.map((root) => \`(subpath \${sbplString(root)})\`).join(" ")})\`);
\treturn ["-p", forms.join(" ")];`,
    to: `\tif (roots.length > 0) forms.push(\`(allow file-write* \${roots.map((root) => \`(subpath \${sbplString(root)})\`).join(" ")})\`);
\tif (roots.length > 0) for (const denied of (policy.deniedWritePaths ?? []).map(canonicalPath)) { ${MARKER}
\t\tconst parts = denied.split("/");
\t\tconst ancestors = parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join("/"));
\t\tforms.push(\`(deny file-write* (subpath \${sbplString(denied)})\${ancestors.map((a) => \` (literal \${sbplString(a)})\`).join("")})\`);
\t}
\treturn ["-p", forms.join(" ")];`,
    legacy: [],
  },
  {
    pkg: 'dsh-fs-sandbox',
    label: 'dsh-fs-sandbox: write/edit fence rejects policy.deniedWritePaths',
    from: `\t\tif (!contained) throw new FsError(\`cannot write "\${target.displayPath}": file access denied under workspace-write mode\`, "FS_SANDBOX_DENIED");
\t\treturn fresh;`,
    to: `\t\tif (!contained) throw new FsError(\`cannot write "\${target.displayPath}": file access denied under workspace-write mode\`, "FS_SANDBOX_DENIED");
\t\tfor (const denied of policy.deniedWritePaths ?? []) if (await isPathUnder(fresh.targetKey, denied)) throw new FsError(\`cannot write "\${target.displayPath}": file access denied under workspace-write mode\`, "FS_SANDBOX_DENIED"); ${MARKER}
\t\treturn fresh;`,
    legacy: [],
  },
]

/** Packages the legacy ~/.dsh/local script edited and backed up. */
const LEGACY_PACKAGES = ['dsh-sandbox', 'dsh-sandbox-policy']

const libPath = (root, pkg) => join(root, pkg, 'lib', 'index.js')

function count(text, needle) {
  let n = 0
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n += 1
  return n
}

/**
 * Classify one hunk against the current file text.
 * @returns {{ state: 'applied' | 'pristine' | 'legacy' | 'missing' | 'ambiguous', legacyText?: string }}
 */
export function classify(text, hunk) {
  const to = count(text, hunk.to)
  const from = count(text, hunk.from)
  if (to === 1 && from === 0) return { state: 'applied' }
  if (to > 1 || from > 1 || (to === 1 && from === 1)) return { state: 'ambiguous' }
  if (from === 1) return { state: 'pristine' }
  for (const legacyText of hunk.legacy) {
    if (count(text, legacyText) === 1) return { state: 'legacy', legacyText }
  }
  return { state: 'missing' }
}

function syntaxOk(source) {
  const probe = join(tmpdir(), `dsh-harness-probe-${process.pid}-${Date.now()}.mjs`)
  writeFileSync(probe, source)
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: String(error.stderr ?? error.message) }
  } finally {
    unlinkSync(probe)
  }
}

function atomicWrite(path, next) {
  const tmp = `${path}.dsh-harness.tmp`
  writeFileSync(tmp, next)
  renameSync(tmp, path)
}

/**
 * Run the patcher.
 * @param {{ installRoot: string, mode: 'apply' | 'check' | 'revert', log?: (line: string) => void, error?: (line: string) => void }} options
 * @returns {number} the process exit code
 */
export function run({ installRoot, mode, log = console.log, error = console.error }) {
  const err = error
  if (!existsSync(libPath(installRoot, 'dsh-sandbox'))) {
    err(`dsh-multi-root: no @deepseek-ai/dsh-sandbox under ${installRoot}`)
    err('  Run `npm ci` in the dsh-harness repo, or pass --install-root <node_modules/@deepseek-ai>.')
    return EXIT.broken
  }
  const version = JSON.parse(readFileSync(join(installRoot, 'dsh-sandbox', 'package.json'), 'utf8')).version
  log(`install root : ${installRoot}`)
  log(`dsh-sandbox  : ${version}`)
  log(`mode         : ${mode}`)

  // Legacy cleanup: the ~/.dsh/local script kept pristine copies as .dsh-multiroot.bak.
  const legacyBaks = LEGACY_PACKAGES.map((pkg) => libPath(installRoot, pkg)).filter((p) => existsSync(p + LEGACY_BAK))
  if (mode === 'check') {
    for (const p of legacyBaks) log(`  legacy backup present (will be restored on apply/revert): ${p}${LEGACY_BAK}`)
  } else {
    for (const p of legacyBaks) {
      copyFileSync(p + LEGACY_BAK, p)
      unlinkSync(p + LEGACY_BAK)
      log(`  restored legacy backup: ${p}`)
    }
  }
  const policyText = readFileSync(libPath(installRoot, 'dsh-sandbox-policy'), 'utf8')
  if (mode !== 'check' && policyText.includes('additionalWorkspaceRoots')) {
    err('dsh-multi-root: dsh-sandbox-policy still carries legacy edits and has no backup.')
    err('  Reinstall the runtime (`rm -rf node_modules && npm ci`) and re-run.')
    return EXIT.broken
  }

  const files = new Map()
  for (const hunk of HUNKS) {
    const path = libPath(installRoot, hunk.pkg)
    if (!files.has(path)) files.set(path, { original: readFileSync(path, 'utf8') })
  }
  for (const entry of files.values()) entry.next = entry.original

  const report = { applied: [], already: [], reverted: [], pristine: [], failed: [] }
  for (const hunk of HUNKS) {
    const entry = files.get(libPath(installRoot, hunk.pkg))
    const { state, legacyText } = classify(entry.next, hunk)
    if (state === 'missing' || state === 'ambiguous') {
      report.failed.push(`${hunk.label} — anchor ${state}`)
      continue
    }
    if (mode === 'revert') {
      if (state === 'applied') {
        entry.next = entry.next.replace(hunk.to, () => hunk.from)
        report.reverted.push(hunk.label)
      } else if (state === 'legacy') {
        entry.next = entry.next.replace(legacyText, () => hunk.from)
        report.reverted.push(`${hunk.label} (legacy)`)
      } else {
        report.pristine.push(hunk.label)
      }
      continue
    }
    if (state === 'applied') {
      report.already.push(hunk.label)
    } else {
      if (mode === 'apply') entry.next = entry.next.replace(state === 'legacy' ? legacyText : hunk.from, () => hunk.to)
      report.applied.push(state === 'legacy' ? `${hunk.label} (upgraded from legacy)` : hunk.label)
    }
  }

  if (report.failed.length > 0) {
    err('\nFAILED — these hunks do not match the installed runtime; nothing was written:')
    for (const line of report.failed) err(`  ${line}`)
    err('\nThe runtime is probably a different DSH version than this patch targets.')
    err('Re-derive the anchors from the new lib/index.js files (see README "Upgrade routine").')
    return EXIT.broken
  }

  if (mode === 'apply' || mode === 'revert') {
    for (const [path, entry] of files) {
      if (entry.next === entry.original) continue
      const check = syntaxOk(entry.next)
      if (!check.ok) {
        err(`dsh-multi-root: refusing to write ${path}: result fails node --check\n${check.detail}`)
        return EXIT.broken
      }
    }
    for (const [path, entry] of files) {
      if (entry.next === entry.original) continue
      atomicWrite(path, entry.next)
      log(`  wrote ${path}`)
    }
  }

  const section = (title, list) => { if (list.length > 0) log(`\n${title} (${list.length}):\n  ${list.join('\n  ')}`) }
  if (mode === 'check') {
    section('already applied', report.already)
    section('NOT applied', report.applied)
    return report.applied.length === 0 ? EXIT.ok : EXIT.notApplied
  }
  if (mode === 'revert') {
    section('reverted', report.reverted)
    section('already pristine', report.pristine)
    return EXIT.ok
  }
  section('applied', report.applied)
  section('already applied (unchanged)', report.already)
  if (report.applied.length > 0) log('\nRestart `dsh web` so the patched modules load.')
  return EXIT.ok
}

function parseArgs(argv) {
  const known = new Set(['--check', '--revert', '--install-root'])
  for (let i = 0; i < argv.length; i += 1) {
    if (!known.has(argv[i])) return { error: `unknown argument: ${argv[i]}` }
    if (argv[i] === '--install-root') i += 1
  }
  if (argv.includes('--check') && argv.includes('--revert')) return { error: '--check and --revert are exclusive' }
  const idx = argv.indexOf('--install-root')
  if (idx !== -1 && argv[idx + 1] === undefined) return { error: '--install-root needs a directory' }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const installRoot = idx !== -1
    ? resolve(argv[idx + 1])
    : process.env.DSH_INSTALL_ROOT
      ? resolve(process.env.DSH_INSTALL_ROOT)
      : join(repo, 'node_modules', '@deepseek-ai')
  const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply'
  return { installRoot, mode }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`dsh-multi-root: ${args.error}`)
    process.exit(EXIT.usage)
  }
  process.exit(run(args))
}
