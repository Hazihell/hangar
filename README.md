# hangar

Keeps every machine that runs my coding agents set up the same way: skills, agent instructions and Claude Code config, linked into place and synced through this repo. Today it serves a MacBook and a Windows PC running Ubuntu under WSL that hosts a [T3 Code](https://github.com/pingdotgg/t3code) server.

The repo is cloned to `~/.agents` on each machine, because Codex and the skills installer read skills from there. `bin/hangar` does the rest.

| Folder | What it holds | How it reaches the tools |
| --- | --- | --- |
| `cast/cast.md` | The instructions every agent reads: model list, sub-agent rules | `~/.claude/CLAUDE.md` imports it; `~/.codex/AGENTS.md` links to it |
| `skills/` | All skills, mine and installed ones; `.skill-lock.json` records where installed ones came from | `~/.claude/skills` links here; Codex reads `~/.agents/skills` directly |
| `claude/` | Claude Code settings, status line, hooks, sub-agent definitions | Linked into `~/.claude`, except `settings.json`, which is copied |
| `bin/hangar` | The command below | Linked to `~/.local/bin/hangar` |

`settings.json` is copied, not linked, because Claude Code rewrites it when you change a setting and can turn a link into a plain file. `hangar sync` merges changes from both machines, and stops to ask only when both changed the same setting.

Not in the repo: Codex's `config.toml`, which is full of per-machine project paths; `settings.local.json`; logins; T3 Code's own settings, which live per machine in **Settings → Providers**; skills Claude Code syncs from a claude.ai account; and Framer skills, which hold per-site data and live in each site's project.

Third-party skills keep their upstream licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).

## Day to day

```bash
hangar sync      # after changing a skill or setting on any machine
hangar doctor    # when something seems off
hangar update    # Claude Code, Codex, installed skills, T3 Code, gh and tea
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

Add a Task Scheduler task that runs `wsl.exe -d Ubuntu --exec /bin/true` at logon, so the server comes up after a reboot.

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
