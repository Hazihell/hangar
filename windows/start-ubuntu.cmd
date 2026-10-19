@echo off
rem Starts Ubuntu at sign-in, so T3 Code and the Hangar Dashboard come up after a reboot.
rem `hangar setup` copies this here from windows/start-ubuntu.cmd in the repo; edit that one.
wsl.exe -d Ubuntu --exec /bin/true
