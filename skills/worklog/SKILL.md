---
name: worklog
description: Write the day's worklog from git history and, once Roger confirms the preview, post it with its hours to his Sherlock project.
disable-model-invocation: true
---

# Worklog

A manager-ready account of one day's work, written from git history and posted as a log on a Sherlock project and as a Tempo worklog. Every post carries Roger's name and notifies the project's people, so nothing is posted until he confirms the exact preview.

## Steps

1. **Resolve the date.** Default to today; accept `today`, `yesterday` or an explicit date. Relative dates come from the shell's local calendar (`date +%F`), never from a UTC timestamp in the chat. The day runs from `00:00:00` to `23:59:59` local. Done when you hold one `YYYY-MM-DD`.

2. **Collect the commits.** Run:
   ```bash
   git fetch --all --quiet
   git log --all --author="$(git config user.name)" --since="<DATE> 00:00:00" --until="<DATE> 23:59:59" --pretty=format:"=== %h %s%n%b" --reverse
   ```
   With no commits, stop and report `❌ No commits found for '<DATE>' by <USER>.`

3. **Sort out the work.** The worklog covers product work: features, fixes, refactors, tests, research and docs. These stay out:
   - Release chores: `chore(release)` version bumps and branch version suffixes.
   - Merges between branches (`Merge remote-tracking branch …`).

   A commit repeated on several branches (the same subject, or the same change rebased or squashed into a PR) is one piece of work. A squash-merged PR (`… (#1874)`, `fix/<BUG_ID>: … (#1875)`) gives its number or bug id to the commits behind it. Done when every commit is either inside a topic or one of the exclusions above.

4. **Write the worklog** to the format below. Done when every topic is backed by commits and no bullet claims work the history does not show.

5. **Set the hours.** Use the hours Roger gave, or 8 when he gives none.

6. **Preview.** Send Roger the exact text that will be posted, in a fenced block, with the project and hours beneath it. Then stop and wait for his reply. Fold in any edits he asks for and send the preview again. The step is done only when he approves the version you are holding.

7. **Post** to "OLA – New UI Live Bug Tracking - 2026" (`170625694`) unless Roger names another project. Write the approved text to a file under `/tmp/worklog/` and send it on stdin; the CLI turns line breaks into `<br>`:
   ```bash
   sherlock comment 170625694 - --hours <n> < /tmp/worklog/<DATE>.md
   ```
   Then read it back with `sherlock show <logId>`. Done when `comment` starts with the date line and `spent` equals the hours.

   To correct a posted log, edit it in place rather than posting again: `sherlock set <logId> comment=@<file> spent=<n>`, done when the reply has `saved: true` and an empty `mismatched`.

8. **Post to Tempo.** The approval in step 6 covers this too. Run `~/.claude/skills/tempo/tempo.sh list <DATE>` first: when a worklog already exists for that date, say so and stop (offer `edit` only if Roger asks). Otherwise run `~/.claude/skills/tempo/tempo.sh log <DATE> --hours <n> --description-file /tmp/worklog/<DATE>.md` and confirm the printed id, date and hours. Then run `list <DATE>`: the first line shown must be `Worklog for <M/D/YY>`. Tempo posts its default description ("Trabalho sobre o ticket SR-874") when the description is empty; when the line differs, run `~/.claude/skills/tempo/tempo.sh edit <id> --description-file /tmp/worklog/<DATE>.md` and list again. Done when `list <DATE>` shows exactly one worklog with the right hours and the right first line. See the `tempo` skill for setup and errors.

Sherlock dates a log in UTC at the moment of posting, so a log posted late in the local evening shows the next day's date. The date line in the text is the date the log covers.

## Format

The first line is `Worklog for <M/D/YY>` from the resolved date (`Worklog for 10/23/26`), followed by a blank line, then one level-3 header per topic, with plain bullets beneath:

```markdown
Worklog for 10/23/26

### Digital Profile Chart Drill-Down (#1874)
- Chart segment dialog: Clicking a Sentiment or Media slice opens a dialog listing the posts behind it, paged 20 at a time with its total.

### Bug Fixes
- `170601159` Embedded Intelligence fails to connect in Chrome: EI cookie selection now matches the backend's last-cookie precedence.
```

- Group by topic or component: a feature's PR, a page, a flow. Bug fixes Roger wrote himself gather under `### Bug Fixes`, one bullet each, led by the bug id.
- Each bullet names a specific task, then the concrete logic, component, flow or integration behind it, summarised rather than copied from the commit.
- Professional engineering tone, plain bullets with no bold.
- Punctuate with commas, colons, semicolons and parentheses. The em dash (—) never appears.

### Merged reviewed PRs

A `fix/<BUG_ID>` PR whose fix Roger did not commit himself that day is coordination: he merged an already reviewed PR and updated its task. All such PRs gather under one section, a bullet each:

```markdown
### Merged Reviewed PRs And Updated Their Tasks
- `<BUG_ID>` Short bug summary.
```

When Roger's own commits that day carry the fix, it belongs under `### Bug Fixes` instead.

### PR reviews

When Roger asks to include the PR reviews he did, read [`pr-reviews.md`](pr-reviews.md).
