/**
 * Extra-root directory listings for upstream `ctx.workspaceFiles` (the Web
 * file trees).
 *
 * Upstream `WorkspaceFiles` confines directory listings and directory watches
 * to the session cwd. This plugin keeps the upstream row as is — it also
 * carries the strict typert descriptors and the browser `file` resource
 * provider, which a replacement row would lose — and installs `list` and
 * `changes` as own properties of the live service instance. Each re-anchors an
 * absolute path inside one of the session's extra roots to that root, then
 * calls the upstream method, whose containment check runs against it. The API
 * Gateway looks Remote methods up by name on the instance, so both Remote
 * calls reach these overrides. File reads are untouched: upstream already
 * follows fs read access outside the workspace.
 *
 * The overrides live as long as this plugin and that instance: Cordis restarts
 * this plugin when the service is replaced, and disposal deletes them.
 *
 * Extra roots come from `ctx.sandboxPolicy` (dsh-lh-workspace-roots): a loaded
 * session resolves its workspace-file roots plus its grants; a session that is
 * not loaded only its workspace-file roots (`storedSessionRoots`). Denied write paths are listed like
 * any other directory: the trees are the user's view and never reach a model.
 * `list` also answers the reserved {@link ROOTS_LISTING} path, which the Roots
 * tab and the session hover card read.
 *
 * @module dsh-lh-workspace-roots/workspace-files
 */

import { isAbsolute } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { canonical, isWithin } from './roots.js'

export const name = 'dsh-lh-workspace-roots/workspace-files'

export const inject = ['workspaceFiles', 'sandboxPolicy', 'sessions']

/** Upstream `WorkspaceFiles` methods whose directory confinement is re-anchored. */
const ANCHORED_METHODS = ['list', 'changes']

/**
 * Reserved `list` path answered with the session's workspace file and extra
 * roots instead of a directory listing (see {@link rootsListing}). The browser
 * half reads it through the existing `workspaceFiles` Remote, whose session
 * lookup only reads the session header, so it never loads a session.
 */
export const ROOTS_LISTING = '/.dsh-lh-workspace-roots'

/**
 * The reserved listing: one `file` entry naming the session's workspace file
 * (absent for the union of the scope's files), then one `directory` entry per
 * extra root; entry names are absolute paths.
 * @param {string | null} file - the session's workspace file.
 * @param {string[]} roots - the session's extra roots.
 * @returns {{ path: string, entries: { name: string, type: 'file' | 'directory' }[], truncated: false }} a `WorkspaceDirectoryListing`.
 */
export function rootsListing(file, roots) {
  return {
    path: ROOTS_LISTING,
    entries: [
      ...file === null ? [] : [{ name: file, type: 'file' }],
      ...roots.map((root) => ({ name: root, type: 'directory' })),
    ],
    truncated: false,
  }
}

/**
 * The scope upstream should confine `path` to: the session cwd, or the
 * innermost extra root containing an absolute `path` outside it.
 * @param {{ sessionId: string, workspaceRoot: string }} scope - header-derived Remote scope.
 * @param {string} path - requested path, absolute or cwd-relative.
 * @param {() => string[]} extraRoots - the session's canonical extra roots, read only when needed.
 * @returns {{ sessionId: string, workspaceRoot: string }} the scope to pass upstream.
 */
export function anchorScope(scope, path, extraRoots) {
  if (!isAbsolute(path)) return scope
  const target = canonical(path)
  if (isWithin(target, canonical(scope.workspaceRoot))) return scope
  const owner = extraRoots()
    .filter((root) => isWithin(target, root))
    .sort((a, b) => b.length - a.length)[0]
  return owner === undefined ? scope : { ...scope, workspaceRoot: owner }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const service = ctx.workspaceFiles
  const target = service[symbols.original] ?? service
  const taken = ANCHORED_METHODS.filter((method) => Object.hasOwn(target, method))
  if (taken.length > 0) {
    throw new Error(`dsh-lh-workspace-roots: workspaceFiles already has own ${taken.join(', ')}; refusing to override twice`)
  }
  const extraRoots = (scope) => {
    const session = ctx.sessions.get(scope.sessionId)
    if (session !== undefined) return ctx.sandboxPolicy.resolve({ session, mode: 'read-only' }).workspaceRoots ?? []
    return ctx.sandboxPolicy.storedSessionRoots(scope.sessionId, scope.workspaceRoot)
  }
  const workspaceFile = (scope) => {
    const session = ctx.sessions.get(scope.sessionId)
    if (session !== undefined) return ctx.sandboxPolicy.sessionFile(session.header, scope.workspaceRoot)
    return ctx.sandboxPolicy.storedSessionFile(scope.sessionId, scope.workspaceRoot)
  }
  ctx.effect(() => {
    for (const method of ANCHORED_METHODS) {
      const upstream = target[method]
      Object.defineProperty(target, method, {
        configurable: true,
        writable: true,
        value(scope, path, signal) {
          if (method === 'list' && path === ROOTS_LISTING) {
            return Promise.resolve(rootsListing(workspaceFile(scope), extraRoots(scope)))
          }
          return upstream.call(this, anchorScope(scope, path, () => extraRoots(scope)), path, signal)
        },
      })
    }
    return () => {
      for (const method of ANCHORED_METHODS) delete target[method]
    }
  }, 'dsh-lh-workspace-roots: workspaceFiles extra-root anchoring')
}
