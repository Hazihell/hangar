---
name: tempo
description: Read, create, edit or delete worklogs in Tempo (Jira) for Roger through the Tempo Cloud API. Use for any "log my hours in Tempo" or "what is in Tempo for <date>" request, and from the worklog skill.
---

# Tempo

`~/.claude/skills/tempo/tempo.sh` talks to `api.tempo.io/4` with a personal API token. No browser or login flow: the token is a Bearer credential and does not lapse unless it was created with an expiry.

## Setup (already done on Roger's machine)

- `~/.config/tempo/token` (mode 600): the token. Never print it, never ask for it in chat. To replace it, call `request_secret` with `delivery: "file"` and copy the file there (`chmod 600`).
- `~/.config/tempo/config.json`: `accountId` (Roger's Atlassian account), `issueId` (numeric Jira issue worklogs go to, currently 37776), `startTime` (08:00:00).
- Override the folder with `TEMPO_HOME`.

## Commands

```bash
tempo.sh list 2026-11-02 2026-11-03                  # id, date, hours, issue, first line
tempo.sh log 2026-11-03 --hours 8 < worklog.md       # description from stdin; --dry-run prints the payload
tempo.sh edit 126922 --hours 7.5 --description-file worklog.md
tempo.sh delete 126922
```

- `log` refuses when a worklog already exists that day on the same issue, so a rerun never double-posts; use `edit`.
- `--issue <numeric id>` overrides the default issue. The API needs the numeric id, not the key.
- Errors print Tempo's own message and exit 1. A 401 means the token is wrong or expired: ask Roger for a new one.

## Rules

Posting is visible to managers: show Roger the exact description, hours, date and issue first, and post only after he confirms (the worklog skill's approval covers its own text). Delete only on his explicit request.
