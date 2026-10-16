# Dashboard API

The contract between the server (`dashboard/server`), the reporters, and the page (`dashboard/web`). Terms follow [GLOSSARY.md](../GLOSSARY.md).

The server listens on `127.0.0.1:4318` (override with `HANGAR_DASHBOARD_PORT`). `tailscale serve` puts it at `https://stormtrooper-linux.taila332e5.ts.net`. In production the server also serves the built page from `dashboard/web/dist`; in development Vite proxies `/api` to it.

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
      "history": [{ "t": "2026-10-16T09:29:00.000Z", "cpu": 6.8, "ram": 32.1, "disk": 60.0 }]
    }
  ]
}
```

- `lastSeen` and `usage` are `null` for a Machine that has never reported.
- `vpns`: the latest known VPNs, `[]` if none. A report omitting `vpns` keeps the previous list. `pending` is `{ "action": "connect" | "disconnect", "since": "<iso>" }` while a command is under way, else `null`. `error` is `{ "message": "...", "at": "<iso>" }` when the last command failed, else `null`.
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

## `GET /api/events`

Server-sent events. Each event is named `machine`, and its data is one Machine in the same shape as above, except that `history` is replaced by `minute`: the current minute's running average, `{ t, cpu, ram, disk }`. The page replaces its last History point when `t` matches, otherwise appends it and drops points older than 24 h. `minute` is `null` when the current minute has no reports yet (as when a Machine turns Offline); the page then leaves History alone.

The server sends an event on every report, when a Machine turns Offline, and when a VPN command starts, succeeds or fails.
