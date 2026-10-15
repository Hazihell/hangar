---
name: ship
description: "Commit the work, push the branch and open its pull request."
disable-model-invocation: true
---

Typing this skill's name is the go-ahead for the commit, the push and the pull request. Ask only when it is unclear which changes belong.

The **headline** is one Conventional Commits subject that names the whole branch. A squash merge puts the pull request title on the default branch, where release tooling reads it to title the release and sort its notes, so the headline is written once and used as both the commit subject and the pull request title. Write it the way the default branch already reads, in the language and scope words of `git log origin/<default> -20 --pretty=%s`.

1. Commit whatever uncommitted work belongs to the change with the `gcommit` skill, running the commit directly with the message it drafts; a branch whose work is already committed goes straight to step 2. A branch with a single commit takes the headline as that commit's subject. Done when `git status --short` lists nothing that belongs to the change.
2. Push with `git push -u origin HEAD`. A worktree branch often tracks the default branch, and naming the target keeps the push on a branch of its own. On the default branch or a detached HEAD, create a branch named for the change first.
3. Open the pull request against the default branch, with the headline as its title and a body written with the `pr` skill. When the repository has a pull request template, fill that instead. When the branch already has a pull request, the push updated it: set its title to the headline with `gh pr edit` if the branch now covers more than the title says.
4. Done when `gh pr view --json url,title,headRefOid` shows the headline as the title and your local `HEAD` as the head. Reply with the URL.
