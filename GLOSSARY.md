# Hangar

Keeps every computer that runs my coding agents set up the same way, and shows whether each one is up and how loaded it is.

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

**Dashboard**:
The page that shows every Machine: Online or Offline, its current Usage and its History.
_Avoid_: monitor, status page

**Alert**:
A browser push notification about a Machine, for example when it goes Offline or its disk fills. Planned as a follow-up; the Dashboard only displays for now.
_Avoid_: alarm, warning
