/**
 * Derive a session's extra writable roots from the VS Code workspace files of
 * its scope.
 *
 * Rule: the scope of a cwd is the first-level directory under `scopesRoot`
 * that contains it (`<scopesRoot>/<scope>/...`). Every `*.code-workspace`
 * file directly inside that scope directory is read — or only one of them,
 * when the caller names the session's selected file — and each folder entry
 * that resolves OUTSIDE the scope directory is an extra root (union across
 * files, canonical, deduplicated, sorted). A cwd outside `scopesRoot`, or equal to
 * it, has no scope and therefore no extra roots.
 *
 * Results are cached per scope and invalidated whenever the set of workspace
 * files or any file's mtime/size/inode changes, so edits apply on the next
 * call. A malformed file is reported once per change through `onWarning` and
 * contributes nothing; it never throws.
 *
 * Rejected candidates (reported through `onWarning`): the filesystem root, the
 * home directory or any of its ancestors, and any directory containing
 * `scopesRoot` (it would grant every scope). Candidates that are not existing
 * directories are skipped silently on each call and appear once created.
 *
 * @module dsh-lh-workspace-roots/roots
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './jsonc.js'

/** File suffix of VS Code multi-root workspace files. */
export const WORKSPACE_SUFFIX = '.code-workspace'

/**
 * Canonical (symlink-free, on-disk case) spelling of `path`, or `path`
 * unchanged when it does not resolve.
 * @param {string} path - absolute path.
 * @returns {string} canonical path.
 */
export function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: path (or a prefix) does not exist; keep the spelling.
    return path
  }
}

/**
 * Whether `path` equals `dir` or lies below it (lexical, both absolute).
 * @param {string} path - candidate path.
 * @param {string} dir - containing directory.
 * @returns {boolean} true when contained.
 */
export function isWithin(path, dir) {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // statSync failed: the path is missing or unreadable, so it is not a usable root.
    return false
  }
}

/** Expand a leading `~` or `~/` against `homeDir`; other paths are returned unchanged. */
export function expandHome(path, homeDir) {
  if (path === '~') return homeDir
  if (path.startsWith('~/')) return join(homeDir, path.slice(2))
  return path
}

/** Resolves and caches per-scope extra roots. */
export class WorkspaceRootsResolver {
  /**
   * @param {object} options
   * @param {string} options.scopesRoot - absolute directory whose children are scopes (e.g. `~/Git`).
   * @param {string} [options.homeDir] - home directory used for `~` expansion and the ancestor guard.
   * @param {(message: string) => void} [options.onWarning] - receives malformed-file and rejected-root reports.
   */
  constructor({ scopesRoot, homeDir = homedir(), onWarning = () => {} }) {
    if (typeof scopesRoot !== 'string' || !isAbsolute(scopesRoot)) {
      throw new Error(`workspace-roots: scopesRoot must be an absolute path, got ${JSON.stringify(scopesRoot)}`)
    }
    this.scopesRoot = normalize(scopesRoot)
    this.homeDir = homeDir
    this.onWarning = onWarning
    /** @type {Map<string, { signature: string, candidates: string[], inside: string[] }>} */
    this.cache = new Map()
  }

  /**
   * The scope directory containing `cwd`, or undefined.
   * @param {string} cwd - absolute session working directory.
   * @returns {string | undefined} `<scopesRoot>/<scope>` in canonical spelling.
   */
  scopeOf(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
    const pairs = [[normalize(cwd), this.scopesRoot], [canonical(cwd), canonical(this.scopesRoot)]]
    for (const [path, root] of pairs) {
      if (!isWithin(path, root)) continue
      const rel = relative(root, path)
      if (rel === '') return undefined
      return canonical(join(root, rel.split(sep)[0]))
    }
    return undefined
  }

  /**
   * Extra writable roots for a session whose cwd is `cwd`.
   * @param {string} cwd - absolute session working directory.
   * @param {string | null} [file] - one workspace file of the scope to read
   *   instead of all of them; a file that is gone or lies elsewhere yields no roots.
   * @returns {string[]} canonical, sorted, existing directories outside the scope.
   */
  extraRoots(cwd, file = null) {
    return this.entryFor(cwd, file)?.candidates.filter(isDirectory) ?? []
  }

  /**
   * Folders the same workspace files list INSIDE the scope directory (its
   * repos), excluding the scope directory itself. Not writable roots: the
   * scope directory already contains them.
   * @param {string} cwd - absolute session working directory.
   * @param {string | null} [file] - as for {@link extraRoots}.
   * @returns {string[]} canonical, sorted, existing directories.
   */
  scopeFolders(cwd, file = null) {
    return this.entryFor(cwd, file)?.inside.filter(isDirectory) ?? []
  }

  entryFor(cwd, file) {
    const scope = this.scopeOf(cwd)
    if (scope === undefined) return undefined
    if (file !== null && !this.isWorkspaceFileOf(file, scope)) {
      this.warnOnce(`${scope}\0${file}`, `workspace-roots: workspace file ${JSON.stringify(file)} is not in ${scope}; no extra roots`)
      return undefined
    }
    const files = file === null ? this.workspaceFiles(scope) : [file]
    const key = `${scope}\0${file ?? ''}`
    const signature = this.signatureOf(files)
    let entry = this.cache.get(key)
    if (entry === undefined || entry.signature !== signature) {
      entry = { signature, ...this.compute(scope, files) }
      this.cache.set(key, entry)
    }
    return entry
  }

  /**
   * Whether `file` is an existing workspace file directly inside `scope`.
   * @param {string} file - absolute path.
   * @param {string} scope - canonical scope directory.
   * @returns {boolean} true for `<scope>/<name>.code-workspace` that exists.
   */
  isWorkspaceFileOf(file, scope) {
    if (!isAbsolute(file) || !file.endsWith(WORKSPACE_SUFFIX)) return false
    const real = canonical(file)
    try {
      return dirname(real) === scope && statSync(real).isFile()
    } catch {
      // statSync failed: the workspace file is gone.
      return false
    }
  }

  warnOnce(key, message) {
    this.warned ??= new Set()
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.onWarning(message)
  }

  /** Workspace files of `scope`, sorted by name. */
  workspaceFiles(scope) {
    try {
      return readdirSync(scope)
        .filter((name) => name.endsWith(WORKSPACE_SUFFIX))
        .sort()
        .map((name) => join(scope, name))
    } catch {
      // readdirSync failed: the scope directory vanished or is unreadable; it has no workspace files.
      return []
    }
  }

  signatureOf(files) {
    return files.map((file) => {
      try {
        const st = statSync(file)
        return `${file}:${st.ino}:${st.mtimeMs}:${st.size}`
      } catch {
        // statSync failed: the file was removed between readdir and stat; record its absence.
        return `${file}:gone`
      }
    }).join('\n')
  }

  compute(scope, files) {
    const found = new Set()
    const inside = new Set()
    for (const file of files) {
      for (const folder of this.foldersOf(file)) {
        const root = canonical(folder)
        if (isWithin(root, scope)) {
          if (root !== scope) inside.add(root)
          continue
        }
        const reason = this.rejection(root)
        if (reason !== undefined) {
          this.onWarning(`workspace-roots: ignoring folder ${JSON.stringify(root)} from ${file}: ${reason}`)
          continue
        }
        found.add(root)
      }
    }
    return { candidates: [...found].sort(), inside: [...inside].sort() }
  }

  rejection(root) {
    if (dirname(root) === root) return 'filesystem root'
    if (isWithin(canonical(this.homeDir), root)) return 'home directory or one of its ancestors'
    if (isWithin(canonical(this.scopesRoot), root)) return 'contains the scopes root'
    return undefined
  }

  /** Absolute folder paths declared by one workspace file; [] when malformed. */
  foldersOf(file) {
    let data
    try {
      data = parseJsonc(readFileSync(file, 'utf8'))
    } catch (error) {
      this.onWarning(`workspace-roots: skipping malformed ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const folders = data !== null && typeof data === 'object' ? data.folders : undefined
    if (!Array.isArray(folders)) {
      this.onWarning(`workspace-roots: skipping ${file}: no "folders" array`)
      return []
    }
    const base = dirname(file)
    const out = []
    for (const entry of folders) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.path === 'string' && entry.path.length > 0) {
        out.push(resolve(base, expandHome(entry.path, this.homeDir)))
      } else if (typeof entry.uri === 'string' && entry.uri.startsWith('file:')) {
        try {
          out.push(fileURLToPath(entry.uri))
        } catch {
          // fileURLToPath rejected the URI (e.g. a non-local host); the folder is not on this machine.
          this.onWarning(`workspace-roots: skipping folder uri ${JSON.stringify(entry.uri)} in ${file}`)
        }
      }
    }
    return out
  }
}
