# hangar

Keeps every machine that runs my coding agents set up the same way: skills, agent instructions and Claude Code config, linked into place and synced through this repo. Today it serves a MacBook and a Windows PC running Ubuntu under WSL that hosts a [T3 Code](https://github.com/pingdotgg/t3code) server.

The repo is cloned to `~/.agents` on each machine, because Codex and the skills installer read skills from there. `bin/hangar` does the rest.

| Folder | What it holds | How it reaches the tools |
| --- | --- | --- |
| `cast/cast.md` | The instructions every agent reads: model list, sub-agent rules | `~/.claude/CLAUDE.md` imports it; `~/.codex/AGENTS.md` links to it |
| `skills/` | All skills, mine and installed ones; `.skill-lock.json` records where installed ones came from | `~/.claude/skills` links here; Codex reads `~/.agents/skills` directly |
| `claude/` | Claude Code settings, status line, hooks, sub-agent definitions | Linked into `~/.claude`, except `settings.json`, which is copied |
| `dashboard/` | Dashboard server, page and Mac reporter | Linux user service; launchd reporter on the Mac |
| `bin/hangar` | The command below | Linked to `~/.local/bin/hangar` |

`settings.json` is copied, not linked, because Claude Code rewrites it when you change a setting and can turn a link into a plain file. `hangar sync` merges changes from both machines, and stops to ask only when both changed the same setting.

Not in the repo: Codex's `config.toml`, which is full of per-machine project paths; `settings.local.json`; logins; T3 Code's own settings, which live per machine in **Settings → Providers**; skills Claude Code syncs from a claude.ai account; and Framer skills, which hold per-site data and live in each site's project.

Third-party skills keep their upstream licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).

## Day to day

```bash
hangar sync      # after changing a skill or setting on any machine
hangar doctor    # when something seems off
hangar update    # Claude Code, Codex, installed skills, T3 Code, gh and tea
hangar outdated  # which of those have a newer version (the Dashboard shows the same)
hangar update claude gh   # just those; ids: t3 claude codex gh tea hangar
tests/sync-tests.sh   # after changing bin/hangar: tests it in scratch home folders
```

Edit skills in place; git history keeps every earlier version. Remove an installed skill with `npx skills remove <name> -g` so its lockfile entry goes too, then sync. After `hangar update`, check `git diff` before syncing, since an upstream skill update overwrites local edits to that skill.

## New Linux machine (a Windows PC under WSL)

In Windows, create `C:\Users\<you>\.wslconfig`, then run `wsl --shutdown` in PowerShell:

```ini
[wsl2]
memory=16GB
processors=8
[general]
instanceIdleTimeout=-1
[experimental]
autoMemoryReclaim=gradual
```

`hangar setup` puts `windows/start-ubuntu.cmd` in your Windows Startup folder; it starts Ubuntu at sign-in, so the server comes up after a reboot.

In Ubuntu:

```bash
sudo apt update && sudo apt install -y gh git
gh auth login                   # needed to push from this machine
gh repo clone Hazihell/hangar ~/.agents
~/.agents/bin/hangar install    # system packages, gh, tea, Claude Code, Codex, T3 Code (nightly), service
# install Node; with nvm, put its lines in ~/.profile so T3 Code can see it
claude                          # sign in, then /exit
t3 connect                      # link the machine to your T3 account
~/.agents/bin/hangar setup
hangar doctor
```

Clone projects into the Linux home folder, not under `/mnt/c`.

Install Tailscale for Windows, not inside Ubuntu: it serves the Dashboard to the tailnet and passes requests to Ubuntu over `localhost`. A second Tailscale inside Ubuntu keeps breaking: Windows sleep freezes Ubuntu and strands its connection to Tailscale's server, and a Windows VPN lowers the packet size Ubuntu may send below what Tailscale needs.

Put `networkingMode=mirrored` under `[wsl2]` in `.wslconfig`, then run `wsl --shutdown`. Ubuntu then shares Windows' network: Tailscale, the LAN and any Windows VPN, each with its own packet size. A dev server listening on every address (Vite's `--host`, `0.0.0.0`) opens on the tailnet at `http://stormtrooper:<port>`. Tailscale's own Windows firewall rule lets the tailnet in; the LAN stays out. Windows and Ubuntu share `localhost` ports, so a port can't be used on both. The first boot after the switch can keep the Dashboard from starting for two minutes, until Windows releases the connections it had to the old `localhost:4318`; systemd keeps retrying it until it starts.

Windows counts a wake from the network as unattended and sleeps again after two idle minutes, since nobody touches the keyboard or mouse. `hangar setup` sets that timeout to never, so the PC sleeps only when told to.

## Dashboard

Shows each Machine's Usage, whether it is Online, when it was last seen and its last 24 hours of History. Open https://stormtrooper.taila332e5.ts.net while connected to Tailscale.

`hangar install` builds the page, starts `hangar-dashboard.service` on Linux and runs `tailscale serve --bg 4318` (on the PC, Windows' `tailscale.exe`). Install Node 24 first; the service records its absolute path, and install/update refresh that path after a Node upgrade. On a Linux machine outside WSL, if Tailscale refuses permission, run `sudo tailscale set --operator=$USER`. `hangar update` rebuilds the page and restarts the service. `hangar setup` on the Mac loads its reporter with launchd.

The PC collects Windows Usage from WSL; the Mac sends a report every ten seconds. Machine names live in `dashboard/machines.json`; the contract is in `dashboard/API.md`. Reports and History stay in `~/.local/state/hangar/dashboard.db`. Override the server port or database with `HANGAR_DASHBOARD_PORT` and `HANGAR_DASHBOARD_DB`. The Mac reporter accepts `HANGAR_MACHINE` and `HANGAR_DASHBOARD_URL` (the full `/api/report` URL); set these in the launchd plist's `EnvironmentVariables` when needed.

The Dashboard shows each Machine's CPU Temperature (and the PC's GPU's). The PC reads it from HWiNFO64, which must run from the "Hangar HWiNFO" logon task with Gadget reporting ticked for CPU (Tctl/Tdie); install HWiNFO64, then `hangar setup` on the PC creates the task and the setting, with one UAC prompt on its screen. The Mac's helper is compiled by `hangar setup` (needs Xcode's command line tools), and `hangar doctor` checks both.

The Dashboard lists OS-managed VPNs (excluding Tailscale) and can connect or disconnect each one. Mac VPN control requires Remote Login enabled and the PC user’s SSH key in the Mac user’s `authorized_keys`; `hangar doctor` checks this connection.

The Dashboard lists Apps and their Processes, keeps Top Apps for each History minute, and can Quit your unprotected Processes or Force quit them when needed.

The Dashboard checks each Machine for newer versions of T3 Code, Claude Code, Codex, gh, tea and Hangar itself (`hangar outdated`, every 6 hours) and can run any of those Updates (`hangar update <id>`); the Mac is reached over the same SSH as its VPNs and needs a `hangar` that has `outdated`, so run `hangar sync` there after this lands. Skills stay with `hangar update` in a terminal.

The Dashboard sends Alerts as browser push notifications for full disks, sustained high CPU or RAM, a CPU that stays too hot, dropped VPNs, a stopped T3 service and an Offline PC; rules are in `dashboard/alerts.json`, and the VAPID key sits beside the database as `vapid.json`.

Run `npm test --prefix dashboard/server` and `dashboard/reporter/parser-tests.sh` to check the server and Mac parsers. The server needs no npm dependencies or build step.
