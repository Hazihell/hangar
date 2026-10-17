# Hangar

Keeps every computer that runs my coding agents set up the same way, shows whether each one is up, how loaded it is and by what, and alerts me when something goes wrong.

## Monitoring

**Machine**:
A computer that hangar sets up and the Dashboard watches: today the MacBook and the PC. A PC running Ubuntu under WSL is one Machine, its Windows host; WSL is something running on it, not a Machine of its own.
_Avoid_: host, node, device, box, server

**Usage**:
How loaded a Machine is right now, as seen by its own operating system: CPU, RAM and disk.
_Avoid_: stats, metrics, load, health

**Online**:
A Machine whose latest report of its Usage arrived within the last half minute.
_Avoid_: up, on, running

**Offline**:
A Machine that is not Online. Asleep and shut down look the same from outside, so both count as Offline.
_Avoid_: down, off, asleep

**Last seen**:
When an Offline Machine last reported its Usage.

**History**:
A Machine's Usage over the last 24 hours.

**VPN**:
A VPN connection a Machine's operating system manages, such as Steeprock: Connected, Disconnected, or on its way between them. Tailscale doesn't count: the Dashboard reaches Machines through it, so disconnecting it from there would cut the Dashboard off.
_Avoid_: tunnel, network

**Dashboard**:
The page that shows every Machine: Online or Offline, its current Usage, its History, its VPNs (which it can connect and disconnect), its Apps (which it can Quit) and its Updates (which it can run).
_Avoid_: monitor, status page

**Process**:
A program running on a Machine, as its operating system lists it, with the CPU and RAM it uses. On the PC, the processes inside WSL count too, listed under WSL.
_Avoid_: task, job

**App**:
The processes that belong to one program, counted together: Chrome's dozen helpers are one App. The Dashboard lists Apps, and each expands to its Processes.
_Avoid_: group, bundle

**Top Apps**:
The Apps using the most CPU or RAM. The Dashboard keeps the Top Apps of every History minute, so a spike can be explained after the fact.
_Avoid_: culprits, offenders

**Quit**:
Asking a Process or App to close cleanly, as closing its window would. **Force quit** ends it without asking, and is offered only after Quit hasn't worked. Only your own Processes can be quit, never ones the Dashboard or your access to it depends on.
_Avoid_: kill, terminate

**Sleep**:
Putting a Machine into a low-power state that keeps its open Apps ready to resume when it wakes.
_Avoid_: suspend, standby

**Shut down**:
Asking a Machine to close its Apps and turn off. An App with unsaved work may stop it.
_Avoid_: power off, force shutdown

**Update**:
A newer version of a tool Hangar keeps current on a Machine: T3 Code, Claude Code, Codex, gh, tea, or Hangar itself. The Dashboard shows which are out of date and runs the Update when asked; `hangar update` does the same from a terminal, and also updates skills, which need a diff reviewed first and so stay out of the Dashboard. Updating T3 Code restarts its server and interrupts running agent threads; updating Hangar on the PC restarts the Dashboard.
_Avoid_: upgrade, patch, outdated item

**Alert**:
A browser push notification about a problem on a Machine: a disk nearly full, CPU or RAM high for minutes on end, a VPN dropped, the T3 service stopped, or the PC Offline. When the problem clears, the Alert is quietly replaced by one saying so. Each browser or phone opts in.
_Avoid_: alarm, warning
