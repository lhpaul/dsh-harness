/**
 * Add workspace accepts a folder or a VS Code `*.code-workspace` file.
 *
 * The upstream `directory-picker` row (directory-picker-auto) mounts the
 * native or the browse interaction. Under the native interaction on macOS,
 * this plugin replaces the `pick` of the live capability object with one
 * `NSOpenPanel` that can choose either kind. The result goes through
 * `ctx.sandboxPolicy.openPicked()`: a workspace file becomes its scope's
 * active file and its first folder inside the scope (else the scope directory)
 * is returned, so DSH still registers a directory as the workspace; that
 * Workspace is titled after the workspace file (`titleWorkspace`). The browse interaction lists workspace files as empty preview leaves and
 * resolves them when the controller creates the workspace.
 *
 * The capability object is stable for the service lifetime (the seam's
 * contract), so the override lives as long as this plugin and that object;
 * Cordis restarts this plugin when `ctx.directoryPicker` is replaced, and
 * disposal restores the upstream `pick`.
 *
 * @module dsh-lh-workspace-roots/directory-picker
 */

import { execFile } from 'node:child_process'
import { basename, dirname, join, isAbsolute } from 'node:path'
import { opendir, stat } from 'node:fs/promises'
import { symbols } from '@deepseek-ai/cordis'
import { WORKSPACE_SUFFIX } from './roots.js'

export const name = 'dsh-lh-workspace-roots/directory-picker'

export const inject = ['directoryPicker', 'sandboxPolicy', 'workspaceRegistry', 'workspaceController']

/** JXA run by `osascript -l JavaScript`; prints the chosen path, or nothing on cancel. */
const OPEN_PANEL_SCRIPT = `
ObjC.import('AppKit');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
app.activateIgnoringOtherApps(true);
const panel = $.NSOpenPanel.openPanel;
panel.canChooseFiles = true;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = false;
panel.allowedFileTypes = $(['code-workspace']);
panel.message = 'Select a workspace folder or a .code-workspace file';
panel.prompt = 'Open';
panel.runModal === $.NSModalResponseOK ? panel.URLs.objectAtIndex(0).path.js : '';
`

/**
 * Open the macOS folder-or-workspace-file panel.
 * @param {AbortSignal} signal - caller lifetime; abort kills the panel.
 * @returns {Promise<string | null>} the chosen absolute path, or null on cancel.
 */
export function chooseFolderOrWorkspaceFile(signal) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', OPEN_PANEL_SCRIPT], { signal }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      const path = stdout.replace(/[\r\n]+$/, '')
      resolve(path === '' ? null : path)
    })
  })
}

/**
 * Title the Workspace registered for `directory` after the workspace file
 * `file` (its name without `.code-workspace`): an existing registration is
 * retitled, otherwise it is created with that title. The controller's create
 * route then resolves this registration instead of creating one titled after
 * the folder. Duplicate titles are allowed by the registry.
 * @param {{ resolveByPath: (path: string) => Promise<{ title: string, setTitle: (title: string) => Promise<void> } | undefined>, create: (path: string, title?: string) => Promise<unknown> }} registry - `ctx.workspaceRegistry`.
 * @param {string} directory - the directory DSH registers as the workspace.
 * @param {string} file - the picked workspace file.
 */
export async function titleWorkspace(registry, directory, file) {
  const title = basename(file, WORKSPACE_SUFFIX)
  const existing = await registry.resolveByPath(directory)
  if (existing === undefined) await registry.create(directory, title)
  else if (existing.title !== title) await existing.setTitle(title)
}

/**
 * Build the replacement `pick`.
 * @param {(signal: AbortSignal) => Promise<string | null>} choose - the chooser.
 * @param {{ openPicked: (path: string) => Promise<string> }} policy - `ctx.sandboxPolicy`.
 * @param {(directory: string, file: string) => Promise<void>} [onWorkspaceFile] - called after a workspace file opened `directory`; a failure is reported through `onError` and the pick still succeeds.
 * @param {(error: unknown) => void} [onError] - receives `onWorkspaceFile` failures.
 * @returns {(signal: AbortSignal) => Promise<string | null>} a native-capability `pick`.
 */
export function workspacePick(choose, policy, onWorkspaceFile = async () => {}, onError = () => {}) {
  return async (signal) => {
    const picked = await choose(signal)
    if (picked === null) return null
    const directory = await policy.openPicked(picked)
    if (picked.endsWith(WORKSPACE_SUFFIX)) {
      try {
        await onWorkspaceFile(directory, picked)
      } catch (error) {
        onError(error)
      }
    }
    return directory
  }
}

/** Race filesystem steps against cancellation, as in the upstream picker.
 * Attach settlement handlers even after abort so late failures are consumed.
 */
function raceAbort(operation, signal) {
  if (signal === undefined) return operation
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) {
      operation.catch(() => {})
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/** Extend the bounded upstream listing with workspace-file leaves. Listing a
 * leaf returns an empty preview so the upstream browser can select and Open it.
 * No file contents are read until Open; invalid workspace locations are refused
 * by openPicked, exactly as in the native chooser.
 */
export function workspaceBrowseList(upstream, maxEntries = 1000, openDirectory = opendir) {
  return async (path, signal) => {
    signal?.throwIfAborted()
    if (path !== undefined && isAbsolute(path) && path.endsWith(WORKSPACE_SUFFIX)
      && (await raceAbort(stat(path), signal)).isFile()) {
      const parent = await upstream(dirname(path), signal)
      return { ...parent, path, entries: [], truncated: false,
        crumbs: [...parent.crumbs, { name: basename(path), path, hidden: basename(path).startsWith('.') }] }
    }
    const listing = await upstream(path, signal)
    const entries = [...listing.entries]
    let truncated = listing.truncated
    signal?.throwIfAborted()
    const opening = openDirectory(listing.path)
    const level = await raceAbort(opening, signal).catch((error) => {
      // A cancelled open may still return a handle; close it when it arrives.
      opening.then((dir) => dir.close().catch(() => {}), () => {})
      throw error
    })
    try {
      for (;;) {
        const entry = await raceAbort(level.read(), signal)
        if (entry === null) break
        if (!entry.name.endsWith(WORKSPACE_SUFFIX)) continue
        const file = join(listing.path, entry.name)
        if (!entry.isFile()) continue
        entries.push({ name: entry.name, path: file, hidden: entry.name.startsWith('.') })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        if (entries.length > maxEntries) { entries.pop(); truncated = true }
      }
    } finally {
      const closing = level.close()
      // Node queues close behind pending reads; cancellation must not wait.
      if (signal?.aborted) closing.catch(() => {})
      else await closing
    }
    return { ...listing, entries, truncated }
  }
}

/** Install browse seams on live objects; disposal restores their descriptors. */
export function installWorkspaceBrowse(capability, controller, policy, registry, onError, maxEntries) {
  const list = capability.list
  const target = controller[symbols.original] ?? controller
  const descriptor = Object.getOwnPropertyDescriptor(target, 'create')
  const create = target.create
  capability.list = workspaceBrowseList(list, maxEntries)
  Object.defineProperty(target, 'create', {
    configurable: true, writable: true,
    async value(request) {
      const path = await workspacePick(async () => request.path, policy,
        (directory, file) => titleWorkspace(registry, directory, file), onError)()
      return create.call(this, { ...request, path })
    },
  })
  return () => {
    capability.list = list
    if (descriptor) Object.defineProperty(target, 'create', descriptor)
    else delete target.create
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger('workspace-roots')
  const capability = ctx.directoryPicker.capability()
  if (capability.kind === 'browse') {
    ctx.effect(() => installWorkspaceBrowse(capability, ctx.workspaceController, ctx.sandboxPolicy,
      ctx.workspaceRegistry, (error) => logger.warn(String(error)),
      ctx.directoryPicker.config?.maxEntries), 'dsh-lh-workspace-roots: browse workspace files')
    return
  }
  if (process.platform !== 'darwin' || capability.kind !== 'native') {
    logger.info(`Add workspace keeps the upstream ${capability.kind} chooser on ${process.platform}; workspace files open only through the macOS native chooser`)
    return
  }
  const upstream = capability.pick
  ctx.effect(() => {
    capability.pick = workspacePick(
      chooseFolderOrWorkspaceFile,
      ctx.sandboxPolicy,
      (directory, file) => titleWorkspace(ctx.workspaceRegistry, directory, file),
      (error) => { logger.warn(`could not title the workspace after its workspace file: ${error instanceof Error ? error.message : String(error)}`) },
    )
    return () => {
      capability.pick = upstream
    }
  }, 'dsh-lh-workspace-roots: folder-or-workspace-file chooser')
}
