/**
 * Multi-root `ctx.fileReferences` provider (`@` completion).
 *
 * Subclasses upstream `LocalFileReferenceService` so its config schema, the
 * `context:file-reference` system-prompt section and its lifecycle stay
 * upstream's; only `list()` changes. Roots come from `ctx.sandboxPolicy`:
 * the session cwd plus `policy.workspaceRoots` (dsh-lh-workspace-roots).
 *
 * Query routing:
 *   - relative path queries (`src/`, `src/a`) and the empty query list the
 *     session cwd exactly like upstream; the empty query also offers the
 *     extra roots as directory candidates;
 *   - absolute or `~/` queries descend into whichever root contains them, or
 *     offer the roots whose path starts with the query;
 *   - bare fuzzy queries (`foo`) rank every root's index together.
 *
 * Extra-root candidates are absolute paths: the fs tools resolve relative
 * paths from the cwd and do not expand `~`. Candidates at or under
 * `policy.deniedWritePaths` are never offered.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  LocalFileReferenceService,
  WorkspaceFileSearch,
} from '@deepseek-ai/dsh-file-reference-local'
import { canonical, isWithin } from './roots.js'

/**
 * Per-root searches return this many times `maxResults` so that filtering
 * denied paths and merging roots still leaves `maxResults` candidates.
 */
const OVERFETCH = 4

export class MultiRootFileReferenceService extends LocalFileReferenceService {
  static inject = ['agents', 'sandboxPolicy']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ maxResults?: number, maxEntries?: number, excludedDirectories?: string[] }} [config]
   */
  constructor(ctx, config = {}) {
    super(ctx, config)
    this.maxResults = config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS
    this.rootSearchConfig = {
      maxResults: this.maxResults * OVERFETCH,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }
    /** @type {Map<object, Map<string, WorkspaceFileSearch>>} agent → root → index */
    this.rootSearches = new Map()
    ctx.on('agent/disposed', ({ agent }) => { this.disposeAgent(agent) })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      const agent = ctx.agents.get(session.id)
      for (const search of this.rootSearches.get(agent)?.values() ?? []) search.invalidate()
    })
    ctx.effect(() => () => {
      for (const agent of [...this.rootSearches.keys()]) this.disposeAgent(agent)
    }, 'dsh-lh-workspace-roots: file-reference indexes')
  }

  /**
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {string} rawQuery - path text following `@` or `@"`.
   * @param {AbortSignal} signal
   * @returns {Promise<{ path: string, kind: 'file' | 'directory' }[]>}
   */
  async list(agent, rawQuery, signal) {
    signal.throwIfAborted()
    // Roots and denied paths do not depend on the mode; an explicit mode skips
    // the per-keystroke sandbox/mode projection lookup.
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session, mode: 'read-only' })
    const primary = trimSlash(canonical(agent.session.header.cwd ?? process.cwd()))
    const extras = (policy.workspaceRoots ?? []).map(trimSlash).filter((root) => root !== primary)
    const denied = policy.deniedWritePaths ?? []
    const searches = this.searchesFor(agent, [primary, ...extras])
    const allowed = (absolute) => !denied.some((path) => isWithin(absolute, path))

    let query = rawQuery.replaceAll('\\', '/')
    if (query === '~' || query.startsWith('~/')) query = homedir() + query.slice(1)

    if (query.startsWith('/')) {
      const owner = [primary, ...extras]
        .filter((root) => query.startsWith(`${root}/`))
        .sort((a, b) => b.length - a.length)[0]
      if (owner === undefined) {
        const roots = [primary, ...extras].filter((root) => root.startsWith(query) && allowed(root))
        return roots.slice(0, this.maxResults).map((path) => ({ path, kind: 'directory' }))
      }
      const found = await searches.get(owner).list(query.slice(owner.length + 1), signal)
      return found
        .map((candidate) => ({ ...candidate, path: `${owner}/${candidate.path}` }))
        .filter((candidate) => allowed(candidate.path))
        .slice(0, this.maxResults)
    }

    const visible = (candidate) => allowed(join(primary, candidate.path))
    if (query === '' || query.includes('/')) {
      const found = (await searches.get(primary).list(query, signal)).filter(visible)
      const rootDirs = query === '' ? extras.filter(allowed).map((path) => ({ path, kind: 'directory' })) : []
      return [...rootDirs, ...found].slice(0, this.maxResults)
    }

    const ranked = []
    const perRoot = await Promise.all([primary, ...extras].map((root) => searches.get(root).list(query, signal)))
    perRoot.forEach((found, index) => {
      const root = index === 0 ? primary : extras[index - 1]
      for (const candidate of found) {
        const absolute = join(root, candidate.path)
        if (!allowed(absolute)) continue
        const score = scoreCandidate(candidate, query)
        if (score === undefined) continue
        ranked.push({ candidate: index === 0 ? candidate : { ...candidate, path: absolute }, score, rank: candidate.path, index })
      }
      if (index > 0 && allowed(root)) {
        const candidate = { path: root, kind: 'directory' }
        const score = scoreCandidate({ path: root.slice(root.lastIndexOf('/') + 1), kind: 'directory' }, query)
        if (score !== undefined) ranked.push({ candidate, score, rank: '', index })
      }
    })
    ranked.sort((a, b) =>
      b.score - a.score
      || kindRank(a.candidate.kind) - kindRank(b.candidate.kind)
      || a.rank.length - b.rank.length
      || a.index - b.index
      || compareText(a.candidate.path, b.candidate.path))
    return ranked.slice(0, this.maxResults).map((entry) => entry.candidate)
  }

  /** Reuse an agent's per-root indexes; drop indexes of roots no longer present. */
  searchesFor(agent, roots) {
    let byRoot = this.rootSearches.get(agent)
    if (byRoot === undefined) {
      byRoot = new Map()
      this.rootSearches.set(agent, byRoot)
    }
    for (const [root, search] of byRoot) {
      if (!roots.includes(root)) {
        search.dispose()
        byRoot.delete(root)
      }
    }
    for (const root of roots) {
      if (!byRoot.has(root)) byRoot.set(root, new WorkspaceFileSearch(root, this.rootSearchConfig))
    }
    return byRoot
  }

  disposeAgent(agent) {
    for (const search of this.rootSearches.get(agent)?.values() ?? []) search.dispose()
    this.rootSearches.delete(agent)
  }
}

function trimSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

// Mirrors upstream `scoreCandidate` / `subsequenceScore` in
// dsh-file-reference-local/src/search.ts so merged roots rank like one index.
// Check it on every DSH upgrade.
function scoreCandidate(candidate, query) {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target, query) {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind) {
  return kind === 'directory' ? 0 : 1
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export default MultiRootFileReferenceService
