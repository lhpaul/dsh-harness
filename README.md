# dsh-harness

LH's adaptation of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to the `~/Git/<scope>/*.code-workspace` model, without forking it. Phase 1 gives each DSH session extra writable roots: the folders its scope's workspace files list outside `~/Git/<scope>/`.

Strategy, decisions and verified traps live in the vault note `~/Git/Cerebro/LH/20 - Proyectos/Infra-Harness-DSH.md`. The upstream reference clone `~/Git/DevStack/deepseek-harness` is read-only.

## How it works

| Piece | Path | Role |
|---|---|---|
| Runtime pin | `package.json` | `@deepseek-ai/dsh` pinned exactly; installed into this repo's `node_modules` (not the npx cache). |
| Multi-root patch | `patch/dsh-multi-root.mjs` | Three exact-anchor hunks on the installed runtime (below). All-or-nothing, idempotent, `--check` / `--revert`. |
| Patch verify | `patch/dsh-multi-root-verify.mjs` | Loads the real installed modules and checks bash (Seatbelt) and fs writes against a temp policy. |
| Policy plugin | `packages/workspace-roots/` (`dsh-lh-workspace-roots`) | Cordis plugin that provides `ctx.sandboxPolicy` in place of `@deepseek-ai/dsh-sandbox-policy`. |
| Launcher | `bin/dsh`, `bin/dsh-node` | Runs the pinned runtime under a Node that satisfies `^22.19 \|\| >=24`. `~/.local/bin/dsh` symlinks here. |
| Bootstrap | `bootstrap.sh` | install → patch → wire profile → launcher → verify. Idempotent; `--revert` undoes it. |

### Per-session roots

`resolve({ session, mode })` takes the session's `cwd`, walks up to `~/Git/<scope>/`, reads every `*.code-workspace` directly in that folder (JSONC; `path` entries relative to the file with `~` expansion, or `file://` `uri` entries), and returns the union of folders that resolve outside the scope folder as `policy.workspaceRoots`. Sessions outside `~/Git` (or at `~/Git` itself) get none.

- Resolution runs on every call. A per-scope cache is keyed on each workspace file's inode, mtime and size, so adding, editing or deleting a file takes effect on the next tool call; folder existence is re-checked every call.
- A malformed file, or one without a `folders` array, logs a warning and contributes nothing; the session keeps running.
- Roots that are `/`, `$HOME` or an ancestor of it, or that contain `~/Git`, are refused with a warning.
- The policy context in the system prompt names the extra roots and the denied paths; without extra roots it is identical to upstream's text.

### The runtime patch

Upstream `writableRoots(policy)` only returns `workspaceRoot` plus temp dirs, and no plugin seam can widen it. The patch makes three hunks, each tagged `/* dsh-harness:multi-root */`:

1. `dsh-sandbox` — `writableRoots()` also returns `policy.workspaceRoots`. The Seatbelt profile and the fs fence both read this list.
2. `dsh-sandbox-local` — the Seatbelt profile ends with `(deny file-write* (subpath D) (literal <each ancestor of D>))` for each `policy.deniedWritePaths` entry. The ancestor literals block renaming or deleting a parent to move `D` away.
3. `dsh-fs-sandbox` — the write/edit fence rejects targets under `policy.deniedWritePaths` with `FS_SANDBOX_DENIED`.

If any anchor is missing or ambiguous, the patcher writes nothing, prints which hunk failed, and exits 1. Exit codes: `0` ok, `1` broken, `2` usage, `3` not applied (`--check`).

The plugin refuses to start on an unpatched runtime with "the DSH runtime is not patched for multi-root … Run bootstrap.sh". It cannot silently fall back to a single root.

### Profile wiring

`dsh plugin --profile web add packages/workspace-roots` links the package into `~/.dsh/profiles/web` and adds it to `dsh.profile.bundles`. Its `cordis.patch.yml` disables the dsh-base `sandbox-policy` row and inserts its own row. A patch cannot rename a row: the Loader logs `name mismatch … skipping`.

The home layer `~/.dsh/cordis.patch.yml` must not contain a `sandbox-policy` row: it would re-enable or replace the upstream service after the bundle layer. Bootstrap refuses to run if it finds one.

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
3. Bump the `0.2.0-rc.2` peer pins in `packages/workspace-roots/package.json`.
4. Run `./bootstrap.sh`. It runs `npm ci` and applies the patch. If an anchor moved, the patch fails loudly and changes nothing.
5. If the patch fails, read the new `writableRoots`, `seatbeltProfileArgs` and `checkedTarget` in the reference clone, update `HUNKS` in `patch/dsh-multi-root.mjs`, and re-run. Also diff upstream `dsh-sandbox-policy` (config, `sandboxMode` projection, policy context text) against `packages/workspace-roots/src/index.js`.
6. Bootstrap's verify step must pass: composed config, patch verify, boot smoke, tests. If it does not, revert the pin and run `npm ci && ./bootstrap.sh`.
7. Restart `dsh web`.

## Next phases

- **Phase 2:** `@` file references and search across all roots.
- **Phase 3:** a tool to add a root at runtime with user approval, recorded as a `sandbox/roots` session event (model-visible ⟺ logged).
- **Phase 4:** optional multi-root file tree in the Web UI; publish the plugin under the `dsh-plugin` topic and follow upstream #5505.
