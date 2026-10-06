/**
 * Drop-in replacement for `@deepseek-ai/dsh-sandbox-policy` (`ctx.sandboxPolicy`)
 * that adds per-session extra writable roots and denied write paths.
 *
 * Keeps the upstream service contract: `resolve({ session, mode })`,
 * `defaultMode`, `workspaceRoot`, `overrideOf(session)`, the `sandboxMode`
 * session-projection unit folded from `sandbox/mode` events, and the
 * `sandbox:policy` runtime-context contribution. On top of the upstream
 * policy fields, `resolve()` adds:
 *
 *   - `workspaceRoots`: extra roots derived on every call from the
 *     `*.code-workspace` files of the session's scope (see `roots.js`), plus
 *     the roots the user granted in this session through the
 *     `add_workspace_root` tool (folded from the log; see `root-grants.js`);
 *   - `deniedWritePaths`: the configured paths, canonicalized, which the patched
 *     runtime denies even when they fall inside a writable root.
 *
 * Both fields are enforced only by a runtime patched with
 * `patch/dsh-multi-root.mjs`; the constructor refuses to load on an unpatched
 * runtime so a missing patch cannot silently drop roots or denials.
 *
 * @module dsh-lh-workspace-roots
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import { WorkspaceRootsResolver, canonical, expandHome, isWithin } from './roots.js'
import {
  GRANTS_PROJECTION,
  addWorkspaceRootTool,
  applyGrant,
  grantedRootOf,
  grantsStateSchema,
  initGrants,
} from './root-grants.js'

export { WorkspaceRootsResolver } from './roots.js'
export { ADD_ROOT_TOOL, GRANTS_PROJECTION, applyGrant } from './root-grants.js'

/** Marker the patch writes into every patched runtime file. */
export const PATCH_MARKER = '/* dsh-harness:multi-root */'

/** Runtime modules whose patched hunks enforce `deniedWritePaths`. */
const DENY_ENFORCERS = ['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-fs-sandbox']

/** Preserve execution-world spelling, as upstream does. */
function resolveWorkspaceRoot(path) {
  if (!isAbsolute(path)) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/**
 * Throw unless the running runtime carries the multi-root patch.
 * @param {(specifier: string) => string} resolveModule - maps a package name to its entry file URL.
 */
export function assertPatchedRuntime(resolveModule = (specifier) => import.meta.resolve(specifier)) {
  const probe = '/dsh-harness-probe-root'
  const missing = []
  if (!writableRoots({ mode: 'workspace-write', workspaceRoot: '/', workspaceRoots: [probe] }).includes(probe)) {
    missing.push('@deepseek-ai/dsh-sandbox (writableRoots ignores workspaceRoots)')
  }
  for (const specifier of DENY_ENFORCERS) {
    const text = readFileSync(fileURLToPath(resolveModule(specifier)), 'utf8')
    if (!text.includes(PATCH_MARKER)) missing.push(specifier)
  }
  if (missing.length > 0) {
    throw new Error(
      `dsh-lh-workspace-roots: the DSH runtime is not patched for multi-root (${missing.join('; ')}). `
      + 'Run ~/Git/DevStack/dsh-harness/bootstrap.sh and restart dsh.',
    )
  }
}

/**
 * Render the `sandbox:policy` context. Identical to upstream when the session
 * has no extra roots and no denied path falls inside a writable root.
 * @param {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy & { workspaceRoots?: string[], deniedWritePaths?: string[] }} policy
 * @returns {string} model-visible policy text.
 */
export function renderPolicyContext(policy) {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const extra = (policy.workspaceRoots ?? []).filter((root) => root !== policy.workspaceRoot)
      const roots = [policy.workspaceRoot, ...extra].map(canonical)
      const denied = (policy.deniedWritePaths ?? []).filter((path) => roots.some((root) => isWithin(path, root)))
      return 'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: '
        + JSON.stringify(policy.workspaceRoot)
        + (extra.length === 0 ? '' : `, and under these additional workspace roots: ${extra.map((root) => JSON.stringify(root)).join(', ')}`)
        + '.'
        + (denied.length === 0 ? '' : ` Writes under ${denied.map((path) => JSON.stringify(path)).join(', ')} are denied.`)
        + ' Some platform temporary areas may also be writable.'
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    default:
      throw new Error(`unreachable sandbox mode: ${String(policy.mode)}`)
  }
}

const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`) with per-session roots.
 */
export class WorkspaceRootsPolicyService extends Service {
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
    workspaceRoot: z.string(),
    scopesRoot: z.string().required(),
    deniedWritePaths: z.array(z.string()).default([]),
  })

  static inject = ['sessionProjections']

  /** Load-time runtime check; tests substitute it in a subclass. */
  static assertPatched = assertPatchedRuntime

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot?: string, scopesRoot: string, deniedWritePaths: string[] }} config
   */
  constructor(ctx, config) {
    super(ctx, 'sandboxPolicy')
    this.constructor.assertPatched()
    for (const path of config.deniedWritePaths) {
      if (!isAbsolute(path) || canonical(path) === '/') {
        throw new Error(`dsh-lh-workspace-roots: deniedWritePaths entries must be absolute non-root paths, got ${JSON.stringify(path)}`)
      }
    }
    const logger = ctx.logger('workspace-roots')
    /** The deployment default mode — the fallback beneath a session override. */
    this.defaultMode = config.mode
    /** The absolute `workspace-write` fallback root for calls without a session cwd. */
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.deniedWritePaths = config.deniedWritePaths
    this.roots = new WorkspaceRootsResolver({ scopesRoot: config.scopesRoot, onWarning: (message) => logger.warn(message) })

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.sessionProjections.register({
      key: GRANTS_PROJECTION,
      stateVersion: 1,
      stateSchema: grantsStateSchema,
      init: initGrants,
      apply: applyGrant,
    })

    ctx.inject(['tools'], (scope) => {
      scope.tools.register(addWorkspaceRootTool(this, () => ctx.get('approval')))
    })

    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined ? '' : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. Mode precedence and
   * the primary root match upstream; extra roots are re-derived from the
   * scope's workspace files on every call.
   * @param {{ session?: import('@deepseek-ai/dsh-session').Session, mode?: 'read-only' | 'workspace-write' | 'danger-full-access' }} [request]
   * @returns the per-call policy with optional `workspaceRoots` and `deniedWritePaths`.
   */
  resolve(request = {}) {
    const { session } = request
    const workspaceRoot = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
    const granted = session === undefined ? [] : this.grantedRoots(session)
    const workspaceRoots = [...new Set([...this.roots.extraRoots(workspaceRoot), ...granted])].sort()
    const deniedWritePaths = this.deniedWritePaths.map(canonical)
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot,
      ...workspaceRoots.length === 0 ? {} : { workspaceRoots },
      ...deniedWritePaths.length === 0 ? {} : { deniedWritePaths },
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session override without applying the deployment default.
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @returns {'read-only' | 'workspace-write' | 'danger-full-access' | undefined} the last logged mode.
   */
  overrideOf(session) {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }

  /**
   * Roots the user granted through `add_workspace_root`, folded from the
   * session log. Re-checked on read (the log is a durable-file boundary):
   * entries that no longer exist or fail the root guard are skipped.
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @returns {string[]} canonical existing directories.
   */
  grantedRoots(session) {
    const state = this.ctx.sessionProjections.stateOf(session, GRANTS_PROJECTION)
    return (state?.roots ?? [])
      .map((root) => grantedRootOf({ grantedRoot: root }))
      .filter((root) => root !== undefined && isDirectory(root) && this.roots.rejection(root) === undefined)
  }

  /**
   * Validate a directory the model asks to make writable.
   * @param {string} rawPath - absolute or `~/` path from the tool arguments.
   * @param {import('@deepseek-ai/dsh-session').Session} session - the requesting session.
   * @returns {{ path: string, alreadyWritable: boolean }} the canonical path and whether a current root covers it.
   * @throws when the path is relative, missing, not a directory, refused by the root guard, or under a denied path.
   */
  checkGrantPath(rawPath, session) {
    const expanded = expandHome(rawPath.trim(), this.roots.homeDir)
    if (!isAbsolute(expanded)) throw new Error(`path must be absolute or start with ~/, got ${JSON.stringify(rawPath)}`)
    const path = canonical(expanded)
    if (!isDirectory(path)) throw new Error(`${JSON.stringify(path)} is not an existing directory`)
    const rejection = this.roots.rejection(path)
    if (rejection !== undefined) throw new Error(`${JSON.stringify(path)} cannot be a workspace root: ${rejection}`)
    if (this.deniedWritePaths.some((denied) => isWithin(path, canonical(denied)))) {
      throw new Error(`${JSON.stringify(path)} is under a path this deployment denies writes to`)
    }
    const policy = this.resolve({ session, mode: 'workspace-write' })
    const current = [canonical(policy.workspaceRoot), ...policy.workspaceRoots ?? []]
    return { path, alreadyWritable: current.some((root) => isWithin(path, root)) }
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // statSync failed: the path is missing or unreadable, so it is not a usable root.
    return false
  }
}

export default WorkspaceRootsPolicyService
