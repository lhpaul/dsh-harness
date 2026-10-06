/**
 * Which workspace file a scope and a session use.
 *
 * - The **active file** of a scope is the `*.code-workspace` file the user
 *   last opened through the Add workspace dialog (`directory-picker.js`);
 *   opening the scope folder itself clears it. Without one, a scope keeps the
 *   union of all its workspace files.
 * - Each session **pins** the active file of its scope (or `null` for the
 *   union) the first time its roots are resolved, so switching the active
 *   file later changes only new sessions. A fork inherits its parent's pin.
 *
 * Both live in the `dsh_lh_workspace_roots` storage domain (host-side,
 * never in a session log). The model still sees the resulting roots through
 * the `sandbox:policy` context, which DSH records with each request.
 *
 * @module dsh-lh-workspace-roots/workspace-selection
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Storage domain of the active files (key: scope dir) and session pins (key: session id). */
export const selectionDomain = defineDomain({
  name: 'dsh_lh_workspace_roots',
  version: 1,
  tables: {
    active_files: domainTable(z.object({ file: z.string() })),
    session_files: domainTable(z.object({ file: z.string().nullable() })),
  },
})

/** Synchronous reads and pinning over an opened {@link selectionDomain}. */
export class WorkspaceSelection {
  /**
   * @param {{ table: (name: string) => { get: (key: string) => any, put: (key: string, value: any) => Promise<void>, delete: (key: string) => Promise<void> } }} domain - opened domain handle.
   * @param {(message: string) => void} [onWarning] - receives failed pin writes.
   */
  constructor(domain, onWarning = () => {}) {
    this.active = domain.table('active_files')
    this.pins = domain.table('session_files')
    this.onWarning = onWarning
    /** Pins written but not yet durable; reads must not re-pin meanwhile. */
    this.pending = new Map()
  }

  /**
   * @param {string} scope - canonical scope directory.
   * @returns {string | null} the scope's active workspace file.
   */
  activeFile(scope) {
    return this.active.get(scope)?.file ?? null
  }

  /**
   * Set or clear the active file of a scope. Running sessions keep their pins.
   * @param {string} scope - canonical scope directory.
   * @param {string | null} file - workspace file directly in `scope`, or null for the union.
   * @returns {Promise<void>} resolves once durable.
   */
  async setActiveFile(scope, file) {
    if (file === null) {
      if (this.active.get(scope) !== undefined) await this.active.delete(scope)
      return
    }
    await this.active.put(scope, { file })
  }

  /**
   * The workspace file a session uses, pinning it on first use.
   * @param {{ id: string, parentSession?: string }} header - the session header.
   * @param {string} scope - canonical scope directory of the session cwd.
   * @returns {string | null} the pinned file, or null for the union.
   */
  fileFor(header, scope) {
    const pinned = this.pinOf(header.id)
    if (pinned !== undefined) return pinned
    const inherited = header.parentSession === undefined ? undefined : this.pinOf(header.parentSession)
    const file = inherited !== undefined ? inherited : this.activeFile(scope)
    this.pending.set(header.id, file)
    this.pins.put(header.id, { file }).then(
      () => this.pending.delete(header.id),
      (error) => {
        this.pending.delete(header.id)
        this.onWarning(`workspace-roots: could not pin session ${header.id} to ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
    return file
  }

  /**
   * @param {string} sessionId - session id.
   * @returns {string | null | undefined} the stored pin, or undefined when the session has none yet.
   */
  pinOf(sessionId) {
    if (this.pending.has(sessionId)) return this.pending.get(sessionId)
    const record = this.pins.get(sessionId)
    return record === undefined ? undefined : record.file
  }
}
