/**
 * Derive a session's extra writable roots from the VS Code workspace files of
 * its scope.
 *
 * Rule: the scope of a cwd is the first-level directory under `scopesRoot`
 * that contains it (`<scopesRoot>/<scope>/...`). Every `*.code-workspace`
 * file directly inside that scope directory is read; each folder entry that
 * resolves OUTSIDE the scope directory is an extra root (union across files,
 * canonical, deduplicated, sorted). A cwd outside `scopesRoot`, or equal to
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

function expandHome(path, homeDir) {
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
    /** @type {Map<string, { signature: string, candidates: string[] }>} */
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
   * @returns {string[]} canonical, sorted, existing directories outside the scope.
   */
  extraRoots(cwd) {
    const scope = this.scopeOf(cwd)
    if (scope === undefined) return []
    const signature = this.signatureOf(scope)
    let entry = this.cache.get(scope)
    if (entry === undefined || entry.signature !== signature) {
      entry = { signature, candidates: this.compute(scope) }
      this.cache.set(scope, entry)
    }
    return entry.candidates.filter(isDirectory)
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

  signatureOf(scope) {
    return this.workspaceFiles(scope).map((file) => {
      try {
        const st = statSync(file)
        return `${file}:${st.ino}:${st.mtimeMs}:${st.size}`
      } catch {
        // statSync failed: the file was removed between readdir and stat; record its absence.
        return `${file}:gone`
      }
    }).join('\n')
  }

  compute(scope) {
    const found = new Set()
    for (const file of this.workspaceFiles(scope)) {
      for (const folder of this.foldersOf(file)) {
        const root = canonical(folder)
        if (isWithin(root, scope)) continue
        const reason = this.rejection(root)
        if (reason !== undefined) {
          this.onWarning(`workspace-roots: ignoring folder ${JSON.stringify(root)} from ${file}: ${reason}`)
          continue
        }
        found.add(root)
      }
    }
    return [...found].sort()
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
