# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui on Base UI primitives (not Radix). Charts through shadcn's chart component (Recharts). npm. Built into `dashboard/web/dist`, which `dashboard/server` serves in production. User's choice, non-negotiable.

## Users

One person, Roger, who runs coding agents on his own computers. He opens the Dashboard from his Android phone and from his MacBook, over Tailscale, usually to answer one question: is everything OK?

## Product Purpose

Hangar keeps every computer that runs Roger's coding agents set up the same way. The Dashboard is the page that shows every Machine: Online or Offline, its current Usage (CPU, RAM, every disk) and its 24 h History, its VPNs, and its Apps. Success: a glance tells him all is well, and the one thing that is not well (a Machine Offline, a disk nearly full, the T3 service stopped) stands out without him reading. When something did go wrong, two more questions follow, and the page answers them on demand rather than up front: what is using the Machine right now (Apps, Quit), and what caused that spike hours ago (Top Apps of a History minute). Alerts reach his phone when he isn't looking.

## Operating Context

- Two Machines today: a MacBook Air, and a Windows PC named Stormtrooper that runs Ubuntu under WSL with a T3 Code server. Designed for 1–6.
- Opened casually, often on a phone, between other things; sometimes left open on the laptop while an agent works. Live updates over server-sent events.
- Follows the system light/dark setting; no toggle.

## Capabilities and Constraints

- Data contract: `dashboard/API.md`. A Machine is Online when its latest report arrived less than 30 s ago. History is one point per minute, 24 h, with cpu, ram and fullest-disk percents.
- Terminology from `GLOSSARY.md`: Machine, Usage, Online, Offline, Last seen, History, VPN, Dashboard, Process, App, Top Apps, Quit, Force quit, Alert. Avoid: host, node, device, box, server (for a Machine); stats, metrics, load, health; up/down/on/off/running/asleep; kill, terminate (say Quit); task, job (say Process); culprits, offenders (say Top Apps); alarm, warning (say Alert).
- Mostly display. The actions are: connecting or disconnecting a Machine's VPNs (disconnecting asks first); Quit for Apps and Processes the Dashboard may quit, and Force quit when Quit hasn't worked (both always ask); and turning Alerts on or off for this browser.
- Every App lists at most 20 of its Processes; quitting an App goes to the server by name, which quits all of its Processes that may be quit.
- Alerts are Web Push through a push-only service worker (`public/sw.js`, scope `/`, no caching). Push needs a secure context: the tailnet `https://` address, or `http://127.0.0.1` / `localhost` in development. On iOS it needs the page added to the Home Screen.
- The server takes commands only from the Dashboard's own origin; in development, Vite's proxy presents them as such (`vite.config.ts`).

## Product Principles

1. Calm when all is well. The page should look quiet when nothing needs attention. What's only sometimes needed (Apps, a minute's Top Apps, Alerts settings) stays folded away until asked for.
2. Reserve alarm. Strong color only for genuinely bad states (e.g. a disk over 90 %); Offline reads clearly without shouting.
3. Big readable numbers over many small labels. No dense admin feel.
4. Readable at a glance on a phone first, comfortable on a laptop.

## Accessibility & Inclusion

State is never carried by color alone: Online/Offline and nearly-full are also said in words.
