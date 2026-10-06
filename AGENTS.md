# AGENTS.md — dsh-harness

LH's bundle, plugin and runtime patch for the DeepSeek Harness (DSH). Read `README.md` first; strategy lives in `~/Git/Cerebro/LH/20 - Proyectos/Infra-Harness-DSH.md` (do not re-litigate fork vs plugin).

## Hard rules

- Never modify, commit in, or push from `~/Git/DevStack/deepseek-harness` (read-only reference clone at the pinned tag). Nothing goes upstream.
- Never read, copy or sync `~/.dsh/sessions`, `~/.dsh/storages` or credentials files. Back up `~/.dsh/cordis.patch.yml` before editing it; it must not contain a `sandbox-policy` row.
- Stop `dsh web` before patching or bootstrapping; tell LH to restart it (`dsh web`) afterwards.
- Do not read `~/Git/Cerebro/LH/45 - Autoconocimiento/Diarios/`. Keep it in the plugin's `deniedWritePaths`.
- Tests and smoke use fixture scopes under a temp dir in `$HOME`, never the real `~/Git`.
- The patcher stays all-or-nothing on exact anchors and fails with a non-zero exit; never loosen anchors to fuzzy matches.

## Commands

```sh
./bootstrap.sh [--revert]   # idempotent install → patch → wire → launcher → verify
npm test                    # node --test, sequential
npm run smoke               # boot real `dsh web` isolated, probe the sandbox
npm run patch[:check|:revert]
node patch/dsh-multi-root-verify.mjs
```

DSH needs Node `^22.19 || >=24`; older Node exits 0 silently. Use `bin/dsh` (it picks a suitable Node via `bin/dsh-node`), never `npx @deepseek-ai/dsh`.

## Conventions

- ESM JavaScript, no build step. The plugin declares its DSH packages as `peerDependencies` so they resolve to the profile runtime's copies.
- A patch layer cannot rename a Loader row; replace a service by disabling the row and inserting a new one.
- When changing the patch, update `HUNKS`, the verify script, `tests/patch.test.mjs`, and the README patch section together.
- `src/file-references.js` subclasses upstream `LocalFileReferenceService` and mirrors its `scoreCandidate`; keep both in sync with the pinned version. It must never return candidates under `deniedWritePaths`.
- Upgrade routine: README "Upgrading DSH".
- Linux (bwrap/Landlock) is a documented gap; macOS Seatbelt is the target.
