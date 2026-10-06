#!/usr/bin/env bash
# bootstrap.sh — install the pinned DSH runtime, patch it for multi-root,
# wire the workspace-roots bundle into a profile, then verify.
#
# Idempotent: every step checks its target state first and skips when it is
# already in place; a second run changes nothing.
#
#   ./bootstrap.sh            apply
#   ./bootstrap.sh --revert   unwire the profile, restore pristine runtime files,
#                             remove the launcher symlink
#
# Environment:
#   DSH_PROFILE   profile to wire (default: web)
#   DSH_HOME      DSH home (default: ~/.dsh)
#   DSH_LAUNCHER  launcher symlink path (default: ~/.local/bin/dsh; empty to skip)
set -euo pipefail

REPO=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
PROFILE=${DSH_PROFILE:-web}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
LAUNCHER=${DSH_LAUNCHER-$HOME/.local/bin/dsh}
PKG_DIR="$REPO/packages/workspace-roots"
PKG_NAME=dsh-lh-workspace-roots
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
DSH="$REPO/bin/dsh"

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
skip() { printf '    %s (already in place)\n' "$*"; }
die()  { printf '\033[31mbootstrap: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO"

# Run every node/npm step under the Node the launcher uses.
NODE=$("$REPO/bin/dsh-node") || exit 1
PATH="$(dirname "$NODE"):$PATH"
export PATH

running_dsh() {
  pgrep -fl 'node_modules/\.bin/dsh|@deepseek-ai/dsh/lib/bin\.js' | grep -v pgrep || true
}

require_stopped() {
  local procs
  procs=$(running_dsh)
  [ -z "$procs" ] || die "a DSH process is running; stop it before $1:
$procs"
}

pinned_version()    { node -p "require('./package.json').dependencies['@deepseek-ai/dsh']"; }
installed_version() { node -p "require('./node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo none; }

# Exit 0 when the profile already links this bundle exactly.
profile_wired() {
  node - "$PROFILE_DIR" "$PKG_NAME" "$PKG_DIR" <<'EOF'
const [dir, name, pkg] = process.argv.slice(2)
const fs = require('node:fs'), path = require('node:path')
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const linked = fs.realpathSync(path.join(dir, 'node_modules', name)) === fs.realpathSync(pkg)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  process.exit(manifest.dependencies?.[name] !== undefined && bundles.includes(name) && linked ? 0 : 1)
} catch { process.exit(1) }
EOF
}

check_node() {
  echo "    node $(node -v) ($NODE)"
}

home_patch_conflict() {
  local f="$DSH_HOME/cordis.patch.yml"
  local row
  for row in sandbox-policy file-reference-local; do
    if [ -f "$f" ] && grep -Eq "^[[:space:]-]*id:[[:space:]]*$row[[:space:]]*\$" "$f"; then
      die "$f has a $row row; the home layer outranks the bundle and would hide the plugin.
    Back it up and remove that row (see README, 'Profile wiring')."
    fi
  done
}

apply() {
  [ "$(uname -s)" = Darwin ] || printf '\033[33m    warning: not macOS — Linux bwrap/Landlock ignore extra roots and denied paths (see README)\033[0m\n'
  check_node

  say "1/5 runtime @deepseek-ai/dsh $(pinned_version)"
  if [ "$(installed_version)" = "$(pinned_version)" ]; then
    skip "installed $(installed_version)"
  else
    require_stopped "installing"
    npm ci --no-fund --no-audit
  fi

  say "2/5 multi-root patch"
  set +e; node patch/dsh-multi-root.mjs --check >/dev/null; rc=$?; set -e
  case $rc in
    0) skip "all hunks applied" ;;
    3) require_stopped "patching"; node patch/dsh-multi-root.mjs ;;
    *) node patch/dsh-multi-root.mjs --check || true; die "patch anchors do not match this runtime (see README, 'Upgrade routine')" ;;
  esac

  say "3/5 profile '$PROFILE' links $PKG_NAME"
  home_patch_conflict
  if profile_wired; then
    skip "$PROFILE_DIR"
  else
    require_stopped "wiring the profile"
    "$DSH" plugin --profile "$PROFILE" add "$PKG_DIR"
    profile_wired || die "profile $PROFILE is still not wired after 'dsh plugin add'"
  fi

  say "4/5 launcher"
  if [ -z "$LAUNCHER" ]; then
    skip "disabled (DSH_LAUNCHER empty)"
  elif [ "$(readlink "$LAUNCHER" 2>/dev/null)" = "$DSH" ]; then
    skip "$LAUNCHER -> $DSH"
  elif [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
    printf '\033[33m    warning: %s exists and is not ours; left alone\033[0m\n' "$LAUNCHER"
  else
    mkdir -p "$(dirname "$LAUNCHER")"
    ln -s "$DSH" "$LAUNCHER"
    echo "    linked $LAUNCHER -> $DSH"
  fi

  say "5/5 verify"
  local dump
  dump=$("$DSH" --profile "$PROFILE" --dump-config 2>&1)
  for row in "$PKG_NAME" "$PKG_NAME/file-references" "$PKG_NAME/workspace-files" "$PKG_NAME/directory-picker" "$PKG_NAME/repo-skills"; do
    grep -qx "  name: $row" <<<"$dump" || die "composed config of profile $PROFILE does not load $row"
  done
  if grep -q "patch:" <<<"$dump"; then
    grep "patch:" <<<"$dump" >&2
    die "the composed config reports patch warnings"
  fi
  echo "    composed config loads $PKG_NAME and its file-references, workspace-files, directory-picker and repo-skills rows"
  if [ "$(uname -s)" = Darwin ]; then
    node patch/dsh-multi-root-verify.mjs
    node tests/smoke/boot-smoke.mjs || die "boot smoke failed"
  fi
  npm test --silent >/dev/null 2>&1 || { npm test; die "tests failed"; }
  echo "    tests pass"
  say "done — restart 'dsh web' if it was running before"
}

revert() {
  say "1/3 profile '$PROFILE'"
  if profile_wired; then
    require_stopped "unwiring the profile"
    "$DSH" plugin --profile "$PROFILE" remove "$PKG_NAME"
  else
    skip "not wired"
  fi

  say "2/3 runtime files"
  if [ -d node_modules/@deepseek-ai/dsh-sandbox ]; then
    set +e; node patch/dsh-multi-root.mjs --check >/dev/null; rc=$?; set -e
    if [ "$rc" = 3 ] && ! ls node_modules/@deepseek-ai/*/lib/index.js.dsh-multiroot.bak >/dev/null 2>&1; then
      skip "pristine"
    else
      require_stopped "reverting the patch"
      node patch/dsh-multi-root.mjs --revert
    fi
  else
    skip "no runtime installed"
  fi

  say "3/3 launcher"
  if [ -n "$LAUNCHER" ] && [ "$(readlink "$LAUNCHER" 2>/dev/null)" = "$DSH" ]; then
    rm "$LAUNCHER"; echo "    removed $LAUNCHER"
  else
    skip "not ours"
  fi
  say "reverted — the runtime is pristine; $DSH_HOME/cordis.patch.yml was not touched"
}

case "${1:-}" in
  '') apply ;;
  --revert) revert ;;
  *) die "usage: $0 [--revert]" ;;
esac
