---
name: review-loop
description: "Use before you report a code change you own as finished: see it working, get it reviewed, and loop until the reviewers sign off."
---

You own a change when you report it to the user, or when your brief asks you to run this skill. Part of a change you wrote for another agent is reviewed with the whole, by that agent.

A change is finished when it has been **seen working** and its reviewers **sign off**, not when its tests pass.

### 1. See it working

Run the change in the real app and record where: browser, simulator or device, and on which platform. A change that could only be read says so.

### 2. Review

Run the `code-review` skill. You started this, so supply what it would ask the user for:

- **Fixed point**: the commit your work started from. Uncommitted work is part of the change: have the reviewers read the working tree against that commit.
- **Spec**: the tracker issue if there is one; otherwise what the user asked for and agreed to in this conversation, quoted word for word.
- **Seen working**: your record from step 1.
- **Tests**: have the reviewers judge each added test against the `tests` skill and name each one that matches an anti-pattern.
- **Reviewer model**: as the models list says. If the list is not in your context, read `~/.agents/cast/cast.md`.

### 3. Answer every finding

Each finding gets one answer: the **fix**, or the **reason** it stands as it is. Re-run the checks after the fixes.

### 4. Re-review

Send each reviewer its own findings back, each with your answer, and the diff of what changed since its last read. Where a reviewer cannot be messaged again, start a new one on the same model with the same material. It checks the code, not your account of it, and returns per finding **signed off** or **still open** with why, plus anything the fixes broke.

### 5. Loop

Repeat 3 and 4 on what is still open. A finding gets three reads: the review and two re-reviews. One still open after the third becomes an **open decision**: it goes to the user with both positions, and the user settles it.

Done when every finding is signed off or is an open decision.

### 6. Report

Name the reviewer and where the change was seen working. List each finding with its answer, the rounds it took and who closed it.
