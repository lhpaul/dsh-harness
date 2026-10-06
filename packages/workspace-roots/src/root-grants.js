/**
 * Session-granted writable roots: the `add_workspace_root` tool and the
 * `workspaceRootGrants` session projection.
 *
 * A grant is recorded only in event types every DSH build knows, so a session
 * stays loadable with or without this plugin: the tool's own `tool/call`
 * (name + arguments) and its appended `tool/result`, whose tool-owned `meta`
 * carries `{ grantedRoot }` exactly when the user approved. The approval
 * itself is audited by `dsh-user-approval` (`approval/asked` /
 * `approval/decided`). A custom event type is not used: `Session.append()`
 * cannot mark it `ignorable`, and persistence refuses to reload a log with an
 * unknown non-ignorable type.
 *
 * The projection pairs each `add_workspace_root` call with its result, so a
 * `meta.grantedRoot` on another tool's result is never read as a grant.
 * Grants last for the session (replayed on restart, inherited by forks that
 * seed the parent log); there is no revocation.
 */

import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const ADD_ROOT_TOOL = 'add_workspace_root'
export const GRANTS_PROJECTION = 'workspaceRootGrants'

/** @typedef {{ pending: string[], roots: string[] }} GrantsState */

export const grantsStateSchema = zod.object({
  pending: zod.array(zod.string()),
  roots: zod.array(zod.string()),
})

/** @returns {GrantsState} */
export function initGrants() {
  return { pending: [], roots: [] }
}

/** The granted root a result's `meta` carries, or undefined. */
export function grantedRootOf(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const root = meta.grantedRoot
  return typeof root === 'string' && root.startsWith('/') ? root : undefined
}

/**
 * Fold one session event into the grants state.
 * @param {GrantsState} state
 * @param {import('@deepseek-ai/dsh-session').SessionEvent} event
 * @returns {GrantsState}
 */
export function applyGrant(state, event) {
  switch (event.type) {
    case 'tool/call':
      return event.data.name === ADD_ROOT_TOOL
        ? { ...state, pending: [...state.pending, event.data.callId] }
        : state
    case 'tool/result': {
      if (event.surfaceOp !== 'append') return state
      const callId = event.data.message.source?.callId ?? event.data.message.toolCallId
      if (!state.pending.includes(callId)) return state
      const pending = state.pending.filter((id) => id !== callId)
      const root = event.data.message.isError === true ? undefined : grantedRootOf(event.data.meta)
      const roots = root === undefined || state.roots.includes(root) ? state.roots : [...state.roots, root]
      return { pending, roots }
    }
    case 'turn/end':
      // Results land within their turn; a call left pending belongs to a cancelled turn.
      return state.pending.length === 0 ? state : { ...state, pending: [] }
    default:
      return state
  }
}

const STATUSES = ['granted', 'already-writable', 'rejected', 'cancelled', 'unavailable']

const RESULT_TEXT = {
  'granted': (path) => `Granted: ${JSON.stringify(path)} is a writable workspace root for the rest of this session.`,
  'already-writable': (path) => `${JSON.stringify(path)} is already inside a writable workspace root; nothing was requested.`,
  'rejected': (path) => `The user rejected making ${JSON.stringify(path)} writable. Do not write there; ask the user how to proceed.`,
  'cancelled': (path) => `The request to make ${JSON.stringify(path)} writable was cancelled.`,
  'unavailable': (path) => `No approval channel is available, so ${JSON.stringify(path)} was not made writable.`,
}

const DESCRIPTION = 'Ask the user to make one more directory writable for the rest of this session, in addition to the '
  + 'workspace roots listed in the file policy. Use it only when the task requires creating or modifying files outside '
  + 'those roots; reading never needs it. The user approves or rejects each request. Pass the narrowest directory that '
  + 'covers the work.'

/**
 * Build the `add_workspace_root` tool.
 * @param {{ checkGrantPath(path: string, session: object): { path: string, alreadyWritable: boolean } }} policy
 *   validates the requested directory against the session's current roots (throws on an invalid path).
 * @param {() => ({ request(req: object): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> }) | undefined} getApproval
 *   the composed `ctx.approval`, or undefined when none is mounted.
 */
export function addWorkspaceRootTool(policy, getApproval) {
  return defineTool({
    name: ADD_ROOT_TOOL,
    description: DESCRIPTION,
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path (or ~/...) of an existing directory to make writable.' },
      reason: { type: 'string', required: true, description: 'One sentence the user sees: why the task needs to write there.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: STATUSES },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: RESULT_TEXT[value.status](value.path) }],
      presentationMeta: (_args, value) => (value.status === 'granted' ? { grantedRoot: value.path } : null),
    },
    async execute(args, exec) {
      if (exec.parent !== undefined) {
        throw new Error(`${ADD_ROOT_TOOL} must be called directly, not from inside code: the grant is recorded on its own tool result`)
      }
      const session = exec.agent?.session
      if (session === undefined) throw new Error(`${ADD_ROOT_TOOL} requires an agent session`)
      const reason = args.reason.trim()
      if (reason.length === 0) throw new Error('reason must be a non-empty sentence')
      const { path, alreadyWritable } = policy.checkGrantPath(args.path, session)
      if (alreadyWritable) return { status: 'already-writable', path }
      const approval = getApproval()
      if (approval === undefined) return { status: 'unavailable', path }
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: `Make ${path} writable for the rest of this session. Reason: ${reason}`,
        signal: exec.signal,
      })
      return { status: outcome === 'allowed-once' ? 'granted' : outcome, path }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Add writable root ${args.path}`,
      kind: 'other',
      locations: [{ path: args.path }],
    }),
  })
}
