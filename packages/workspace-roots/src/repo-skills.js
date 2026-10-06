/**
 * Skills of the other repos a scope's workspace file lists.
 *
 * Upstream skill-filesystem scans `.dsh/skills` and `.agents/skills` only at
 * the project root found from the session cwd. A session opened from a
 * workspace file runs in its first repo (or in the scope folder), so the
 * skills of the file's other repos are never scanned. This plugin registers
 * one more `ctx.skills` provider that scans those two directories in every
 * folder `sandboxPolicy.scopeFolders(cwd)` returns. Each
 * folder is served by an upstream `FileSystemSkillProvider` limited to that
 * folder's two directories (`includeDefaultRoots: false`), so parsing,
 * watching and ranks stay upstream's: repo skills carry the custom-root rank,
 * below the cwd's own project skills and above user skills.
 *
 * The other repos' `AGENTS.md` files are not loaded.
 *
 * @module dsh-lh-workspace-roots/repo-skills
 */

import { join } from 'node:path'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'dsh-lh-workspace-roots/repo-skills'
export const inject = ['skills', 'sandboxPolicy']

/** Provider name of the repo skills in the `ctx.skills` registry. */
export const PROVIDER = 'lh-workspace-repos'

/** `ctx.skills` provider over the skill directories of a scope's repos. */
export class RepoSkillProvider {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context passed to the upstream providers.
   * @param {import('@deepseek-ai/dsh-skill').SkillProviderControl} control - registry control; its signal disposes every folder provider.
   * @param {(cwd: string) => string[]} foldersOf - repo folders for a lookup cwd.
   */
  constructor(ctx, control, foldersOf) {
    this.name = PROVIDER
    this.ctx = ctx
    this.control = control
    this.foldersOf = foldersOf
    /** @type {Map<string, FileSystemSkillProvider>} */
    this.byFolder = new Map()
    this.loader = this.providerOf([])
  }

  providerOf(skillDirs) {
    return new FileSystemSkillProvider(this.ctx, this.control, {
      providerName: PROVIDER,
      includeDefaultRoots: false,
      customSkillDirs: skillDirs,
    })
  }

  folderProvider(folder) {
    let provider = this.byFolder.get(folder)
    if (provider === undefined) {
      provider = this.providerOf([join(folder, '.dsh', 'skills'), join(folder, '.agents', 'skills')])
      this.byFolder.set(folder, provider)
    }
    return provider
  }

  /**
   * @param {import('@deepseek-ai/dsh-skill').SkillLookupOptions} options - lookup cwd and signal.
   * @returns {Promise<import('@deepseek-ai/dsh-skill').SkillCandidate[] | import('@deepseek-ai/dsh-skill').SkillProviderObservation>} candidates of every repo folder.
   */
  async list(options) {
    if (options.cwd === undefined) return []
    const candidates = []
    let complete = true
    for (const folder of this.foldersOf(options.cwd)) {
      const observed = await this.folderProvider(folder).list({ signal: options.signal })
      if (Array.isArray(observed)) {
        candidates.push(...observed)
      } else {
        candidates.push(...observed.candidates)
        complete &&= observed.complete
      }
    }
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Loading reads only the candidate's file locator, so any folder provider can load it.
   * @param {import('@deepseek-ai/dsh-skill').SkillCandidate} candidate - a candidate this provider listed.
   * @param {import('@deepseek-ai/dsh-skill').SkillLookupOptions} options - lookup options.
   * @returns the full skill, or `undefined` if its file disappeared.
   */
  get(candidate, options) {
    return this.loader.get(candidate, options)
  }
}

/**
 * Register the repo skill provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.skills.registerProvider((control) => new RepoSkillProvider(ctx, control, (cwd) => ctx.sandboxPolicy.scopeFolders(cwd)))
}
