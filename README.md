# dsh-harness

LH's adaptation of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to the `~/Git/<scope>/*.code-workspace` model, without forking it. Each DSH session gets extra writable roots: the folders its scope's workspace files list outside `~/Git/<scope>/` (phase 1). It gets `@` file completion across all of them (phase 2). The agent can also ask the user to approve one more writable directory for the rest of the session (phase 3). The Web UI gets a Roots tab that browses every root (phase 4).

Strategy, decisions and verified traps live in the vault note `~/Git/Cerebro/LH/20 - Proyectos/Infra-Harness-DSH.md`. The upstream reference clone `~/Git/DevStack/deepseek-harness` is read-only.

## How it works

| Piece | Path | Role |
|---|---|---|
| Runtime pin | `package.json` | `@deepseek-ai/dsh` pinned exactly; installed into this repo's `node_modules` (not the npx cache). |
| Multi-root patch | `patch/dsh-multi-root.mjs` | Three exact-anchor hunks on the installed runtime (below). All-or-nothing, idempotent, `--check` / `--revert`. |
| Patch verify | `patch/dsh-multi-root-verify.mjs` | Loads the real installed modules and checks bash (Seatbelt) and fs writes against a temp policy. |
| Policy plugin | `packages/workspace-roots/` (`dsh-lh-workspace-roots`) | Cordis plugin that provides `ctx.sandboxPolicy` in place of `@deepseek-ai/dsh-sandbox-policy`. |
| `@` completion plugin | `dsh-lh-workspace-roots/file-references` (same package) | Provides `ctx.fileReferences` in place of `@deepseek-ai/dsh-file-reference-local`, across all roots. |
| Root grants | `src/root-grants.js` (registered by the policy plugin) | The `add_workspace_root` tool and the `workspaceRootGrants` session projection. |
| Directory listings | `dsh-lh-workspace-roots/workspace-files` (same package) | Lets upstream `ctx.workspaceFiles` list and watch directories inside the extra roots. |
| Web Roots tab | `src/client.js` (the package's `./client` bundle) | Right-sidebar tab with one file tree per root. |
| Workspace files | `dsh-lh-workspace-roots/directory-picker`, `src/workspace-selection.js` | Add workspace also opens a `*.code-workspace` file; each session keeps the file that was active when it started. |
| Repo skills | `dsh-lh-workspace-roots/repo-skills` (same package) | Sessions in a scope folder also get the `/` skills of the repos its workspace file lists. |
| Launcher | `bin/dsh`, `bin/dsh-node` | Runs the pinned runtime under a Node that satisfies `^22.19 \|\| >=24`. `~/.local/bin/dsh` symlinks here. |
| Bootstrap | `bootstrap.sh` | install → patch → wire profile → launcher → verify. Idempotent; `--revert` undoes it. |

### Per-session roots

`resolve({ session, mode })` takes the session's `cwd`, walks up to `~/Git/<scope>/`, reads every `*.code-workspace` directly in that folder (JSONC; `path` entries relative to the file with `~` expansion, or `file://` `uri` entries), and returns the union of folders that resolve outside the scope folder as `policy.workspaceRoots`. Sessions outside `~/Git` (or at `~/Git` itself) get none.

- Resolution runs on every call. A per-scope cache is keyed on each workspace file's inode, mtime and size, so adding, editing or deleting a file takes effect on the next tool call; folder existence is re-checked every call.
- A malformed file, or one without a `folders` array, logs a warning and contributes nothing; the session keeps running.
- Roots that are `/`, `$HOME` or an ancestor of it, or that contain `~/Git`, are refused with a warning.
- The policy context in the system prompt names the extra roots and the denied paths; without extra roots it is identical to upstream's text.

### Opening a workspace file

A scope often has several workspace files (`DevStack - DSH`, `DevStack - Helm`, …), and the union of all of them is broader than any one task. On macOS, the Web **Add workspace** button opens one panel that accepts a folder or a `*.code-workspace` file:

- **A workspace file directly in a scope folder** becomes that scope's *active file*, and the scope folder is registered as the DSH workspace (DSH workspaces are directories, one per path).
- **The scope folder itself** clears the active file: back to the union.
- **Any other folder** is registered unchanged. A workspace file anywhere else is refused with an error.

Each session pins its scope's active file (or the union) the first time its roots are resolved, and keeps it: switching the active file later affects only new sessions, so a running session never gains roots silently. Forks inherit the parent's pin; sessions that existed before this feature pin whatever is active the first time they are resolved after it. A pinned file is re-read on every call; if it is deleted, the session gets no workspace-file roots and a warning is logged.

Active files and pins live in the `dsh_lh_workspace_roots` storage domain (`ctx.storageDomain`), not in the session log; the resulting roots reach the model through the `sandbox:policy` context. The panel replaces `pick` on the live native capability of upstream `ctx.directoryPicker` (directory-picker-auto stays), and disposal restores it. The browse interaction (remote or SSH launches) and other platforms keep the upstream folder chooser.

### Repo skills in workspace-file sessions

Upstream finds project skills (`/` commands) only in `.dsh/skills` and `.agents/skills` at the project root of the session cwd. A session opened from a workspace file runs in the scope folder, so skills defined in its repos (`~/Git/Radar Insights/seia/.agents/skills/run-work`) would be missing. `dsh-lh-workspace-roots/repo-skills` registers one more `ctx.skills` provider, `lh-workspace-repos`: when the lookup cwd is a scope folder itself, it scans those two directories in every folder inside the scope that the scope's active workspace file lists (all of its workspace files when none is active). Skill lookups carry only the cwd, so this follows the active file, not the session's pin. Lookups from any other cwd, including one inside a repo, get nothing from it.

Each repo is served by an upstream `FileSystemSkillProvider` limited to its two directories, so parsing and watching are upstream's. The provider registers in the registry's global layer, which every agent's catalog merges; a skill of the same name in the agent's preset layer (the cwd's project skills, `~/.dsh/skills`, `~/.agents/skills`) wins over a repo skill. Repo `AGENTS.md` files are still not loaded; open the repo folder itself when you need them.

### Session grants (`add_workspace_root`)

The model calls `add_workspace_root({ path, reason })` when a task must write outside the current roots:

1. The tool expands `~/` and canonicalizes the path. It refuses a relative or missing path, a non-directory, `/`, `$HOME` or its ancestors, anything containing `~/Git`, and anything under `deniedWritePaths`.
2. A path already inside a writable root returns `already-writable` without asking.
3. Otherwise it calls `ctx.approval.request()`. The approval request carries no tool arguments, so the audited reason names the path: `Make <path> writable for the rest of this session. Reason: <reason>`.
4. The answer maps to `granted`, `rejected`, `cancelled` or `unavailable` (no approval service mounted, or no answerer). Under the `never` approval policy (the Full access preset), every request is rejected.

A grant is recorded only in event types every DSH build knows, so the session stays loadable with or without this plugin:

- The tool's own `tool/call` carries its name and arguments.
- Its appended `tool/result` carries `meta: { grantedRoot }`, written by `output.presentationMeta` only when the status is `granted`.
- `approval/asked` and `approval/decided` record the audit.

The `workspaceRootGrants` projection pairs each `add_workspace_root` call with its result. `resolve()` adds the grants to the workspace-file roots and re-checks them on every call: a granted directory that disappears or fails the root guard is skipped. The Seatbelt profile, the fs fence, `@` completion and the policy context all see a grant on the next call.

A custom `sandbox/roots` event type was rejected. `Session.append()` cannot mark an event `ignorable`, and persistence refuses to reload a log that contains an unknown non-ignorable type, even when this plugin is loaded, because the known-type list is fixed at build time. One grant would make the session unloadable after a restart.

Limits:

- **Scope and revocation:** grants last for the session; there is no revocation. Forks that seed the parent log inherit them; fresh subagents do not.
- **Code mode:** calls from inside `run_code` are refused, because nested dispatches do not persist `meta`.
- **Web UI:** the Web UI shows the generic tool card.

### `@` completion across roots

`MultiRootFileReferenceService` subclasses upstream `LocalFileReferenceService`, so the config schema (`maxResults`, `maxEntries`, `excludedDirectories`), the `context:file-reference` system-prompt section and the lifecycle stay upstream's. Only `list()` changes; it takes the roots from `ctx.sandboxPolicy.resolve()` on every query, so it follows workspace edits like the sandbox does.

| Query | Result |
|---|---|
| empty (`@`) | The extra roots as absolute directories, then the cwd listing (relative, as upstream). |
| relative path (`@src/`, `@src/ma`) | The cwd only, exactly as upstream. |
| absolute or `~/` (`@~/Documents/LH/Neg`) | Descends into the root that contains it, or offers the roots whose path starts with it. |
| bare fuzzy (`@contrato`) | Every root's index ranked together with upstream's scoring; extra roots also match by basename. |

Extra-root candidates are absolute paths, because the fs tools resolve relative paths from the cwd and do not expand `~`. Reads are not fenced, so the model can `read` them. Candidates at or under `deniedWritePaths` are never returned, including when the vault is the session cwd. The per-root index still walks the directory names in those paths, in memory only.

After drilling into an absolute directory, the Web composer's breadcrumb header sends the path without its leading slash (`Users/…/`). `list()` reads such a query as absolute when its first segment is not a cwd entry and the absolute path lies inside, or leads to, an extra root; otherwise it stays relative.

### Web Roots tab

The package ships a browser bundle (`./client`, `dsh.client.platform: web`), which DSH serves because the package's own row is active. It registers a right-sidebar tab type, "Workspace roots", in the new-tab guide. The tab shows the session folder first, then every extra root (workspace-file roots and grants) as a lazily expanded tree, and names the session's workspace file in its header ("All workspace files of the folder" for the union). Clicking a file opens upstream's file preview tab.

The same bundle adds the workspace file and the extra roots (home shown as `~`) to the Sidebar session-row hover card, through the `sidebar.session.row.hover` slot. Sessions without extra roots show nothing there. Both read `workspaceFiles.list(sessionId, '/.dsh-lh-workspace-roots')`, a reserved path the `/workspace-files` plugin answers itself: its scope lookup reads only the session header, so hovering a row never loads a session. For a session that is not loaded, the answer is its pin, or else the scope's active file, without pinning; grants appear only once the session is loaded.

Listings go through upstream `ctx.workspaceFiles`, which only lists inside the session cwd. The `/workspace-files` plugin installs `list` and `changes` as own properties of the live upstream instance; for an absolute path inside an extra root they pass that root as the confinement root, then call upstream's methods. The API Gateway calls Remote methods by name on the instance, so its strict typert descriptors stay upstream's. Do not disable the upstream `workspace-files` row instead: the same package carries the browser `file` resource provider, and every file preview would show "The file resource service is unavailable".

Denied write paths (Diarios) are listed like any other directory. The trees are the user's own view and never reach a model; read privacy still rests on the vault rules.

Limits: the tab does not watch directories (use its reload button), and it collapses again when the sidebar remounts it.

### The runtime patch

Upstream `writableRoots(policy)` only returns `workspaceRoot` plus temp dirs, and no plugin seam can widen it. The patch makes three hunks, each tagged `/* dsh-harness:multi-root */`:

1. `dsh-sandbox` — `writableRoots()` also returns `policy.workspaceRoots`. The Seatbelt profile and the fs fence both read this list.
2. `dsh-sandbox-local` — the Seatbelt profile ends with `(deny file-write* (subpath D) (literal <each ancestor of D>))` for each `policy.deniedWritePaths` entry. The ancestor literals block renaming or deleting a parent to move `D` away.
3. `dsh-fs-sandbox` — the write/edit fence rejects targets under `policy.deniedWritePaths` with `FS_SANDBOX_DENIED`.

If any anchor is missing or ambiguous, the patcher writes nothing, prints which hunk failed, and exits 1. Exit codes: `0` ok, `1` broken, `2` usage, `3` not applied (`--check`).

The plugin refuses to start on an unpatched runtime with "the DSH runtime is not patched for multi-root … Run bootstrap.sh". It cannot silently fall back to a single root.

### Profile wiring

`dsh plugin --profile web add packages/workspace-roots` links the package into `~/.dsh/profiles/web` and adds it to `dsh.profile.bundles`. Its `cordis.patch.yml` disables the dsh-base `sandbox-policy` row and the dsh-web-app `file-reference-local` row, and inserts its own rows: the two replacements, `dsh-lh-workspace-roots/workspace-files`, `dsh-lh-workspace-roots/directory-picker` and `dsh-lh-workspace-roots/repo-skills`. A patch cannot rename a row: the Loader logs `name mismatch … skipping`.

The home layer `~/.dsh/cordis.patch.yml` must not contain a `sandbox-policy` or `file-reference-local` row: it would re-enable or replace the upstream service after the bundle layer. Bootstrap refuses to run if it finds one, and its verify step fails on any `patch:` warning in the composed config.

## Privacy: Diarios

The vault (`~/Git/Cerebro/LH`) becomes a writable root for every scope whose workspace lists it. The bundle config sets `deniedWritePaths: [~/Git/Cerebro/LH/45 - Autoconocimiento/Diarios]`. Inside any root, writes to that subtree are denied by Seatbelt and by the fs fence. This includes create, append, delete, rename, hard links, symlinks, case-variant paths, and renaming the folder or its parents.

Known gaps:

- **Reads are not confined.** DSH's Seatbelt profile allows reads by default. Read privacy still depends on the vault rules in `AGENTS.md`.
- **Escalation bypasses the deny.** A command the user approves to run unsandboxed (`danger-full-access`) is not confined.
- **No runtime invariant.** Upstream's `./invariant` companion for `sandbox/mode` is not re-exported by this plugin.
- **Linux is unpatched.** bwrap and Landlock (`bwrapProfileArgs`, `landlockProfileArgs` in `dsh-sandbox-local`) read only the scalar `workspaceRoot`. Supporting Linux needs a `--bind` per root, `readWrite.push(...roots)`, and an equivalent deny. macOS is the target.

## Usage

```sh
./bootstrap.sh            # stop `dsh web` first; restart it afterwards with `dsh web`
./bootstrap.sh --revert   # unwire profile, restore pristine runtime files, remove launcher
npm test                  # unit + composition tests (fixtures under a temp dir in $HOME)
npm run smoke             # boots the real `dsh web` in an isolated DSH_HOME/HOME with a probe plugin
npm run patch:check       # 0 applied, 3 not applied, 1 broken
```

Bootstrap never touches `~/.dsh/sessions`, `~/.dsh/storages` or credentials. Tests and smoke use temp fixtures, never the real `~/Git`.

## Upgrading DSH

1. Stop `dsh web`.
2. Bump `@deepseek-ai/dsh` in `package.json` to the exact new version and check out the matching tag in `~/Git/DevStack/deepseek-harness`.
3. Bump the `0.2.0-rc.2` peer pins in `packages/workspace-roots/package.json`, then diff upstream `dsh-file-reference-local` against `src/file-references.js`: the `LocalFileReferenceService` constructor and `list()` signature, the `WorkspaceFileSearch` exports, and `scoreCandidate` in `search.ts`, which `file-references.js` mirrors. For root grants, re-check the `tool/call` and `tool/result` data fields (`name`, `callId`, `message.source.callId`, `meta`, `surfaceOp`), the approval outcome vocabulary, and the `ToolExecution.parent` semantics that `root-grants.js` relies on. For workspace files, re-check the `DirectoryPickerNativeCapability` (`pick`, stable capability object), directory-picker-auto's choice, and the `ctx.storageDomain` API. For repo skills, re-check the `FileSystemSkillProvider` constructor and `Config` (`providerName`, `includeDefaultRoots`, `customSkillDirs`), `SkillLookupOptions` (still only `cwd`), and that dsh-web-app keeps registering skill providers per preset with a merged global layer. For the Roots tab, re-check the `WorkspaceFiles` `list`/`changes` signatures and scope fields, the gateway's by-name method dispatch, the `sidebarRightTabs`, `sidebar.right.pane.tab` and `sidebar.session.row.hover` slot APIs, the `workspaceFileScope` lookup reading only the session header, and the client-ui-primitives exports `client.js` requires.
4. Run `./bootstrap.sh`. It runs `npm ci` and applies the patch. If an anchor moved, the patch fails loudly and changes nothing.
5. If the patch fails, read the new `writableRoots`, `seatbeltProfileArgs` and `checkedTarget` in the reference clone, update `HUNKS` in `patch/dsh-multi-root.mjs`, and re-run. Also diff upstream `dsh-sandbox-policy` (config, `sandboxMode` projection, policy context text) against `packages/workspace-roots/src/index.js`.
6. Bootstrap's verify step must pass: composed config, patch verify, boot smoke, tests. If it does not, revert the pin and run `npm ci && ./bootstrap.sh`.
7. Restart `dsh web`.

## Next phases

- **Phase 2 (done):** `@` file completion across all roots.
- **Phase 3 (done):** `add_workspace_root`, user-approved session grants recorded in known event types (see "Session grants").
- **Phase 4 (done):** the Web Roots tab and the composer breadcrumb fix. Pending: publish the plugin under the `dsh-plugin` topic and follow upstream #5505.
