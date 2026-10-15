---
name: worklog
description: Generate a professional daily worklog from git commits for a specific date, usually for status reporting to a manager or team lead. Use when asked to create a worklog, daily report, status summary, or commit-based progress update for today, yesterday, or a specific date.
disable-model-invocation: true
---

# Worklog

Generate a concise, technical daily worklog from git history for the current repository.

## Workflow

1. Resolve the target date from the user request.
Default to today when no date is provided.
Accept relative dates such as `today` and `yesterday` or an explicit date such as `2026-03-12`.

2. Read the configured git author name:
```bash
git config user.name
```

3. Refresh remote refs before reading history:
```bash
git fetch --all --quiet
```

4. Collect commits across all branches for that author and date:
```bash
git log --all --author="$(git config user.name)" --since="<DATE> 00:00:00" --until="<DATE> 23:59:59" --pretty=format:"%s%n%b" --reverse
```

5. Stop if no commits are returned and report:
```text
❌ No commits found for '<DATE>' by <USER>.
```

6. Group the commit content by topic or component, then write a manager-ready worklog.

7. Detect merged reviewed PRs separately from direct implementation work.
Treat commits whose subject or body indicates a merged bugfix PR, especially patterns like `fix/<BUG_ID>`, `bugfix/<BUG_ID>`, or PR descriptions that reference a Sherlock bug and reviewed/merged PR flow, as coordination work rather than same-day implementation.
When these appear, summarize them in a dedicated section such as `### Merged Reviewed PRs And Updated Their Tasks`.
List each bug as its own bullet in the format:
```markdown
- `<BUG_ID>` Short bug summary.
```
Do not describe these entries as if the user implemented the fix that day unless other non-merge commits clearly show direct code changes by the user for that bug on that date.

8. When the user asks to include PR reviews they did, add each reviewed PR as its own topic.
Gather the review comments the user authored on that date (from the user, or via the Gitea API).
Give each reviewed PR its own level-3 header in the format `### PR Review - <PR title> #<number>`.
Under each header, list every distinct review comment as a plain bullet, rephrased as a concise technical summary of the issue raised and the suggested fix.
Preserve concrete identifiers from the review (function names, props, query keys, `data-id` values) so the point stays actionable.
Do not merge multiple reviewed PRs into a single shared section; one header per PR, even across different repositories.
Do not describe review comments as if the user implemented the change; they are review feedback, not same-day code by the user.

## Output Rules

- Use a professional software-engineering tone.
- NEVER use the Em Dash (—) character anywhere in the output.
- Be specific and technical. Mention concrete logic, components, flows, integrations, or fixes rather than generic progress language.
- Infer likely topic groupings from commit subjects and bodies.
- Avoid repeating raw commit messages verbatim when a clearer technical summary is possible.
- Do not invent work that is not supported by the commit history.
- Distinguish direct code changes from merge/review coordination. If a commit represents merging an already reviewed PR and updating the corresponding task, say that explicitly and keep the wording brief.
- Use Markdown level-3 headers for each topic.
- Use plain list items under each topic with no bold formatting.
- When multiple merged reviewed bugfix PRs are present, group them under a single section titled `### Merged Reviewed PRs And Updated Their Tasks` instead of repeating the same phrasing in each bullet.
- Treat PR reviews the user performed as distinct topics, one level-3 header per PR in the format `### PR Review - <PR title> #<number>`, with one bullet per review comment. This is separate from the merged reviewed bugfix PR section above, which is about coordination on the user's own bugfix PRs.

Use this exact shape:

```markdown
### Topic or Component
- Specific task: Technical description of the change
```

## Date Handling

- Interpret the date in the user's local context when possible.
- Resolve `today` and `yesterday` from the shell's local calendar date at execution time, not from any UTC timestamp embedded in the chat metadata.
- If the user provides an explicit date, use that date as written unless the user explicitly requests UTC handling.
- When an ISO timestamp or other timezone-bearing value appears in the prompt, convert it to the local timezone before deciding the worklog date.
- Use the resolved calendar date explicitly in the response when the request used a relative date and ambiguity is possible.
- Treat the range as the full local day from `00:00:00` to `23:59:59`.
- When collecting commits, always build the `--since` and `--until` window from the resolved local date, and show the resolved date window if there is any ambiguity.

## Example

For commits such as `feat: add login flow` and `fix: token expiry redirect loop`, produce output like:

```markdown
### Authentication
- Implemented the login flow, including the client-side entry point and supporting authentication state handling.
- Corrected token expiry behavior to prevent redirect loops when the session is no longer valid.
```

For PR reviews the user performed, produce output like:

```markdown
### PR Review - feat(phone-input): add PhoneInput, PhoneDisplay, and formatDisplayPhoneNumber #126
- Flagged that `formatDisplayPhoneNumber` can emit malformed output for incomplete input, recommending an `isValid()` check before formatting with a fallback to the trimmed original.
- Noted that the wrapper exposes upstream flag-customization props that have no effect since the flag component is hardcoded, and suggested omitting them from the public type.

### PR Review - feat(admin): add queue management page with kanban board #252
- Called out an interactive shared-library `Button` rendered per card without a `data-id`, proposing a stable `queue-management-queue-${queueId}-progress-button` id.
- Flagged that routine refetches trigger the blocking overlay, recommending only pending mutations block interaction while refetches stay non-blocking.
```

## Final Step

Output only the worklog. Do not add any surrounding commentary, offers, or suggestions before or after the worklog content.
