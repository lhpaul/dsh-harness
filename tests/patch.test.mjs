/**
 * Patch script behavior on a COPY of the installed runtime files in a temp
 * install root: revert to pristine, apply, idempotence, --check exit codes,
 * all-or-nothing failure on a missing anchor, legacy-backup cleanup.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import { EXIT, HUNKS, MARKER } from '../patch/dsh-multi-root.mjs'
import { INSTALL_ROOT, REPO, tempHomeDir } from './helpers.mjs'

const PACKAGES = ['dsh-sandbox', 'dsh-sandbox-local', 'dsh-fs-sandbox', 'dsh-sandbox-policy']
const SCRIPT = join(REPO, 'patch', 'dsh-multi-root.mjs')

function cli(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--install-root', root, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const lib = (root, pkg) => join(root, pkg, 'lib', 'index.js')
const snapshot = (root) => Object.fromEntries(PACKAGES.map((pkg) => [pkg, readFileSync(lib(root, pkg), 'utf8')]))

describe('patch/dsh-multi-root.mjs', () => {
  let dir, cleanup, root
  const dirs = []
  beforeEach(() => {
    ;[dir, cleanup] = tempHomeDir()
    dirs.push(cleanup)
    root = join(dir, '@deepseek-ai')
    for (const pkg of PACKAGES) {
      mkdirSync(join(root, pkg, 'lib'), { recursive: true })
      copyFileSync(lib(INSTALL_ROOT, pkg), lib(root, pkg))
      copyFileSync(join(INSTALL_ROOT, pkg, 'package.json'), join(root, pkg, 'package.json'))
    }
    assert.equal(cli(root, '--revert').code, EXIT.ok)
  })
  after(() => dirs.forEach((done) => done()))

  test('revert leaves pristine files: every anchor present, no marker', () => {
    for (const hunk of HUNKS) {
      const text = readFileSync(lib(root, hunk.pkg), 'utf8')
      assert.ok(text.includes(hunk.from), hunk.label)
      assert.ok(!text.includes(MARKER), hunk.label)
    }
    assert.equal(cli(root, '--check').code, EXIT.notApplied)
  })

  test('apply patches every hunk; re-apply is a byte-identical no-op; check reports applied', () => {
    const pristine = snapshot(root)
    const first = cli(root)
    assert.equal(first.code, EXIT.ok, first.err)
    assert.match(first.out, /applied \(3\)/)
    const patched = snapshot(root)
    assert.notDeepEqual(patched, pristine)
    assert.equal(patched['dsh-sandbox-policy'], pristine['dsh-sandbox-policy'], 'sandbox-policy is never touched')
    const second = cli(root)
    assert.equal(second.code, EXIT.ok)
    assert.match(second.out, /already applied \(unchanged\) \(3\)/)
    assert.doesNotMatch(second.out, /wrote/)
    assert.deepEqual(snapshot(root), patched)
    assert.equal(cli(root, '--check').code, EXIT.ok)
  })

  test('apply then revert round-trips to the pristine bytes', () => {
    const pristine = snapshot(root)
    cli(root)
    assert.equal(cli(root, '--revert').code, EXIT.ok)
    assert.deepEqual(snapshot(root), pristine)
  })

  test('a missing anchor fails loudly and writes nothing', () => {
    const path = lib(root, 'dsh-fs-sandbox')
    writeFileSync(path, readFileSync(path, 'utf8').replace('return fresh;', 'return fresh ;'))
    const before = snapshot(root)
    const r = cli(root)
    assert.equal(r.code, EXIT.broken)
    assert.match(r.err, /FAILED.*\n.*dsh-fs-sandbox.*anchor missing/)
    assert.deepEqual(snapshot(root), before, 'all-or-nothing: no other file was written')
    assert.equal(cli(root, '--check').code, EXIT.broken)
    assert.equal(cli(root, '--revert').code, EXIT.broken)
  })

  test('an ambiguous anchor fails loudly', () => {
    const path = lib(root, 'dsh-sandbox')
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, `${text}\n/*\n${HUNKS[0].from}\n*/\n`)
    const r = cli(root)
    assert.equal(r.code, EXIT.broken)
    assert.match(r.err, /anchor ambiguous/)
  })

  test('legacy ~/.dsh/local backups are restored, legacy hunk upgraded', () => {
    const pristine = snapshot(root)
    const sandboxPath = lib(root, 'dsh-sandbox')
    const policyPath = lib(root, 'dsh-sandbox-policy')
    copyFileSync(sandboxPath, `${sandboxPath}.dsh-multiroot.bak`)
    copyFileSync(policyPath, `${policyPath}.dsh-multiroot.bak`)
    writeFileSync(sandboxPath, pristine['dsh-sandbox'].replace(HUNKS[0].from, HUNKS[0].legacy[0]))
    writeFileSync(policyPath, pristine['dsh-sandbox-policy'].replace('workspaceRoot: z$1.string()', 'workspaceRoot: z$1.string(),\n\t\tadditionalWorkspaceRoots: z$1.array(z$1.string()).default([])'))
    const r = cli(root)
    assert.equal(r.code, EXIT.ok, r.err)
    assert.match(r.out, /restored legacy backup/)
    assert.ok(!existsSync(`${sandboxPath}.dsh-multiroot.bak`) && !existsSync(`${policyPath}.dsh-multiroot.bak`))
    assert.equal(readFileSync(policyPath, 'utf8'), pristine['dsh-sandbox-policy'])
    assert.equal(cli(root, '--check').code, EXIT.ok)
  })

  test('a legacy hunk without backup is upgraded in place', () => {
    const path = lib(root, 'dsh-sandbox')
    writeFileSync(path, readFileSync(path, 'utf8').replace(HUNKS[0].from, HUNKS[0].legacy[0]))
    const r = cli(root)
    assert.equal(r.code, EXIT.ok, r.err)
    assert.match(r.out, /upgraded from legacy/)
    assert.equal(cli(root, '--check').code, EXIT.ok)
  })

  test('usage errors exit 2; a missing install exits 1', () => {
    assert.equal(cli(root, '--bogus').code, EXIT.usage)
    assert.equal(cli(root, '--check', '--revert').code, EXIT.usage)
    assert.equal(cli(join(dir, 'nope')).code, EXIT.broken)
  })
})
