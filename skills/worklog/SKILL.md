---
name: worklog
description: Write the day's worklog from git history and, once Roger confirms the preview, post it with its hours to Sherlock and Tempo. `partial` posts today so far plus the rest of the day's plan to Tempo only.
disable-model-invocation: true
---

# Worklog

A manager-ready account of one day's work, written from git history and posted as a log on a Sherlock project and as a Tempo worklog. Every post carries Roger's name and notifies the project's people, so nothing is posted until he confirms the exact preview.

When Roger asks for a **partial** worklog (today so far plus the rest of the day's plan, Tempo only), read [`partial.md`](partial.md) before step 1.

## Steps

1. **Resolve the date.** Default to today; accept `today`, `yesterday` or an explicit date. Relative dates come from the shell's local calendar (`date +%F`), never from a UTC timestamp in the chat. The day runs from `00:00:00` to `23:59:59` local. Done when you hold one `YYYY-MM-DD`.

2. **Collect the commits** from both repositories, wherever the skill runs from:
   - OLA: `~/Dev/99x/ola-ui`
   - OLA Interface: `~/Dev/99x/olalib`

   In each one, run:
   ```bash
   git -C <REPO> fetch --all --quiet
   git -C <REPO> log --branches --remotes --author="$(git -C <REPO> config user.name)" --since="<DATE> 00:00:00" --until="<DATE> 23:59:59" --pretty=format:"=== %h %s%n%b" --reverse
   ```
   Branches and remotes, not `--all`: T3 keeps draft snapshots of a thread's work under `refs/t3/`, and they would read as extra work. Unpushed commits exist only on the machine that made them, so run the skill where the day's work was committed. With no commits in either, stop and report `❌ No commits found for '<DATE>' by <USER>.` When a fetch fails, carry on with that repository's local history and note it as a gap for the preview. Done when you hold each repository's commits, even if one has none.

3. **Sort out the work.** The worklog covers product work: features, fixes, refactors, tests, research and docs. These stay out:
   - Release chores: `chore(release)` version bumps and branch version suffixes.
   - Merges between branches (`Merge remote-tracking branch …`).

   A commit repeated on several branches (the same subject, or the same change rebased or squashed into a PR) is one piece of work. A squash-merged PR (`… (#1874)`, `fix/<BUG_ID>: … (#1875)`) gives its number or bug id to the commits behind it. Done when every commit is either inside a topic or one of the exclusions above.

   Then read each bug id's current status from Sherlock: `sherlock show <BUG_ID>`, field `bugstatus`. When Sherlock cannot be reached, the bullets go without a status and that is a gap for the preview. Done when every bug id has its status or is noted as a gap.

   Then find each topic's PR state: `tea pulls list --repo <OWNER/REPO> --state all --fields index,state,head,title -o json --limit 50` (`ola/ola-ui`, `ola/olalib`), matched by the topic's squash-merge number or its branch (`git -C <REPO> branch -a --contains <sha>`). The state is `no PR yet`, `PR #<n> open` or `merged in #<n>`. When Gitea cannot be reached, the labels go without a state and that is a gap for the preview. Done when every topic has its state or is noted as a gap.

4. **Write the worklog** to the format below. Each claim matches its evidence:

   | Claim | Evidence |
   |---|---|
   | implemented, fixed | commits |
   | opened for review | a PR that is still open |
   | a function or file in Technical details | the diff (`git -C <REPO> show <sha>`) |
   | merged | a merged PR (merged is never deployed or released) |
   | tests added | test files in the commits |

   Done when every topic is backed by commits and every bullet's claim sits in the table's row for its evidence.

5. **Set the hours.** Use the hours Roger gave, or 8 when he gives none.

6. **Preview.** Send Roger the exact text that will be posted, in a fenced block. Beneath it, give the project, the hours, and each gap: a repository that could not be fetched, Sherlock or Gitea unreachable. Then stop and wait for his reply. Fold in any edits he asks for and send the preview again. The step is done only when he approves the version you are holding.

7. **Post** to "OLA – New UI Live Bug Tracking - 2026" (`170625694`) unless Roger names another project. Write the approved text to a file under `/tmp/worklog/` and send it on stdin; the CLI turns line breaks into `<br>`:
   ```bash
   sherlock comment 170625694 - --hours <n> < /tmp/worklog/<DATE>.txt
   ```
   Then read it back with `sherlock show <logId>`. Done when `comment` starts with the date line and `spent` equals the hours.

   To correct a posted log, edit it in place rather than posting again: `sherlock set <logId> comment=@<file> spent=<n>`, done when the reply has `saved: true` and an empty `mismatched`.

8. **Post to Tempo.** The approval in step 6 covers this too. Run `~/.claude/skills/tempo/tempo.sh list <DATE>` first: when a worklog already exists for that date, say so and skip this step (offer `edit` only if Roger asks). On a day he posted a partial worklog, that entry stays as it is. Otherwise run `~/.claude/skills/tempo/tempo.sh log <DATE> --hours <n> --description-file /tmp/worklog/<DATE>.txt` and confirm the printed id, date and hours. Then run `list <DATE>`: the first line shown must be `Worklog for <M/D/YY>`. Tempo posts its default description ("Trabalho sobre o ticket SR-874") when the description is empty; when the line differs, run `~/.claude/skills/tempo/tempo.sh edit <id> --description-file /tmp/worklog/<DATE>.txt` and list again. Done when `list <DATE>` shows exactly one worklog with the right hours and the right first line. See the `tempo` skill for setup and errors.

Sherlock dates a log in UTC at the moment of posting, so a log posted late in the local evening shows the next day's date. The date line in the text is the date the log covers.

## Format

Plain text, the same text in Sherlock and Tempo. Both store it as written, so a Markdown marker (`#`, `**`, a backtick, a `-` bullet) would reach the reader raw.

```text
Worklog for 11/10/26

Added a FactList component to the OLA Interface library so a record's facts read label above value on wide surfaces, and fixed how OLA's digital posts show a source site's icon.

OLA Interface, Fact List (no PR yet):
• FactList: new component that shows a record's facts on one surface, each label above its value in responsive columns; empty values show nothing and lists show as whole items
• Stories added for FactList, and tests for empty and list values

OLA, Digital Posts (merged in #1874):
• Site icons: a post's site icon no longer shows as post content in the image area, the Gallery or the lightbox; when the post has no profile picture, the icon becomes its round source avatar

OLA, Bug Fixes:
• 170601159 Embedded Intelligence fails to connect in Chrome: EI cookie selection now matches the backend's last-cookie precedence (Resolved)

Technical details:
• fact-list/index.tsx (interface) - new: FactList and FactListItem render a <dl> that reads its own width through the fact-list container
• favicon.ts (media-preview) - new: isFaviconImage() reads a site icon from its address or from an API size of 64px or less
```

- **Date line:** `Worklog for <M/D/YY>` from the resolved date, then a blank line.
- **Opening:** one or two sentences on what the day's work was for and what came of it, plain enough for a manager who has never seen the code.
- **Topic blocks:** a label `<Repository>, <Topic> (<PR state>):` in Title Case, OLA Interface blocks first, then OLA. A topic is a feature's PR, a page or a flow, named for the part of the app rather than the branch.
- **Bug fixes** Roger wrote himself: one block per repository, `<Repository>, Bug Fixes:`, a bullet each, led by the bug id and ending with its Sherlock status in parentheses.
- **Bullets:** `• ` then the task, a colon, and the concrete logic, component, flow or integration behind it, summarised rather than copied from the commit. Tests go in the topic as their own bullet.
- **Technical details** close the log, one bullet per file or function that carries the work: `<name> (<area>) - new|changed|removed: what it does now`, read from the diff. Name the ones that carry the work, not every file touched.
- **State lives on each item**, a topic's PR state and a bug's status, so the log has no closing status line.
- One line per paragraph and per bullet, never wrapped by hand; a blank line only between blocks. Names of files, functions and components go without backticks.
- Professional engineering tone, plain bullets with no bold. Punctuate with commas, colons, semicolons and parentheses. The em dash (—) never appears.

### Merged reviewed PRs

A `fix/<BUG_ID>` PR whose fix Roger did not commit himself that day is coordination: he merged an already reviewed PR and updated its task. All such PRs gather in one block per repository, a bullet each:

```text
OLA, Merged Reviewed PRs And Updated Their Tasks:
• <BUG_ID> Short bug summary (<status>)
```

When Roger's own commits that day carry the fix, it belongs under Bug Fixes instead.

### PR reviews

When Roger asks to include the PR reviews he did, read [`pr-reviews.md`](pr-reviews.md).
