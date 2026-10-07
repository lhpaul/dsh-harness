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
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import { boundedInsert, fullyQualified } from '@deepseek-ai/dsh-host-directory-picker-browse'
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
 * @param {typeof stat} [probe] - filesystem type probe (injectable for cancellation tests).
 * @returns {(signal: AbortSignal) => Promise<string | null>} a native-capability `pick`.
 */
export function workspacePick(choose, policy, onWorkspaceFile = async () => {}, onError = () => {}, probe = stat) {
  return async (signal) => {
    const picked = await choose(signal)
    if (picked === null) return null
    const directory = await policy.openPicked(picked)
    if (picked.endsWith(WORKSPACE_SUFFIX)) {
      try {
        if ((await raceAbort(probe(picked), signal)).isFile()) await onWorkspaceFile(directory, picked)
      } catch (error) {
        signal?.throwIfAborted()
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

/** Breadcrumbs match the upstream root-to-target ancestry, including leaves. */
function ancestryCrumbs(target) {
  const crumbs = []
  for (let current = target;; current = dirname(current)) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
  }
}

/** One scan shares a name-sorted result window between folders and workspace
 * files. At most 10 * maxEntries dirents are read, including ignored files.
 * Reaching that read cap conservatively marks the level truncated; sorting is
 * over the inspected prefix, since unseen names cannot be ordered without I/O.
 * The upstream capability's createDirectory and lifecycle remain unchanged.
 */
export function workspaceBrowseList(maxEntries = 1000, openDirectory = opendir, probe = stat) {
  const readCap = 10 * maxEntries
  return async (path, signal) => {
    signal?.throwIfAborted()
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const home = homedir()
    const target = resolve(path ?? home)
    const entries = []
    let truncated = false
    try {
      if (target.endsWith(WORKSPACE_SUFFIX) && (await raceAbort(probe(target), signal)).isFile()) {
        return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
      }
      const opening = openDirectory(target)
      const level = await raceAbort(opening, signal).catch((error) => {
        // A cancelled open may still return a handle; close it when it arrives.
        opening.then((dir) => dir.close().catch(() => {}), () => {})
        throw error
      })
      try {
        let reads = 0
        for (; reads < readCap; reads++) {
          const entry = await raceAbort(level.read(), signal)
          if (entry === null) break
          const file = join(target, entry.name)
          let eligible = entry.isDirectory() || (entry.isFile() && entry.name.endsWith(WORKSPACE_SUFFIX))
          if (!eligible && entry.isSymbolicLink()) {
            try {
              const info = await raceAbort(probe(file), signal)
              eligible = info.isDirectory() || (info.isFile() && entry.name.endsWith(WORKSPACE_SUFFIX))
            } catch {
              signal?.throwIfAborted()
              continue // Broken/cyclic links are skipped, as upstream does.
            }
          }
          if (!eligible) continue
          if (boundedInsert(entries, { name: entry.name, path: file, hidden: entry.name.startsWith('.') }, maxEntries)) {
            truncated = true
          }
        }
        if (reads === readCap) truncated = true
      } finally {
        // Node queues close behind reads; all three operations race cancellation.
        await raceAbort(level.close(), signal)
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
    signal?.throwIfAborted()
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
  }
}

/** Install browse seams on live objects; disposal restores their descriptors. */
export function installWorkspaceBrowse(capability, controller, policy, registry, onError, maxEntries) {
  const list = capability.list
  const target = controller[symbols.original] ?? controller
  const descriptor = Object.getOwnPropertyDescriptor(target, 'create')
  const create = target.create
  capability.list = workspaceBrowseList(maxEntries)
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
