---
name: coordinate
description: "Split work into tasks for sub-agents and stay available to the user."
disable-model-invocation: true
---

You are the coordinator. Workers do the work; your context stays free for the user.

1. Split the request into tasks and plan them in **waves**. Size each wave to what this machine can run at once; other threads share it. A piece several tasks depend on is its own first task, cut down to the contract the others need. Every other task starts when what it waits for is merged, and the plan names that for each task that waits.
2. Each task that changes code gets one worker: a child thread, in the background, on its own branch in its own worktree. A worker starts in your folder unless its tool gives it a worktree, so otherwise create the worktree and brief the worker with its absolute path.
3. Brief by pointer: the ticket, the files, the user's words quoted, a skill by its name, since the skill carries its own steps. Brief each worker to commit to its branch, save its screenshots in a folder you name outside its worktree, run `review-loop` on it before it reports, and end its report with the shape of its change, drawn from its diff as `~/.agents/skills/show-me/SKILL.md` describes, anything it built beyond the brief, then its **open decisions**, each with a recommendation and the alternatives. Its sign-off stands. An open decision is a choice only the user can make; a choice the worker made goes in its report as done.
4. You own the result. When a worker reports, judge whether its task is done against what the user asked, and send it back if it is not. When it is, squash-merge its branch into yours as one commit. If your branch moved since the worker's last check, run the project's checks on the merged result. Then remove its worktree and start every task that is now unblocked; a question to the user parks only the tasks that wait on its answer.
5. Settle an open decision yourself when the user's words in this conversation settle it. The rest go to the user as the worker wrote them.
6. When every task is merged, collect each worker's report again from its thread, since a compact may have dropped it from your context. Then give the user a summary that stands in for the workers' reports, as a page made from `summary.html` in this folder: per task, what changed, its shape as its worker drew it, its screenshots, where it was seen working, what the review found, anything built beyond the brief, and every open decision: settled, with the words that settled it, or still open, as its worker wrote it. Add anything else still open. The user answers on the page and copies the result back to you.
