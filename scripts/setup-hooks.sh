#!/usr/bin/env bash
# setup-hooks.sh — Install cortextOS git hooks into the local repo
#
# Run once after cloning:
#   bash scripts/setup-hooks.sh
#
# Installs a pre-push hook that runs npm run build && npm test before
# any push. If either fails, the push is aborted and you fix it locally
# rather than failing on CI.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside a git repository." >&2
  exit 1
}

# .git/hooks is shared across worktrees, so resolve the common dir rather than
# assuming $REPO_ROOT/.git is a directory — in a worktree it is a file.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
GIT_COMMON_DIR="$(cd "$GIT_COMMON_DIR" && pwd)"
HOOKS_DIR="$GIT_COMMON_DIR/hooks"

# Header line carried by every version of our hooks; identifies a hook as ours
# so an older copy can be upgraded rather than silently skipped. Matched as a
# WHOLE LINE within the first few lines, not as a loose substring: a substring
# search anywhere in the file would claim any third-party hook that merely
# mentions this script — including one whose comments explain how to replace it.
ours_marker_for() { printf '# %s hook — installed by scripts/setup-hooks.sh' "$1"; }

install_hook() {
  local name="$1"
  local src="$REPO_ROOT/scripts/hooks/$name"
  local dest="$HOOKS_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "Warning: hook source not found: $src (skipping)" >&2
    return
  fi

  # Non-clobbering: never overwrite an existing hook the user/operator installed
  # (e.g. a local leak-guard pre-push). The -L catches a broken symlink too,
  # which -e alone would miss (and then clobber).
  #
  # But "differs from ours" is two different situations, and treating them alike
  # is how a hook fix stops propagating. .git/hooks is not version controlled, so
  # an OUR-hook-but-older copy is invisible to git: every existing clone keeps
  # running the stale one forever while the repo looks fixed. That is exactly
  # what happened here — the ref-gating and env-scrub fixes lived only in
  # .git/hooks/pre-push and never reached scripts/hooks/pre-push or any other
  # clone. So distinguish by provenance: upgrade our own hook, leave anyone
  # else's alone. OURS_MARKER is the header line every version of our hook has
  # carried, which is what makes an older copy identifiable at all.
  if [[ -e "$dest" || -L "$dest" ]]; then
    # Refuse anything that is not a plain file BEFORE reading or writing it. A
    # symlink here is the dangerous case: cp follows it, so both the backup and
    # the install would write through to whatever it points at — potentially a
    # file outside the repo entirely. Never silently replace it either; a
    # symlinked hook is deliberate, so report and let a human decide.
    if [[ -L "$dest" || ! -f "$dest" ]]; then
      echo "  Skipped: .git/hooks/$name is a symlink or not a regular file (leaving it alone)" >&2
      return
    fi
    if cmp -s "$src" "$dest"; then
      echo "  Already installed: .git/hooks/$name"
    elif head -n 5 "$dest" | grep -qxF "$(ours_marker_for "$name")"; then
      # Keep a copy rather than discarding it outright: if anyone hand-edited
      # our hook in place, that edit is the only record of whatever it fixed.
      # Timestamped so a second upgrade cannot destroy the first backup — which
      # would otherwise delete exactly the hand edit this is meant to preserve.
      # mktemp supplies the uniqueness: a bare timestamp has one-second
      # resolution, so two upgrades in the same second would collide and break
      # the very guarantee this backup exists to provide.
      local backup
      backup="$(mktemp "$dest.bak.$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
      cp "$dest" "$backup"
      # Write to a temp file and rename: rename is atomic, so a concurrent run
      # or an interrupt can never leave a half-written (and still executable)
      # hook behind. mktemp rather than a $$-derived name: a predictable path
      # can already exist as a symlink, and cp would then follow it and write
      # through to whatever it targets — the same hazard guarded above.
      local tmp
      tmp="$(mktemp "$dest.tmp.XXXXXX")"
      cp "$src" "$tmp"
      chmod +x "$tmp"
      mv -f "$tmp" "$dest"
      echo "  Upgraded: .git/hooks/$name (previous version saved as $(basename "$backup"))"
    else
      echo "  Skipped: .git/hooks/$name already exists (leaving your hook in place)"
    fi
    return
  fi

  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  Installed: .git/hooks/$name"
}

echo "Installing cortextOS git hooks..."
install_hook pre-push
echo "Done. Hooks active for this repo clone."
