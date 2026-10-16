# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui on Base UI primitives (not Radix). Charts through shadcn's chart component (Recharts). npm. Built into `dashboard/web/dist`, which `dashboard/server` serves in production. User's choice, non-negotiable.

## Users

One person, Roger, who runs coding agents on his own computers. He opens the Dashboard from his Android phone and from his MacBook, over Tailscale, usually to answer one question: is everything OK?

## Product Purpose

Hangar keeps every computer that runs Roger's coding agents set up the same way. The Dashboard is the page that shows every Machine: Online or Offline, its current Usage (CPU, RAM, every disk) and its 24 h History. Success: a glance tells him all is well, and the one thing that is not well (a Machine Offline, a disk nearly full, the T3 service stopped) stands out without him reading.

## Operating Context

- Two Machines today: a MacBook Air, and a Windows PC named Stormtrooper that runs Ubuntu under WSL with a T3 Code server. Designed for 1–6.
- Opened casually, often on a phone, between other things; sometimes left open on the laptop while an agent works. Live updates over server-sent events.
- Follows the system light/dark setting; no toggle.

## Capabilities and Constraints

- Data contract: `dashboard/API.md`. A Machine is Online when its latest report arrived less than 30 s ago. History is one point per minute, 24 h, with cpu, ram and fullest-disk percents.
- Terminology from `GLOSSARY.md`: Machine, Usage, Online, Offline, Last seen, History, VPN, Dashboard, Alert. Avoid: host, node, device, box, server (for a Machine); stats, metrics, load, health; up/down/on/off/running/asleep.
- Mostly display. The one action is connecting or disconnecting a Machine's VPNs (disconnecting asks first). Browser push Alerts (service worker) are a planned follow-up; the page must stay manifest- and service-worker-friendly.

## Product Principles

1. Calm when all is well. The page should look quiet when nothing needs attention.
2. Reserve alarm. Strong color only for genuinely bad states (e.g. a disk over 90 %); Offline reads clearly without shouting.
3. Big readable numbers over many small labels. No dense admin feel.
4. Readable at a glance on a phone first, comfortable on a laptop.

## Accessibility & Inclusion

State is never carried by color alone: Online/Offline and nearly-full are also said in words.
