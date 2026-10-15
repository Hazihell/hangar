#!/usr/bin/env bash
# fork-stack — maintain a personal patch stack over an upstream fork.
# No remote is touched unless --push is passed.
set -euo pipefail

UPSTREAM="${FORK_STACK_UPSTREAM:-upstream}"
ORIGIN="${FORK_STACK_ORIGIN:-origin}"
BASE="${FORK_STACK_BASE:-main}"
INTEGRATION="${FORK_STACK_INTEGRATION:-custom/main}"

die() { printf 'fork-stack: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
hdr() { printf '\n%s\n' "$*"; }

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"
repo_root=$(git rev-parse --show-toplevel)

# Keyed by the fork's remote URL, not the directory name — two clones of different
# forks can share a basename, and would otherwise share one stack.
stack_key() {
  local url slug
  url=$(git remote get-url "$ORIGIN" 2>/dev/null || echo "$repo_root")
  slug=$(printf '%s' "$url" | sed -e 's#\.git$##' -e 's#.*[:/]\([^/]*/[^/]*\)$#\1#' -e 's#[^A-Za-z0-9._-]#-#g')
  [ -n "$slug" ] && printf '%s' "$slug" || basename "$repo_root"
}
manifest="${FORK_STACK_MANIFEST:-$HOME/.config/fork-stack/$(stack_key).stack}"

stack_branches() {
  [ -f "$manifest" ] || return 0
  sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$manifest" | grep -v '^$' || true
}

has_branch() { git show-ref --verify --quiet "refs/heads/$1"; }

# Git refuses to check out or move a branch another worktree holds.
worktree_holding() {
  git worktree list --porcelain | awk -v ref="refs/heads/$1" -v self="$repo_root" '
    /^worktree /{ wt = substr($0, 10) }
    /^branch /{ if (substr($0, 8) == ref && wt != self) { print wt; exit } }'
}
require_free() {
  local holder
  holder=$(worktree_holding "$1")
  [ -z "$holder" ] || die "$1 is checked out in another worktree:
  $holder
Run fork-stack from there, or release it with:
  git -C '$holder' checkout --detach"
}
require_clean() {
  [ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
}
require_remote() {
  git remote get-url "$1" >/dev/null 2>&1 || die "remote '$1' is not configured"
}
require_manifest() {
  [ -f "$manifest" ] || die "no manifest at $manifest — run 'fork-stack.sh init' first"
}
fetch_upstream() {
  require_remote "$UPSTREAM"
  git fetch --prune "$UPSTREAM" "$BASE"
}

# Every commit of $1 already present in $UPSTREAM/$BASE by patch-id (survives squash-merge).
fully_landed() {
  local out
  out=$(git cherry "$UPSTREAM/$BASE" "$1" 2>/dev/null) || return 1
  [ -n "$out" ] && ! printf '%s\n' "$out" | grep -q '^+'
}

cmd_init() {
  require_remote "$UPSTREAM"
  require_remote "$ORIGIN"
  mkdir -p "$(dirname "$manifest")"
  if [ ! -f "$manifest" ]; then
    cat >"$manifest" <<EOF
# fork-stack manifest for $(stack_key)
# One branch per line, merged into $INTEGRATION in this order.
# custom/* = never going upstream.  everything else = in flight, PR-bound.
EOF
    say "created $manifest"
  else
    say "manifest already exists: $manifest"
  fi
  git config rerere.enabled true
  say "rerere enabled for this repo (conflict resolutions replay on every rebuild)"
}

cmd_status() {
  require_manifest
  hdr "remotes"
  say "  upstream    $(git remote get-url "$UPSTREAM" 2>/dev/null || echo '(missing)')"
  say "  origin      $(git remote get-url "$ORIGIN" 2>/dev/null || echo '(missing)')"
  say "  manifest    $manifest"
  say "  rerere      $(git config --get rerere.enabled || echo 'off — run init')"

  hdr "stack"
  local b state ahead
  for b in $(stack_branches); do
    if ! has_branch "$b"; then
      say "  ✗ $b — branch missing locally"
      continue
    fi
    ahead=$(git rev-list --count "$UPSTREAM/$BASE..$b" 2>/dev/null || echo '?')
    state="$ahead commit(s) over $UPSTREAM/$BASE"
    if fully_landed "$b"; then
      state="LANDED upstream — drop it"
    fi
    case "$b" in
      custom/*) say "  · $b [local-only] $state" ;;
      *)        say "  · $b [PR-bound]   $state" ;;
    esac
  done
  [ -n "$(stack_branches)" ] || say "  (empty — add branches with 'add')"

  hdr "$INTEGRATION"
  if has_branch "$INTEGRATION"; then
    say "  $(git rev-list --count "$INTEGRATION..$UPSTREAM/$BASE" 2>/dev/null || echo '?') upstream commit(s) not yet in it"
    for b in $(stack_branches); do
      has_branch "$b" || continue
      git merge-base --is-ancestor "$b" "$INTEGRATION" 2>/dev/null \
        && say "  ✓ contains $b" || say "  ✗ missing $b — rebuild"
    done
  else
    say "  does not exist yet — run 'rebuild'"
  fi
}

cmd_new() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "usage: new <branch>"
  require_clean
  fetch_upstream
  git checkout -b "$branch" "$UPSTREAM/$BASE"
  cmd_add "$branch"
  say "on $branch, based on $UPSTREAM/$BASE — commit your work, then 'rebuild'"
}

cmd_add() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "usage: add <branch>"
  require_manifest
  if stack_branches | grep -qx "$branch"; then
    say "$branch already in the stack"
    return 0
  fi
  printf '%s\n' "$branch" >>"$manifest"
  say "added $branch to the stack — run 'rebuild' to fold it into $INTEGRATION"
}

cmd_drop() {
  local branch="${1:-}"
  [ -n "$branch" ] || die "usage: drop <branch>"
  require_manifest
  grep -vx "[[:space:]]*$branch[[:space:]]*" "$manifest" >"$manifest.tmp" && mv "$manifest.tmp" "$manifest"
  say "dropped $branch — run 'rebuild' so $INTEGRATION forgets it"
}

cmd_landed() {
  require_manifest
  fetch_upstream
  local b found=0
  for b in $(stack_branches); do
    has_branch "$b" || continue
    if fully_landed "$b"; then
      say "$b"
      found=1
    fi
  done
  [ "$found" = 1 ] || say "nothing in the stack has landed upstream yet"
}

# Rebase every stack branch onto current upstream, so conflicts arrive in small doses.
cmd_sync() {
  require_manifest
  require_clean
  local start_branch
  start_branch=$(git rev-parse --abbrev-ref HEAD)
  fetch_upstream

  if [ "$start_branch" = "$BASE" ]; then
    git merge --ff-only "$UPSTREAM/$BASE"
  elif has_branch "$BASE"; then
    require_free "$BASE"
    git branch -f "$BASE" "$UPSTREAM/$BASE"
  fi
  say "$BASE now matches $UPSTREAM/$BASE"

  local b
  for b in $(stack_branches); do
    has_branch "$b" || { say "skip $b — missing locally"; continue; }
    require_free "$b"
    if git merge-base --is-ancestor "$UPSTREAM/$BASE" "$b"; then
      say "  = $b already current"
      continue
    fi
    if git rebase "$UPSTREAM/$BASE" "$b"; then
      say "  ↑ $b rebased"
      case "$b" in
        custom/*) ;;
        *) say "    (PR branch — its PR updates only when you push --force-with-lease)" ;;
      esac
    else
      say ""
      say "CONFLICT rebasing $b. Resolve, 'git rebase --continue', then re-run sync."
      say "rerere is recording the resolution, so it will not ask twice."
      exit 1
    fi
  done
  git checkout "$start_branch" >/dev/null 2>&1 || true
  say ""
  say "synced. next: rebuild"
}

# $INTEGRATION is a build output — always regenerated, never committed to directly.
cmd_rebuild() {
  require_manifest
  require_clean
  local push=0
  [ "${1:-}" = "--push" ] && push=1
  require_free "$INTEGRATION"
  fetch_upstream

  local b
  for b in $(stack_branches); do
    has_branch "$b" || die "$b is in the manifest but missing locally"
  done

  git checkout -B "$INTEGRATION" "$UPSTREAM/$BASE" >/dev/null
  say "$INTEGRATION reset to $UPSTREAM/$BASE"

  for b in $(stack_branches); do
    if git merge --no-ff --no-edit "$b" >/dev/null; then
      say "  + $b"
    else
      say ""
      say "CONFLICT merging $b into $INTEGRATION."
      say "Resolve, 'git commit', then re-run rebuild — rerere replays the resolution."
      exit 1
    fi
  done

  say ""
  say "$INTEGRATION rebuilt: $UPSTREAM/$BASE + $(stack_branches | wc -l | tr -d ' ') patch(es)"
  if [ "$push" = 1 ]; then
    git push --force-with-lease "$ORIGIN" "$INTEGRATION"
    say "pushed to $ORIGIN/$INTEGRATION"
  else
    say "publish with: $0 rebuild --push"
  fi
}

# Prepare a PR-bound branch: rebase onto upstream, then hand over the gh command.
cmd_ship() {
  local branch="${1:-}" push=0
  [ -n "$branch" ] || die "usage: ship <branch> [--push]"
  [ "${2:-}" = "--push" ] && push=1
  case "$branch" in
    custom/*) die "$branch is marked local-only (custom/*) — rename it before shipping upstream" ;;
  esac
  require_clean
  has_branch "$branch" || die "no such branch: $branch"
  require_free "$branch"
  fetch_upstream

  git checkout "$branch" >/dev/null
  if ! git merge-base --is-ancestor "$UPSTREAM/$BASE" "$branch"; then
    git rebase "$UPSTREAM/$BASE" || die "conflict rebasing $branch — resolve, 'git rebase --continue', re-run ship"
    say "rebased onto $UPSTREAM/$BASE"
  fi

  local upstream_slug origin_owner
  upstream_slug=$(git remote get-url "$UPSTREAM" | sed -e 's#.*[:/]\([^/]*/[^/]*\)$#\1#' -e 's#\.git$##')
  origin_owner=$(git remote get-url "$ORIGIN" | sed -e 's#.*[:/]\([^/]*\)/[^/]*$#\1#')

  if [ "$push" = 1 ]; then
    git push --force-with-lease -u "$ORIGIN" "$branch"
    say "pushed to $ORIGIN/$branch"
  else
    say "push with: $0 ship $branch --push"
  fi
  say ""
  say "open the PR with:"
  say "  gh pr create --repo $upstream_slug --base $BASE --head $origin_owner:$branch \\"
  say "    --title '<type(scope): summary>' --body-file <path>"
  say ""
  say "already open? update its body by fetching the remote body first, then editing."
}

usage() {
  cat <<EOF
fork-stack — a personal patch stack over $UPSTREAM/$BASE, folded into $INTEGRATION.

  init                    create the manifest, verify remotes, enable rerere
  status                  remotes, stack state, what has landed, is $INTEGRATION stale
  new <branch>            branch off $UPSTREAM/$BASE and add it to the stack
  add <branch>            put an existing branch in the stack
  drop <branch>           take a branch out of the stack
  landed                  stack branches already merged upstream (safe to drop)
  sync                    fetch upstream, refresh $BASE, rebase every stack branch
  rebuild [--push]        regenerate $INTEGRATION = $UPSTREAM/$BASE + the whole stack
  ship <branch> [--push]  rebase a PR-bound branch and print its gh pr create

manifest: $manifest
No remote is written unless you pass --push.
EOF
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  status|"") cmd_status ;;
  new) shift; cmd_new "$@" ;;
  add) shift; cmd_add "$@" ;;
  drop) shift; cmd_drop "$@" ;;
  landed) shift; cmd_landed "$@" ;;
  sync) shift; cmd_sync "$@" ;;
  rebuild) shift; cmd_rebuild "$@" ;;
  ship) shift; cmd_ship "$@" ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
