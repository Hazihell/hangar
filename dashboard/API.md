# Dashboard API

The contract between the server (`dashboard/server`), the reporters, and the page (`dashboard/web`). Terms follow [GLOSSARY.md](../GLOSSARY.md).

The server listens on `127.0.0.1:4318` (override with `HANGAR_DASHBOARD_PORT`). `tailscale serve` puts it at `https://stormtrooper-linux.taila332e5.ts.net`. In production the server also serves the built page from `dashboard/web/dist`; in development Vite proxies `/api` to it.

## Machines

`dashboard/machines.json` lists every Machine. A report naming any other Machine is rejected.

```json
[
  { "id": "stormtrooper", "name": "Stormtrooper", "os": "windows", "collector": "wsl" },
  { "id": "rogers-macbook-air", "name": "MacBook Air", "os": "macos", "collector": "mac" }
]
```

`collector: "wsl"` means the server collects that Machine's Usage itself, from the Windows host it runs on. `collector: "mac"` means a reporter on the Mac pushes it.

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
  "services": { "t3": true }
}
```

- `cpu`: percent, 0–100, whole machine, averaged since the previous report.
- `ram.used`: bytes, total minus available (cache doesn't count). macOS has no "available" figure, so the Mac sends Activity Monitor's "Memory Used": app memory + wired + compressed.
- `disks`: every fixed drive; `used` and `total` in bytes.
- `services`: optional. The PC reports `t3`, whether the T3 service is running.

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
      "history": [{ "t": "2026-10-16T09:29:00.000Z", "cpu": 6.8, "ram": 32.1, "disk": 60.0 }]
    }
  ]
}
```

- `lastSeen` and `usage` are `null` for a Machine that has never reported.
- `history`: oldest first, at most 1440 points. `t` is the start of the minute. `cpu`, `ram` and `disk` are percents; `disk` is the fullest disk's percent.

## `GET /api/events`

Server-sent events. Each event is named `machine`, and its data is one Machine in the same shape as above, except that `history` is replaced by `minute`: the current minute's running average, `{ t, cpu, ram, disk }`. The page replaces its last History point when `t` matches, otherwise appends it and drops points older than 24 h. `minute` is `null` when the current minute has no reports yet (as when a Machine turns Offline); the page then leaves History alone.

The server sends an event on every report, and when a Machine turns Offline.
