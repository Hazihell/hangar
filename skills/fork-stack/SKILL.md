---
name: fork-stack
description: Maintain a personal patch stack on a fork — carry features in your own build before or instead of upstream merging them. Use when the user wants a change in their custom build, wants to sync a fork with upstream, wants to rebuild or install their custom build, wants to open or update an upstream PR from a fork, or asks where a branch of theirs stands.
---

# Fork Stack

Every change lives on its own topic branch over `upstream/main`. `custom/main` is a **build output**, regenerated from those branches — never a branch you commit to. Drop a patch from the list and the next rebuild has never heard of it.

Naming carries the routing decision, so it is never re-litigated:

- `custom/*` — local-only. Never shipped upstream.
- anything else (`feat/*`, `fix/*`) — PR-bound, in flight.

The stack lives in a manifest outside the repo (`~/.config/fork-stack/<repo>.stack`), because `rebuild` resets the worktree and would delete a tracked copy mid-run.

Run everything through `scripts/fork-stack.sh` from the repo root. `--help` lists it. **It writes to no remote unless you pass `--push`** — surface the push as its own step and let the user approve it.

## First run in a repo

`fork-stack.sh init` — verifies `upstream` and `origin`, creates the manifest, enables `rerere`. Then `add` each branch that already belongs in the custom build. Done when `status` lists every one of them.

`rerere` is what makes the stack survivable: a conflict between a long-lived patch and upstream churn is resolved once, then replayed on every later rebuild automatically.

## Add a feature to the custom build

1. `fork-stack.sh new custom/<name>` — branches off current `upstream/main` and joins the stack.
2. Build the feature there and commit.
3. `fork-stack.sh rebuild` — regenerates `custom/main` as `upstream/main` + the whole stack.
4. Install it with the project's own local-install command, reading the repo's contributing docs or `package.json` scripts to find it rather than guessing.

Done when `status` shows `✓ contains custom/<name>`.

If the same work might go upstream later, name it `feat/<name>` instead — it stacks identically, and `ship` will accept it.

## Refresh against upstream

`fork-stack.sh sync` then `fork-stack.sh rebuild`.

`sync` fast-forwards `main`, then rebases each stack branch onto the new `upstream/main` individually — small doses, so conflicts stay legible. On a conflict it stops with the branch checked out; resolve, `git rebase --continue`, re-run. Rebasing a PR-bound branch is local-only; its PR moves only on a push.

## Ship a feature upstream

1. `fork-stack.sh ship <branch>` — rebases onto `upstream/main`, then prints the PR command.
2. Run the checks the repo's contributing docs require before pushing — every one of them, green.
3. `fork-stack.sh ship <branch> --push`, then create the PR with the printed command and a body following the repo's PR template.

`ship` prints a GitHub `gh` command. On another host, keep the rebase and push, and substitute that host's CLI (`glab mr create`) or its web UI.

The branch stays in the stack while the PR is open, so the custom build keeps carrying it.

**Updating an open PR body:** fetch the live body from GitHub and edit *that*. A `gh pr edit --body-file` from a local copy silently discards whatever was added in the browser — screenshots most of all.

## Retire a landed patch

`fork-stack.sh landed` matches by patch-id, so it still recognises a branch that was squash-merged upstream under a new SHA. For each one: `drop`, `rebuild`, then delete the branch locally and on `origin`. The code now arrives through `upstream/main`, and the stack shrinks.

A `custom/*` patch that upstream rejected outright needs nothing — it just stays in the manifest forever. That is the point of the stack.

## Guardrails

- **`custom/main` is never the head of a PR.** It is a stack of unrelated patches; it has no reviewable story. Ship the topic branch.
- **Push only to `origin`.** `upstream` is written by maintainers merging, never by you.
- A dirty worktree stops `sync`, `rebuild`, and `ship` — commit or stash first.
- **Run stack commands from the primary worktree.** Git lets only one worktree hold a branch, so a session worktree cannot move `custom/main` or rebase a branch the primary has checked out. The script detects this and names the holding worktree; work there, or release it with `git -C <path> checkout --detach`.
- A folder workspace with no git repo is out of scope — the stack is a git construct.

For what actually changes on origin versus upstream at each phase, read [`FORK-MODEL.md`](FORK-MODEL.md).
