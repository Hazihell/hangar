# PR reviews in the worklog

Gather the review comments Roger (Gitea login `roger.serra`) wrote on the worklog's date, in `ola/ola-ui` and `ola/olalib`, through `tea api` (it prefixes `/api/v1/`):

1. PRs touched that day: `tea pulls list --repo <OWNER/REPO> --state all --fields index,title,updated -o json --limit 50`, keeping those updated on or after the date.
2. For each, his reviews: `tea api repos/<OWNER/REPO>/pulls/<n>/reviews`, keeping `user.login == "roger.serra"` with `submitted_at` on the date. A review's inline comments: `tea api repos/<OWNER/REPO>/pulls/<n>/reviews/<id>/comments`.
3. His plain PR comments: `tea api "repos/<OWNER/REPO>/issues/comments?since=<DATE>T00:00:00<OFFSET>&before=<NEXT_DATE>T00:00:00<OFFSET>"`, keeping his. `<OFFSET>` is the local one as `-03:00` (`date +%z`, with a colon added).

Gitea returns times in UTC: a review counts when its local date is the worklog's date. When Gitea cannot be reached, ask Roger for the reviews and note the gap for the preview.

Each reviewed PR is its own block, after its repository's topics:

```text
OLA Interface, PR Review: feat(phone-input): add PhoneInput, PhoneDisplay, and formatDisplayPhoneNumber #126:
• Flagged that formatDisplayPhoneNumber can emit malformed output for incomplete input, recommending an isValid() check before formatting with a fallback to the trimmed original
• Noted that the wrapper exposes upstream flag-customization props that have no effect since the flag component is hardcoded, and suggested omitting them from the public type
```

- The label is `<Repository>, PR Review: <PR title> #<number>:`.
- One bullet per distinct comment: the issue raised and the fix suggested, written as a concise technical summary.
- Keep the review's concrete identifiers (function names, props, query keys, data-id values), without backticks, so each point stays actionable.
- Write the bullets as feedback Roger gave (flagged, noted, called out), since the author makes the change.

Done when every comment Roger wrote that day sits in its PR's block.
