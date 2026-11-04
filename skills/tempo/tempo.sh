#!/usr/bin/env bash
# Tempo Cloud worklogs through api.tempo.io (v4). Token: ~/.config/tempo/token.
# Usage:
#   tempo.sh list <from> [to]
#   tempo.sh log <date> --hours <n> [--issue <id>] [--dry-run] < description.md
#   tempo.sh edit <worklogId> [--hours <n>] [--issue <id>] [--description-file <file>]
#   tempo.sh delete <worklogId>
set -euo pipefail
DIR="${TEMPO_HOME:-$HOME/.config/tempo}"
exec python3 -I - "$DIR" "$@" <<'PY'
import json, os, sys, urllib.request, urllib.error

home, cmd, *args = sys.argv[1:] + [""] * (2 - len(sys.argv[1:])) if len(sys.argv) < 3 else sys.argv[1:]
USAGE = "usage: tempo.sh list <from> [to] | log <date> --hours N [--issue ID] [--dry-run] | edit <id> [--hours N] [--description-file F] | delete <id>"
if cmd not in ("list", "log", "edit", "delete") or (cmd != "log" and not args) or (cmd == "log" and not args):
    sys.exit(USAGE)
cfg = json.load(open(f"{home}/config.json"))
token = open(f"{home}/token").read().strip()
API = "https://api.tempo.io/4"

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"error: Tempo answered {e.code}: {e.read().decode()[:400]}")

def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default

def show(w):
    first = w["description"].split("\n")[0][:60]
    print(f'{w["tempoWorklogId"]}  {w["startDate"]} {w["startTime"]}  {w["timeSpentSeconds"]/3600:g}h  issue {w["issue"]["id"]}  {first}')

if cmd == "list":
    frm, to = args[0], (args[1] if len(args) > 1 and not args[1].startswith("--") else args[0])
    res = call("GET", f'/worklogs/user/{cfg["accountId"]}?from={frm}&to={to}&limit=1000')["results"]
    for w in res: show(w)
    if not res: print("no worklogs")
elif cmd == "log":
    date, hours = args[0], float(opt("--hours", 8))
    issue = int(opt("--issue", cfg["issueId"]))
    existing = [w for w in call("GET", f'/worklogs/user/{cfg["accountId"]}?from={date}&to={date}')["results"] if w["issue"]["id"] == issue]
    if existing:
        for w in existing: show(w)
        sys.exit(f"error: a worklog already exists on {date} for issue {issue}; use `edit <id>` to change it.")
    body = {"authorAccountId": cfg["accountId"], "issueId": issue, "startDate": date, "startTime": cfg["startTime"],
            "timeSpentSeconds": int(hours * 3600), "billableSeconds": int(hours * 3600), "description": sys.stdin.read().strip()}
    if "--dry-run" in args:
        print(json.dumps({**body, "description": body["description"][:80] + "…"}, indent=2)); sys.exit()
    show(call("POST", "/worklogs", body))
elif cmd == "edit":
    wid = args[0]
    cur = call("GET", f"/worklogs/{wid}")
    hours = float(opt("--hours")) if opt("--hours") else cur["timeSpentSeconds"] / 3600
    body = {"authorAccountId": cur["author"]["accountId"], "startDate": cur["startDate"], "startTime": cur["startTime"],
            "issueId": int(opt("--issue", cur["issue"]["id"])), "timeSpentSeconds": int(hours * 3600), "billableSeconds": int(hours * 3600),
            "description": open(opt("--description-file")).read().strip() if opt("--description-file") else cur["description"]}
    show(call("PUT", f"/worklogs/{wid}", body))
elif cmd == "delete":
    call("DELETE", f"/worklogs/{args[0]}"); print("deleted", args[0])
PY
