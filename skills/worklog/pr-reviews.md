# PR reviews in the worklog

Gather the review comments Roger wrote on the worklog's date, from him or through the Gitea API. Each reviewed PR is its own topic, even across repositories:

```markdown
### PR Review - feat(phone-input): add PhoneInput, PhoneDisplay, and formatDisplayPhoneNumber #126
- Flagged that `formatDisplayPhoneNumber` can emit malformed output for incomplete input, recommending an `isValid()` check before formatting with a fallback to the trimmed original.
- Noted that the wrapper exposes upstream flag-customization props that have no effect since the flag component is hardcoded, and suggested omitting them from the public type.
```

- The header is `### PR Review - <PR title> #<number>`.
- One bullet per distinct comment: the issue raised and the fix suggested, written as a concise technical summary.
- Keep the review's concrete identifiers (function names, props, query keys, `data-id` values) so each point stays actionable.
- Write the bullets as feedback Roger gave (flagged, noted, called out), since the author makes the change.

Done when every comment Roger wrote that day sits under its PR's header.
