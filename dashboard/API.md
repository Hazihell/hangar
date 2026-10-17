# Dashboard API

The contract between the server (`dashboard/server`), the reporters, and the page (`dashboard/web`). Terms follow [GLOSSARY.md](../GLOSSARY.md).

The server listens on `127.0.0.1:4318` (override with `HANGAR_DASHBOARD_PORT`). `tailscale serve` puts it at `https://stormtrooper-linux.taila332e5.ts.net`. In production the server also serves the built page from `dashboard/web/dist`; in development Vite proxies `/api` to it.

## Request safety

Every non-GET/HEAD request requires an allowed `Host`: `127.0.0.1:<server port>`, `localhost:<server port>` or this Machine's tailnet DNS name. Startup reads `tailscale status --json` → `Self.DNSName`, removing the trailing dot; if Tailscale is unavailable, local access still works. `HANGAR_DASHBOARD_HOSTS` adds comma- or whitespace-separated exact hosts (optionally including a port), for an explicit override or additional development host. No wildcards.

Except for `POST /api/report`, a present `Origin` must be `https://<allowed host>`, or `http(s)://127.0.0.1:<allowed port>` / `http(s)://localhost:<allowed port>`. A present `Sec-Fetch-Site` must be `same-origin` or `none`. Violations return `403` before handling the endpoint, including VPN, Quit and Alerts mutations. Reports need the Host check too, but require neither browser header.

Tailscale Serve's TCP HTTP proxy preserves the original Host (`r.Out.Host = r.In.Host` in [Tailscale v1.104.1](https://github.com/tailscale/tailscale/blob/v1.104.1/ipn/ipnlocal/serve.go#L927)), so the Mac reporter's HTTPS URL forwards `stormtrooper-linux.taila332e5.ts.net`, which startup discovers. Forwarded headers do not grant trust.

Vite already uses `changeOrigin: true`, forwarding Host as `127.0.0.1:<server port>`. Browser Origin still names Vite's port: start the backend with `HANGAR_DASHBOARD_HOSTS=localhost:5173,127.0.0.1:5173` for the default local development URLs (adjust for the actual Vite port). No web configuration change is needed.

## Machines

`dashboard/machines.json` lists every Machine. A report naming any other Machine is rejected.

```json
[
  { "id": "stormtrooper", "name": "Stormtrooper", "os": "windows", "collector": "wsl" },
  { "id": "rogers-macbook-air", "name": "MacBook Air", "os": "macos", "collector": "mac", "ssh": "rogerserra@rogers-macbook-air" }
]
```

`collector: "wsl"` means the server collects that Machine's Usage itself, from the Windows host it runs on. `collector: "mac"` means a reporter on the Mac pushes it. `ssh` is how the server reaches a Mac to run VPN commands: the server's user logs in with its own key (`BatchMode`, no prompts).

## Rules

- A Machine is **Online** when its latest report arrived less than 30 s ago; otherwise **Offline**.
- The server stamps each report with its own clock on arrival; Machines' clocks are not trusted.
- Reporters send every 10 s.
- **History** keeps one point per minute: the average of the reports that arrived in that minute. Points older than 24 h are deleted. A minute with no reports has no point.

## `POST /api/report`

```json
{
  "machine": "rogers-macbook-air",
  "cpu": 12.5,
  "ram": { "used": 8123456789, "total": 17179869184 },
  "disks": [{ "name": "Macintosh HD", "used": 301234567890, "total": 494384795648 }],
  "services": { "t3": true },
  "vpns": [{ "name": "Steeprock", "status": "connected", "kind": "ppp" }]
}
```

- `cpu`: percent, 0–100, whole machine, averaged since the previous report.
- `ram.used`: bytes, total minus available (cache doesn't count). macOS has no "available" figure, so the Mac sends Activity Monitor's "Memory Used": app memory + wired + compressed.
- `disks`: every fixed drive; `used` and `total` in bytes.
- `services`: optional. The PC reports `t3`, whether the T3 service is running.
- `vpns`: optional. Every VPN the operating system manages, except Tailscale. Names contain 1–256 characters, no control characters or double quotes, and cannot start with `-` or `/`. `status` is `connected`, `disconnected`, `connecting` or `disconnecting`. `kind` is `ppp` for PPP-based VPNs (L2TP, PPTP) and `other` for the rest; the server picks the Mac's connect command by it. Omitted when collection fails (the server keeps the previous list); an empty array clears the list. The PC reads `Get-VpnConnection` (per-user and all-user); the Mac reads `scutil --nc list`.

- `processes`: optional. The union of the 300 Processes using the most RAM and the 100 using the most CPU (or every Process when fewer), as `{ "pid", "name", "app", "cpu", "ram", "started", "own" }`:
  - `name`: the executable's base name only (`node`, `Codex Helper (Renderer)`, `chrome.exe`), never its path or arguments.
  - `app`: the App it belongs to. On the Mac, the outermost `X.app` in its executable path gives `X` (`Codex`); otherwise `app` is `name` without a trailing `.exe`.
  - `cpu`: percent of the whole Machine, 0–100 (a Process using two of eight cores fully is 25), averaged since the previous report; the Mac uses `ps`’s decaying average.
  - `ram`: bytes resident (working set on Windows, RSS elsewhere).
  - `started`: an opaque token that changes if the PID is reused: Windows `StartTime` ticks, the Mac's `ps -o lstart`, `/proc/<pid>/stat` field 22 in WSL.
  - `own`: whether it runs as the Machine's user (Windows: in the collector's session only when that session is greater than zero, since process owners need admin to read; Mac and WSL: same uid as the collector).
  - The Windows collector's first internal line reports `collectorPid` and `logicalCpus` (`Environment.ProcessorCount`); WSL CPU percentages use that whole-Machine denominator too. The PC also sends `wsl`: the same list for the Processes inside WSL, which the server reads itself.
  - Omitted when collection fails (the server keeps the previous list). The Mac also sends optional `reporterPid` (positive integer); it marks the reporter and its descendants `own: false` so they cannot be quit. The reporter identifies itself and descendants from actual process commands containing `/mac-reporter.sh`; a reported PID is only an extra hint at Quit time. Collectors strip control characters from names; the server drops invalid Process rows without rejecting otherwise valid Usage (list containers and the Usage core remain strictly validated). Processes whose Windows start token is inaccessible use `started: ""` and `own: false`.

Responses: `204` accepted; `400` malformed; `404` Machine not in the list.

## `GET /api/machines`

```json
{
  "now": "2026-10-16T09:30:12.000Z",
  "machines": [
    {
      "id": "stormtrooper",
      "name": "Stormtrooper",
      "os": "windows",
      "online": true,
      "lastSeen": "2026-10-16T09:30:05.000Z",
      "usage": {
        "at": "2026-10-16T09:30:05.000Z",
        "cpu": 7.1,
        "ram": { "used": 11000000000, "total": 34282192896 },
        "disks": [{ "name": "C:", "used": 600000000000, "total": 1000000000000 }],
        "services": { "t3": true }
      },
      "vpns": [
        {
          "name": "Steeprock",
          "status": "connected",
          "pending": null,
          "error": null
        }
      ],
      "apps": {
        "at": "2026-10-16T09:30:05.000Z",
        "list": [
          {
            "name": "WSL",
            "cpu": 22.4,
            "ram": 7481000000,
            "count": 61,
            "quit": false,
            "processes": [],
            "apps": [
              { "name": "node", "cpu": 15.0, "ram": 912000000, "count": 9, "quit": true,
                "processes": [{ "pid": 5121, "name": "node", "cpu": 12.1, "ram": 483000000, "started": "1234567", "quit": true }] }
            ]
          }
        ]
      },
      "history": [{ "t": "2026-10-16T09:29:00.000Z", "cpu": 6.8, "ram": 32.1, "disk": 60.0 }]
    }
  ]
}
```

- `build`: a short hash of the built page's `index.html` that the server is serving (`""` when no page is built), recomputed when that file changes. A tab that sees it differ from the one it loaded with knows the Dashboard was rebuilt and should reload.
- `lastSeen` and `usage` are `null` for a Machine that has never reported.
- `vpns`: the latest known VPNs, `[]` if none. A report omitting `vpns` keeps the previous list. `pending` is `{ "action": "connect" | "disconnect", "since": "<iso>" }` while a command is under way, else `null`. `error` is `{ "message": "...", "at": "<iso>" }` when the last command failed, else `null`.
- `apps`: `null` until the Machine has sent Processes. `list` holds the union of the 10 Apps using the most CPU and the 10 using the most RAM, so the page can sort by either. Each App sums its Processes; `processes` lists them (up to 20, most CPU first). `quit` says whether the Dashboard may Quit it (see Quit below): for an App, whether any of its Processes may be. On the PC, one App is named `WSL`: its `ram` is the `vmmemWSL` Process's and its `cpu` the larger of that Process's and the sum of the Processes inside WSL (Windows doesn't let a user read `vmmemWSL`'s CPU time), its `quit` is always `false`, and instead of `processes` it carries `apps`, the Apps inside WSL built the same way. Kept in memory only.
- `power`: present only on a Machine the Dashboard can put to Sleep or Shut down (today the PC, `collector: "wsl"`). `{ "actions": ["sleep", "shutdown"], "pending": { "action": "sleep" | "shutdown", "since": "<iso>" } | null, "error": { "message": "...", "at": "<iso>" } | null }`. See `POST /api/machines/:id/power`.
- `updates`: present on every Machine. `{ "checkedAt": "<iso>" | null, "checking": bool, "items": [Update], "pending": { "items": ["<id>"], "since": "<iso>" } | null, "error": { "message": "...", "at": "<iso>" } | null }`. See Updates below.
- `history`: oldest first, at most 1440 points. `t` is the start of the minute. `cpu`, `ram` and `disk` are percents; `disk` is the fullest disk's percent.

## `POST /api/machines/:id/vpns/:name`

```json
{ "action": "disconnect" }
```

Connects or disconnects one VPN, once. The Dashboard doesn't hold it there: if the VPN reconnects by itself later, so be it. `:name` is URL-encoded. The request requires a JSON `Content-Type` (for example `application/json`); other or missing content types return `400` as a CSRF guard.

Responses: `202` the command started; `400` `action` isn't `connect` or `disconnect`; `404` no such Machine, no known VPN by that name, or no way to reach the Machine (`collector: "wsl"` or `ssh`); `409` the Machine is Offline, or a command is already pending for that VPN.

How the command runs:

| Machine | `connect` | `disconnect` |
| --- | --- | --- |
| PC (`collector: "wsl"`) | `dashboard/server/vpn-windows.ps1` through `powershell.exe`: RasDial with the credentials Windows saved for the entry. `rasdial.exe` alone ignores them. | `rasdial.exe <name> /disconnect` |
| Mac (`ssh`) | `networksetup -connectpppoeservice <name>` for `kind: "ppp"` (`scutil --nc start` can't read the L2TP shared secret from the keychain); `scutil --nc start <name>` otherwise | `scutil --nc stop <name>` |

The VPN's `pending` is set when the command starts and cleared when a report shows the VPN `connected` (for `connect`) or `disconnected` (for `disconnect`). The command failing (non-zero exit) or 90 s passing without that report clears `pending` and sets `error`. An `error` stays until the next command on that VPN, or until a report shows the VPN reached what was asked. Each of these changes sends a `machine` event. Pending commands and errors live in memory only; a server restart forgets them.

## `POST /api/machines/:id/power`

```json
{ "action": "sleep" }
```

Puts the Machine to Sleep or Shuts it down. The Dashboard runs on the PC, so it goes with it: the page loses its connection until the PC is woken (by Wake-on-LAN, outside the Dashboard) and the server is back. Requires a JSON `Content-Type`, like the VPN endpoint.

Responses: `202` with the Machine's new `power`; `400` `action` isn't `sleep` or `shutdown`; `404` no such Machine, or it has no `power`; `409` the Machine is Offline, or a power command is already pending.

The server sets `pending`, sends a `machine` event, and runs the command about 1.5 s later so the response and event reach the page first:

| `action` | PC command |
| --- | --- |
| `sleep` | `powershell.exe`: `[System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)`. Suspend, not hibernate, though hibernation is enabled. |
| `shutdown` | `shutdown.exe /s /t 0`. Not forced: an app with unsaved work can stop it. |

`pending` clears when the server sees it was suspended (its wall clock jumped while it wasn't running, or the `sleep` command returned success, which happens only once the PC is awake again), or on the server's next start. Either counts as resuming for Alerts. The command failing, or 2 minutes passing with the server still running, clears `pending` and sets `error` (for example, an app blocked Shut down). An `error` stays until the next power command. Pending commands and errors live in memory only.

Sleeping, shutting down and coming back are not Alerts: after the server starts or resumes from suspension, every rule's timer starts over, and for 3 minutes no Offline, VPN or T3 service Alert fires on any Machine. Offline and T3 service problems still there after that fire as usual.

## Updates

The Dashboard checks each Machine for newer versions of the tools Hangar keeps up to date, shows what's out of date, and runs the update when asked. Skill updates are left to `hangar update` in a terminal, since they need a diff reviewed first.

The work is done by `bin/hangar` on the Machine itself, so a terminal and the Dashboard update the same way:

- `hangar outdated --json` prints `{ "items": [Update] }` and changes nothing (beyond refreshing package indexes).
- `hangar update <id>...` updates just those items. `hangar update` with no ids keeps doing everything, skills included.

The PC runs these locally, by the path of the repo's `bin/hangar`. The Mac runs `~/.local/bin/hangar` over SSH (`ssh -o BatchMode=yes`, like the VPN commands); `hangar` puts `~/.local/bin` and Homebrew on its own `PATH`, so a non-interactive SSH session is enough. A Mac whose `hangar` predates `outdated` can't answer, and its checks fail until `hangar sync` brings it up to date.

An `Update`:

```json
{ "id": "claude", "name": "Claude Code", "current": "2.1.302", "latest": "2.1.310", "available": true, "blocked": null }
```

| `id` | `name` | Machines | Current / latest | Update |
| --- | --- | --- | --- | --- |
| `t3` | T3 Code | where `t3` is installed (the PC) | installed version / newest on its channel | `t3 update --yes`. Restarts the T3 server, which interrupts running agent threads |
| `claude` | Claude Code | both | `claude --version` / newest published | `claude update` |
| `codex` | Codex | both | `codex --version` / newest published | `codex update` |
| `gh` | GitHub CLI | both | `gh --version` / the PC: apt's candidate; the Mac: Homebrew's | the PC: `sudo -n apt-get install --only-upgrade gh`; the Mac: `brew upgrade gh` |
| `tea` | Gitea CLI | both | `tea --version` / newest release | the PC: Hangar's checksum-checked install into `~/.local/bin`; the Mac: `brew upgrade tea` |
| `hangar` | Hangar | both | short commit of `HEAD` / of `origin/main` after `git fetch` | `git pull --ff-only` on `main`, then the PC rebuilds and restarts the Dashboard (last, since that restarts this server) and the Mac restarts its reporter |

- `current` or `latest` is `null` when it couldn't be read; `available` is then `false`.
- `blocked` is a short reason the Dashboard can't update this item, or `null`. For example, the checkout has local changes or isn't on `main` (`hangar`), or `sudo` needs a password (`gh` on the PC: "Run `hangar update` on the PC"). A blocked item still shows `available`.
- For `hangar`, `latest` also carries how far behind it is: `"behind": 3` beside the commit (`null` when `origin/main` couldn't be fetched). Only `hangar` has `behind`.
- `latest` is what each tool's own updater would install: Claude Code follows the release channel in `~/.claude/settings.json` (`autoUpdatesChannel`, default `latest`); Codex, the newest `rust-v` release; T3 Code, the newest release on the channel the installed `t3` was published on (nightly here).
- `blocked` is only filled in for an item that is `available`.

Checks run a minute after the server starts, then every 6 hours, and on `POST /api/machines/:id/updates/check`. An Offline Machine is skipped (and checked as soon as it is Online again, if its turn has passed) and keeps its last result. `checking` is true while one runs. A check that fails or answers with something other than the document above keeps the previous result and `checkedAt`, and is tried again after 10 minutes; it sets no `error`. The server drops any item that doesn't fit the shape above. Results live in memory.

### `POST /api/machines/:id/updates`

```json
{ "items": ["claude", "codex"] }
```

Runs `hangar update` with those ids on the Machine, in that order, except that `hangar` always goes last. Requires a JSON `Content-Type`. Responses: `202` with the new `updates`; `400` empty, unknown or duplicate ids, or an id the Machine doesn't list; `404` no such Machine; `409` the Machine is Offline, an update is already pending or still running on it, or an item is `blocked`.

`pending` is set while it runs; when it ends, the server checks that Machine again. A non-zero exit, or 15 minutes passing, clears `pending` and sets `error` (the command's last line of error output, shortened to 160 characters with control characters removed; "Timed out after 15 minutes" for the limit). `hangar update` carries on past a failed item and exits 1 at the end, so one item failing doesn't stop the others. After the limit the server stops the updater and everything it started (SIGTERM to its process group, SIGKILL 10 s later), and until that process has actually exited a new update answers `409` even though `pending` is already `null`. On a Mac only the local `ssh` is stopped; `hangar update` refuses to run twice at once on the same Machine (a lock in `~/.local/state/hangar`), so a second request fails with "Another hangar update is already running" until the first ends. An `error` stays until the next update. Each change sends a `machine` event.

Updating `hangar` on the PC restarts the server, so `pending` is lost with it; the page reconnects and the fresh check shows the new commit.

### `POST /api/machines/:id/updates/check`

Starts a check now. Requires a JSON `Content-Type` (the body is ignored). `202`, or `409` if one is already running or the Machine is Offline; `404` no such Machine.

### `GET /api/machines/:id/t3-threads`

The T3 threads with a run that hasn't finished (running, queued, or waiting for an answer), so the page can say what a T3 update would interrupt: `{ "threads": [{ "title": "...", "status": "running" }] }`. Read-only from T3's own database (`~/.t3/userdata/statev2.sqlite`). `404` for a Machine that isn't the PC or whose last check didn't list `t3`; `{ "threads": null }` if the database can't be read (for example, T3 changed it), and the page then warns in general terms.

## `GET /api/machines/:id/minutes/:t`

The Top Apps of one History minute. `:t` is the minute's `t` from `history`, in ISO form.

```json
{ "t": "2026-10-16T09:29:00.000Z", "apps": [{ "name": "node", "where": "wsl", "cpu": 61.0, "ram": 912000000 }] }
```

- `apps`: the union of the 5 Apps using the most CPU and the 5 using the most RAM, each averaged over the Process samples in that minute (an App missing from a sample counts as 0; a report omitting both Process lists does not count as a sample; explicit empty lists do). `where` is `"wsl"` for Apps inside WSL, otherwise absent. Apps inside WSL are ranked alongside the PC's own Apps; the `WSL` App itself is left out, since its insides are listed.
- Stored with History and deleted with it after 24 h. Each minute retains at most 30 Apps: the union of its 15 CPU leaders and 15 RAM leaders, using accumulated values. Full current-minute sums stay in memory so an App entering the leaders later keeps its earlier contributions; a restart resumes from the retained leaders. Existing minute records migrate with their prior History sample count, since earlier omissions cannot be recovered.

Responses: `200`; `404` no such Machine or no History point at that minute.

## `POST /api/machines/:id/quit`

```json
{ "targets": [{ "pid": 5121, "started": "1234567", "where": "wsl" }], "force": false }
```

Quits Processes once. To Quit a whole App, use the alternative body:

```json
{ "app": "Chrome", "force": false }
```

Or `{ "app": "node", "where": "wsl", "force": false }` for an App inside WSL. `app` and `targets` are mutually exclusive. The server resolves an exact App name to **all** its quittable Processes in the latest known list, with their current `started` tokens, including those beyond the 20-row display cap; it then applies the same per-target checks. No matches returns `200` with an empty `results` array. App resolution can exceed 200 targets; the explicit `targets` form is limited to 200.

`where` is `"wsl"` for Processes inside WSL, otherwise absent. Between 1 and 200 targets; `force` is a required boolean. Requires a JSON `Content-Type`.

A Process may be quit only when it is `own`, has a nonempty `started` token and is not protected. A target absent from the latest known Process list returns `gone`; omitted lists retain the previous list, while empty lists clear it. Protected, whatever its user:

- **PC (Windows):** `vmmemWSL`, `vmmem`, `wsl`, `wslhost`, `wslservice`, `wslrelay`, `svchost`, `StartMenuExperienceHost`, `ShellExperienceHost`, `TextInputHost`, `SearchHost`, `explorer`, `dwm`, `csrss`, `winlogon`, `ctfmon`, `sihost`, `fontdrvhost`, `RuntimeBroker`, `tailscale-ipn`, `tailscaled`, and `powershell` Processes the server itself started.
- **PC (WSL):** PID 1 and the init/`systemd` Processes, the Dashboard server and its ancestors, the main Process of `t3code.service` (looked up again at Quit time; its children, such as the agents, may be quit), `sshd`, `tailscaled`.
- **Mac:** `WindowServer`, `loginwindow`, `Dock`, `Finder`, `SystemUIServer`, `launchd`, any name starting with `sshd` (including process titles such as `sshd-session: user@notty`), Tailscale (`app` `Tailscale` and `tailscaled`), the reporter and its descendants (verified on the Mac from `/mac-reporter.sh` in the PID or ancestor commands, independent of reported `reporterPid`) and every ancestor of the Quit script itself, including the SSH session the server is using.

Before acting, the server checks on the Machine that each PID still has the same `started` token. Without `force`, it asks each Process to close: `taskkill /PID <pid>` on Windows (no `/F`), `SIGTERM` on the Mac and in WSL. With `force`: Windows calls `Kill()` on the verified Process handle; Mac and WSL use `SIGKILL`. Graceful Windows Quit rechecks StartTime immediately before `taskkill`; Windows requests are chunked to keep encoded commands below the Windows command-line limit. Windows Processes without a window may refuse the request; that comes back as `failed` with Windows' message.

Responses: `200` with a result per target, in order; `400` malformed; `404` no such Machine, or no way to reach it; `409` the Machine is Offline; `503` the current T3 MainPID could not be verified for a request involving WSL (nothing is quit).

```json
{ "results": [{ "pid": 5121, "started": "1234567", "where": "wsl", "result": "sent" }] }
```

Each result carries the `pid`, `started` and `where` of the Process it is about, so the page can follow, and if needed Force quit, exactly that Process, also for Processes beyond an App's 20 listed rows.

`result` is `sent` (the request was delivered; the Process may take a moment to close), `gone` (no such Process any more), `changed` (the PID now belongs to a different Process, so nothing was done), `protected` (not allowed, nothing was done), or `failed` with a `message`. The page then watches the Machine's next reports: a Process still listed 10 s after `sent` is offered Force quit.

## Alerts

`dashboard/alerts.json` holds the rules:

```json
{
  "disk": { "at": 90, "clear": 85 },
  "cpu": { "at": 90, "clear": 80, "for": 300 },
  "ram": { "at": 90, "clear": 85, "for": 300 },
  "offline": { "for": 120, "machines": ["stormtrooper"] },
  "vpn": true,
  "t3": true,
  "cooldown": 1800
}
```

- **Disk nearly full:** a disk's percent reaches `disk.at`. Clears below `disk.clear`. One Alert per disk.
- **CPU high / RAM high:** every report for `for` seconds is at or above `at`; two reports more than 60 s apart (a restart, sleep or Offline between them) don't count as one run. Clears when a report falls below `clear`. The Alert names the Top Apps at that moment, up to three, Apps inside WSL named as such: "Stormtrooper CPU at 97 % for 5 min: WSL node 61 %, WSL claude 18 %, chrome 6 %".
- **VPN dropped:** a VPN that was `connected` becomes `disconnected` (through `connecting` or `disconnecting` too) without the Dashboard having disconnected it. A Dashboard `disconnect` doesn't count, including the report that shows it done and clears `pending`. A VPN first seen `disconnected`, or one that disappears from the list, doesn't Alert. Clears when it is `connected` again.
- **T3 service stopped:** `services.t3` goes from `true` to `false`. Clears when `true` again.
- **Offline:** a Machine in `offline.machines` has been Offline for `for` seconds (counted from 30 s after its last report, when it became Offline, and never from before the latest server start or detected resume). Clears when it is Online. While a Machine is Offline its other Alerts are not evaluated.
- An Alert fires when its condition starts, never again while it holds, and not again within `cooldown` seconds of the last time it fired. When it clears, subscribers get a quiet notification with the same `tag`, which replaces the Alert ("Stormtrooper CPU back to normal").
- After server start or a detected resume, rule timers restart and Offline, VPN-dropped and T3-stopped Alerts have a 3-minute grace period; VPN drop detection requires a connected observation after that grace, so a VPN left disconnected by a reboot never produces a delayed drop Alert.
- Conditions already true when the server starts fire once (so two full disks Alert on first start, while Offline and T3 wait for the grace period), except a VPN, which needs to be seen `connected` first. The state of each Alert is kept in SQLite (table `alert_state`), so a restart neither repeats nor forgets Alerts.
- A disk or VPN that stops being reported can't clear by itself: its Alert is replaced by a quiet "D: on Stormtrooper is no longer reported". The state of finished Alerts is dropped once their `cooldown` is over.
- **Delivery.** The server sends each notification to every subscription at once. It counts as delivered once at least one subscription accepts it (a `2xx`; `3xx` redirects are never followed and count as refusals); with no subscriptions it isn't. A fire that isn't delivered is sent again, at most once a minute, for 10 minutes while its condition holds; after that it waits for the next occurrence. A clear is sent only for an Alert that was delivered, and is retried the same way. Every fire and every clear of an Alert is a new generation, and an acknowledgement counts only for its own generation. When a subscription accepts a push that has since been superseded (a catch-up that hung while the Alert cleared, or an older clear after a newer fire), the server immediately sends that same subscription the Alert's newest notification, so a cleared Alert doesn't stay on screen. Failures are logged to the journal (the push service's host and status); they never delay or fail report handling. Subscriptions answering `404` or `410` are deleted.

Push uses the Web Push protocol (RFC 8030) with VAPID (RFC 8292) and `aes128gcm` payload encryption (RFC 8291), implemented on `node:crypto`. The server makes a VAPID key pair on first start and keeps it in `vapid.json` beside the database (`~/.local/state/hangar/vapid.json` by default), as `{ "publicKey", "privateKey" }`: the base64url 65-byte uncompressed point and the raw 32-byte scalar. Its mode is set to 600 whenever it is loaded. If the file is unreadable, malformed, or its two keys don't match, the server logs the error and turns Alerts off: it never makes a new key, since that would invalidate every subscription, and the Alerts endpoints below (except `DELETE`) answer `503` until the file is fixed. The VAPID `sub` claim is `https://github.com/Hazihell/hangar`. The payload is JSON:

```json
{ "title": "Stormtrooper CPU high", "body": "97 % for 5 min: WSL node 61 %, WSL claude 18 %, chrome 6 %", "tag": "stormtrooper:cpu", "machine": "stormtrooper", "quiet": false }
```

The page's service worker shows it with `tag` (so a clearing notification replaces its Alert) and `silent: quiet`. Clicking it opens or focuses the Dashboard at `/#<machine>`.

### `GET /api/alerts/key`

`{ "publicKey": "<base64url uncompressed P-256 point>" }`, for `pushManager.subscribe`. `503` when Alerts are off.

### `POST /api/alerts/subscriptions`

The browser's `PushSubscription` as JSON (`{ endpoint, keys: { p256dh, auth } }`). `201`; `400` malformed. The server pushes to whatever endpoint a subscriber names, so it accepts only `https:` URLs without credentials, on port 443, at a known push service: `fcm.googleapis.com`, `android.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com`, and any subdomain of `push.services.mozilla.com`, `push.apple.com` or `notify.windows.com`. Anything else (internal hosts, other ports, lookalike names) is `400`, and a stored endpoint outside the list is never pushed to. Needs a JSON `Content-Type`. Stored in SQLite (table `subscriptions`); subscribing again with the same endpoint replaces it. A push service answering `404` or `410` deletes the subscription. `503` when Alerts are off. Right after `201`, the new device is sent the Alerts that are firing now and haven't cleared (one notification each, as they were first sent), so a device that subscribes while two disks are full hears about both.

### `DELETE /api/alerts/subscriptions`

`{ "endpoint": "..." }`, JSON `Content-Type`. `204`, also when it wasn't subscribed.

### `POST /api/alerts/test`

`{ "endpoint": "..." }`. Sends that subscription a test notification ("Alerts are on for this device"). JSON `Content-Type`. `204`; `404` not subscribed; `502` the push service refused or couldn't be reached, with `{ "status": <its status, 0 if unreachable> }` in the body; `503` when Alerts are off.

## `GET /api/events`

Server-sent events. Each event is named `machine`, and its data is one Machine in the same shape as above, except that `history` is replaced by `minute`: the current minute's running average, `{ t, cpu, ram, disk }`. The page replaces its last History point when `t` matches, otherwise appends it and drops points older than 24 h. `minute` is `null` when the current minute has no reports yet (as when a Machine turns Offline); the page then leaves History alone.

The server sends an event on every report, when a Machine turns Offline, and when a VPN command starts, succeeds or fails. Events carry `apps` like `GET /api/machines` does.
