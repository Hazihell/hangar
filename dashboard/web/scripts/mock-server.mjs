#!/usr/bin/env node
// Dev backend: the real Dashboard server (dashboard/server's `createDashboard`) running on fake Machines, so what you see in
// development is what ships. Everything API.md describes (Usage, History, Apps, Top Apps, VPN, Quit, Power, Updates, Alerts and
// the same-origin guard) is the real server's; only its edges are scripted, in scripts/dev-backend/:
//
//   fixtures.ts  the made-up Machines: PC and Mac Process lists, curves, noise
//   fleet.ts     their answers to the commands the server sends (`exec`, `local`, `mainPid`) and to push (`fetch`)
//   seed.ts      24 h of History and Top Apps, written by the real Usage module
//   index.ts     the server on a temporary database, plus a feeder that POSTs a report per Machine every MOCK_REPORT_MS
//
//   node scripts/mock-server.mjs [port] [--extra] [--calm]
//
// Nothing here reaches a real Machine, push service or the real database (~/.local/state/hangar/dashboard.db): commands never
// run, pushes are answered in-process, and the database is a temporary one deleted on exit.
//
// Port: argv, else MOCK_PORT, else HANGAR_DASHBOARD_PORT, else 4398.
// --extra (or MOCK_EXTRA=1) adds two Machines that exercise edge states: one that never reported and one with many drives and a
// hot CPU. Both list no Processes, so the page hides the Apps section.
// --calm (or MOCK_CALM=1) is the all-is-well case: both Machines Online, no drive nearly full.
//
// Machines: Stormtrooper (the PC) is Online, with D: nearly full. The MacBook Air is Offline, last seen ~2 h ago, unless --calm:
// then its VPNs and Quit take commands too (Offline, they answer 409). The Mac's History has a gap where it was asleep.
//
// VPN: commands take MOCK_VPN_MS (default 4 s) to show `connecting` and then the end state, through the Machine's next report, as
// on the real ones. Connecting "Office" (on the Mac) always fails, so the error state can be seen.
//
// Apps: each Machine has a list of fake Processes that every report lists (jittered each MOCK_REPORT_MS, default 10 s). The server
// builds the Apps view, including the PC's nested WSL App; an Offline Machine keeps its last ones.
//
// Minutes: Top Apps are recorded per History minute, from the Processes of the reports in it, and follow the minute's CPU: a spike
// is mostly WSL node and/or WSL claude (or Chrome / chrome-headless-shell) on the PC and Codex or Google Chrome on the Mac. A
// minute answers after MOCK_MINUTE_MS (default 250 ms) and T3's threads after MOCK_THREADS_MS (300 ms), so loading states show.
//
// Quit: policy and results are the real Quit module's (`gone`, `changed`, `protected`, `sent`, `failed`); the PC and Mac only answer
// as an operating system would. A sent Process exits ~1.5 s later and the next report no longer lists it. Demo cases:
//   - Stormtrooper WSL `node` pid 5121 (started "1234567", the biggest node) ignores a plain quit (SIGTERM): `sent`, yet it stays.
//     With force: true it goes. The T3 service's main process (pid 4802) is protected, as the real one is.
//   - Stormtrooper Windows `Code.exe` pid 14608 answers `failed` ("...can only be terminated forcefully (with /F option).")
//     without force; with force, `sent`.
//   - `{ "app": "Discord", "where"?: "wsl", "force": false }` quits an App by name.
//
// Power: only Stormtrooper has `power`. Sleep goes pending, then ~1.5 s later the PC goes to sleep with the Dashboard on it: every
// connection, the event stream included, is dropped and refused for MOCK_ASLEEP_MS (default 25 s); on wake pending clears and
// reports resume. Shut down is refused ("blocked by an app") after MOCK_POWER_FAIL_MS (default 8 s). MOCK_SHUTDOWN=ok makes Shut
// down take the PC (and the Dashboard) away for MOCK_ASLEEP_MS and bring it back fresh, as a reboot would.
//
// Updates: every Machine has a few out of date (checked 2 hours ago). On the PC, gh is blocked ("Run `hangar update` on the PC") and
// T3 has two running threads, read from a fake T3 database (MOCK_T3_THREADS=none for none, =null for unreadable). Each item takes
// MOCK_UPDATE_MS (default 4 s); then the Machine is checked again. Codex on the PC fails (unless MOCK_UPDATE_FAIL=0), ending the run
// with the error. Hangar on the PC restarts the Dashboard: every connection drops for MOCK_RESTART_MS (default 8 s), pending is lost,
// as on the real one, and GET /api/machines then names a new `build` (open pages reload for it; the first one is MOCK_BUILD, and
// the ids are hashes of the served index.html, as on the real one). Check now takes MOCK_CHECK_MS (default 1.5 s).
//
// Alerts: the real Alerts, with a real VAPID key made at start-up, subscriptions kept in the temporary database and pushes sent to
// a fake push service that takes them all (answers 201) without sending anything. With MOCK_ALERTS_TEST=502 it answers 403 to every
// push, so /api/alerts/test answers 502 and the page's error path can be seen.
//
// Same-origin guard: the real server's. Vite's dev proxy rewrites Host and Origin to match (vite.config.ts).

import { startDevBackend } from "./dev-backend/index.ts"

const args = process.argv.slice(2)
const env = process.env
const flag = (name, variable) => args.includes(`--${name}`) || env[variable] === "1"
const ms = (variable) => (env[variable] === undefined ? undefined : Number(env[variable]))
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

const backend = await startDevBackend({
  port: Number(args.find((a) => /^\d+$/.test(a)) ?? env.MOCK_PORT ?? env.HANGAR_DASHBOARD_PORT ?? 4398),
  extra: flag("extra", "MOCK_EXTRA"),
  calm: flag("calm", "MOCK_CALM"),
  reportMs: ms("MOCK_REPORT_MS"),
  build: env.MOCK_BUILD,
  shutdownOk: env.MOCK_SHUTDOWN === "ok",
  updateFails: env.MOCK_UPDATE_FAIL !== "0",
  t3Threads: env.MOCK_T3_THREADS === "none" || env.MOCK_T3_THREADS === "null" ? env.MOCK_T3_THREADS : "running",
  pushStatus: env.MOCK_ALERTS_TEST === "502" ? 403 : 201,
  timing: defined({ vpnMs: ms("MOCK_VPN_MS"), asleepMs: ms("MOCK_ASLEEP_MS"), powerFailMs: ms("MOCK_POWER_FAIL_MS"), updateMs: ms("MOCK_UPDATE_MS"), restartMs: ms("MOCK_RESTART_MS"), checkMs: ms("MOCK_CHECK_MS"), minuteMs: ms("MOCK_MINUTE_MS"), threadsMs: ms("MOCK_THREADS_MS") }),
})
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void backend.close().then(() => process.exit(0)))
