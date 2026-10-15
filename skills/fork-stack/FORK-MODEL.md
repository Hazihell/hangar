# What Changes Where

`origin` holds branches; `upstream` holds the PR and the truth. You only ever write to `origin`. `upstream/main` moves only when a maintainer merges.

| Phase | origin (your fork) | upstream |
| --- | --- | --- |
| Sync | `main` fast-forwarded to match | untouched |
| Work on a topic branch | untouched until you push | untouched |
| Push topic branch | branch created/updated | untouched |
| Open PR | untouched | PR object created, pointing at your fork's branch |
| Push more commits | branch updated | PR updates itself — no re-submit |
| Rebase + force-push | branch history rewritten | PR follows the rewrite |
| Maintainer merges | your branch left exactly as it was | `main` gains a squashed commit |
| Rebuild `custom/main` | integration branch force-updated | untouched, always |

## Consequences worth knowing

**Your fork's `main` is a mirror, not a workspace.** Branch from `upstream/main`, never from a possibly-stale `origin/main`.

**CI on a fork PR runs in upstream's context.** Secrets are restricted and some jobs need maintainer approval before they run, so a PR can sit yellow for reasons that have nothing to do with the code.

**A merged PR does not delete your branch.** Delete it locally and on `origin` yourself, after dropping it from the stack.

**Force-push is safe on branches only you consume.** `custom/main` and your own topic branches qualify. Prefer `--force-with-lease` regardless — it refuses when the remote moved underneath you.

## When the stack outgrows this

At a dozen or more long-lived patches, dedicated patch-queue tools (StGit, TopGit, quilt) manage rebasing and reordering properly. They are a real workflow to learn and earn their keep only at that scale — a manifest plus `rerere` covers a handful of patches at a fraction of the cost.
