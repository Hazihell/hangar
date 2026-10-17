#!/usr/bin/env node
// Dev stand-in for dashboard/server per dashboard/API.md, with fake Usage,
// VPNs, Apps and Alerts. Serves GET /api/machines, GET /api/events,
// POST /api/machines/:id/vpns/:name, GET /api/machines/:id/minutes/:t,
// POST /api/machines/:id/quit, POST /api/machines/:id/power, the Updates
// endpoints and the /api/alerts/* endpoints. No dependencies.
//
//   node scripts/mock-server.mjs [port] [--extra] [--calm]
//
// Port: argv, else MOCK_PORT, else HANGAR_DASHBOARD_PORT, else 4398.
// --extra (or MOCK_EXTRA=1) adds two Machines that exercise edge states:
// one that never reported and one with many drives and a hot CPU. Both have
// `apps: null` (the page hides the Apps section).
// --calm (or MOCK_CALM=1) is the all-is-well case: both Machines Online, no
// drive nearly full.
//
// VPN commands take MOCK_VPN_MS (default 4 s); connecting "Office" always fails,
// so the error state can be seen. The MacBook is Offline unless --calm, so its
// VPNs only take commands with --calm.
//
// Apps: each Machine keeps a flat list of fake Processes and builds the App
// tree (incl. the PC's nested WSL App) on every view, so `apps` rides on
// GET /api/machines and on every `machine` event. Processes jitter on each
// report (MOCK_REPORT_MS, default 10 s); an Offline Machine keeps its last
// ones. The startup log lists some demo pids.
//
// Minutes: GET /api/machines/:id/minutes/:t answers after ~250 ms (so the
// loading state shows). The Top Apps are generated from the minute itself, so
// they are the same on every request, and follow the minute's History cpu: a
// spike is mostly WSL node and/or WSL claude (or Chrome / chrome-headless-shell)
// on the PC and Codex or Google Chrome on the Mac. Works for the Offline Mac too.
//
// Quit: POST /api/machines/:id/quit answers `gone` for an unknown pid, `changed`
// for a different `started`, `protected` for protected or not-own Processes, and
// otherwise `sent`; a sent Process leaves the model ~1.5 s later (the next
// report or GET no longer lists it). Demo cases:
//   - Stormtrooper WSL `node` pid 5121 (started "1234567", the biggest node)
//     ignores a plain quit: answers `sent` but stays forever. With force: true it
//     is `sent` and goes.
//   - Stormtrooper Windows `Code.exe` pid 14608 answers `failed` ("...can only be
//     terminated forcefully (with /F option).") without force; with force, `sent`.
//   - `{ "app": "Discord", "where"?: "wsl", "force": false }` quits an App by
//     name: every Process of it that may be quit (results carry started/where).
//   - The Mac needs --calm (Online), else 409. The mock never sends events for
//     removals by itself; the next report does.
//
// Power: only Stormtrooper has `power` (the Dashboard runs on it). Sleep goes
// pending, then ~1.5 s later the "server" goes to sleep with it: every
// connection, the event stream included, is dropped and refused for
// MOCK_ASLEEP_MS (default 25 s); then it wakes, pending clears and reports
// resume. Shut down is "blocked by an app": after MOCK_POWER_FAIL_MS (default
// 8 s) it clears pending and sets the server's error. MOCK_SHUTDOWN=ok makes
// Shut down go down like Sleep instead.
//
// Updates: every Machine has a few out of date (checked 2 hours ago). On the
// PC, gh is blocked ("Run `hangar update` on the PC") and T3 has two running
// threads (MOCK_T3_THREADS=none for none, =null for unreadable). Each item
// takes MOCK_UPDATE_MS (default 4 s); then the Machine is checked again.
// Codex on the PC fails (unless MOCK_UPDATE_FAIL=0), ending the run with the
// error. Hangar on the PC restarts "the server": every connection drops for
// MOCK_RESTART_MS (default 8 s), pending is lost, as on the real one, and
// GET /api/machines then names a new `build` (open pages reload for it).
// Check now takes 2 s.
//
// Like the real server, every mutating request (not /api/report) must look
// same-origin: a Host of 127.0.0.1/localhost on this port, an Origin (if any)
// for that host, and Sec-Fetch-Site (if any) same-origin or none; else 403.
// Vite's dev proxy rewrites Host and Origin to match (vite.config.ts).
//
// Alerts: GET /api/alerts/key returns a real P-256 public key (base64url,
// uncompressed point) made at startup, usable with pushManager.subscribe.
// Subscriptions live in memory; /api/alerts/test sends nothing. With
// MOCK_ALERTS_TEST=502 it answers 502 "push service answered 403" (after the
// 404 check) so the page's error path can be seen.

import { createServer } from "node:http"
import { generateKeyPairSync } from "node:crypto"

const args = process.argv.slice(2)
const port = Number(
  args.find((a) => /^\d+$/.test(a)) ??
    process.env.MOCK_PORT ??
    process.env.HANGAR_DASHBOARD_PORT ??
    4398
)
const extra = args.includes("--extra") || process.env.MOCK_EXTRA === "1"
const calm = args.includes("--calm") || process.env.MOCK_CALM === "1"
const vpnMs = Number(process.env.MOCK_VPN_MS ?? 4_000)

const GB = 1024 ** 3
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const ONLINE_WINDOW = 30_000
const REPORT_EVERY = 10_000

const round1 = (n) => Math.round(n * 10) / 10
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const minuteStart = (ms) => Math.floor(ms / MINUTE) * MINUTE
const iso = (ms) => new Date(ms).toISOString()
const vpn = (name, status) => ({ name, status, pending: null, error: null })

// Deterministic noise so reloads show the same History.
function noise(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// A working-day CPU curve: quiet overnight, busy bursts while agents run.
function cpuAt(ms, rand, base, busy) {
  const hour = new Date(ms).getHours() + new Date(ms).getMinutes() / 60
  const day = Math.max(0, Math.sin(((hour - 7) / 16) * Math.PI))
  const burst = rand() < 0.08 * day ? 25 + rand() * 45 : 0
  return clamp(base + busy * day + burst + (rand() - 0.5) * 6, 0.5, 100)
}

// CPU Temperature, °C: an idle floor plus what the load adds, and a little noise.
function tempOf(cpu, idle, rand, gain = 0.55) {
  return clamp(idle + cpu * gain + (rand() - 0.5) * 2, 25, 110)
}

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const MB = 1024 ** 2

// --- Processes and Apps ---------------------------------------------------
// A spec makes `n` Processes of one App: `share` is the App's fraction of the
// Machine's CPU, `ram` its total bytes. pid_i = pid0 + i * step. `over` tweaks
// single Processes by index.
const PC_SPECS = [
  { app: "chrome", name: "chrome.exe", n: 14, share: 0.07, ram: 2.5 * GB, pid0: 9200 },
  { app: "Code", name: "Code.exe", n: 8, share: 0.06, ram: 1.3 * GB, pid0: 14600, over: { 2: { needsForce: true } } },
  { app: "WindowsTerminal", name: "WindowsTerminal.exe", n: 1, share: 0.01, ram: 95 * MB, pid0: 7320 },
  { app: "Discord", name: "Discord.exe", n: 5, share: 0.02, ram: 0.7 * GB, pid0: 11040 },
  { app: "Spotify", name: "Spotify.exe", n: 4, share: 0.01, ram: 0.45 * GB, pid0: 12880 },
  { app: "explorer", name: "explorer.exe", n: 1, share: 0.005, ram: 150 * MB, pid0: 5812, protected: true },
  { app: "dwm", name: "dwm.exe", n: 1, share: 0.01, ram: 110 * MB, pid0: 1296, protected: true },
  { app: "MsMpEng", name: "MsMpEng.exe", n: 1, share: 0.02, ram: 250 * MB, pid0: 3104, own: false },
  { app: "svchost", name: "svchost.exe", n: 40, share: 0.04, ram: 0.55 * GB, pid0: 1000, step: 28, own: false },
  { app: "OneDrive", name: "OneDrive.exe", n: 1, share: 0.003, ram: 140 * MB, pid0: 6644 },
  // Inside WSL.
  {
    app: "node", name: "node", n: 9, share: 0.45, ram: 0.9 * GB, pid0: 5300, step: 19, wsl: true,
    over: {
      0: { pid: 5121, started: "1234567", ram: 483_000_000, w: 3, ignores: true },
      1: { pid: 4802, ram: 130 * MB, w: 0.1, protected: true }, // the T3 server's main process
    },
  },
  { app: "claude", name: "claude", n: 2, share: 0.12, ram: 0.55 * GB, pid0: 5601, step: 41, wsl: true },
  { app: "codex", name: "codex", n: 1, share: 0.04, ram: 0.2 * GB, pid0: 5890, wsl: true },
  { app: "chrome-headless-shell", name: "chrome-headless-shell", n: 4, share: 0.06, ram: 0.6 * GB, pid0: 6310, step: 9, wsl: true },
  { app: "bash", name: "bash", n: 6, share: 0.01, ram: 40 * MB, pid0: 5004, step: 37, wsl: true },
  { app: "python3", name: "python3", n: 1, share: 0.01, ram: 60 * MB, pid0: 6020, wsl: true },
  { app: "sshd", name: "sshd", n: 1, share: 0.001, ram: 8 * MB, pid0: 705, wsl: true, protected: true },
  { app: "systemd", name: "systemd", n: 1, share: 0.002, ram: 18 * MB, pid0: 1, wsl: true, protected: true },
  { app: "tailscaled", name: "tailscaled", n: 1, share: 0.005, ram: 70 * MB, pid0: 612, wsl: true, protected: true },
]
const PC_SPIKERS = [
  { name: "node", where: "wsl", weight: 5 },
  { name: "claude", where: "wsl", weight: 3 },
  { name: "chrome-headless-shell", where: "wsl", weight: 1.5 },
  { name: "chrome", weight: 1.5 },
]

const MAC_SPECS = [
  { app: "Codex", names: ["Codex", "Codex Helper (Renderer)", "Codex Helper (GPU)"], n: 3, share: 0.3, ram: 1.6 * GB, pid0: 8211, step: 3 },
  { app: "Slack", names: ["Slack", "Slack Helper (Renderer)", "Slack Helper (GPU)", "Slack Helper"], n: 4, share: 0.05, ram: 1.0 * GB, pid0: 7120, step: 5 },
  {
    app: "Google Chrome",
    names: ["Google Chrome", "Google Chrome Helper (GPU)", "Google Chrome Helper (Renderer)"],
    n: 12, share: 0.25, ram: 2.2 * GB, pid0: 9012, step: 17,
  },
  { app: "T3 Code", names: ["T3 Code", "T3 Code Helper (Renderer)", "T3 Code Helper (GPU)"], n: 3, share: 0.06, ram: 0.9 * GB, pid0: 7650, step: 4 },
  { app: "WindowServer", name: "WindowServer", n: 1, share: 0.06, ram: 350 * MB, pid0: 412, protected: true, own: false },
  { app: "Finder", name: "Finder", n: 1, share: 0.002, ram: 140 * MB, pid0: 640, protected: true },
  { app: "Dock", name: "Dock", n: 1, share: 0.005, ram: 60 * MB, pid0: 598, protected: true },
  { app: "Tailscale", name: "Tailscale", n: 1, share: 0.003, ram: 90 * MB, pid0: 702, protected: true },
  { app: "kernel_task", name: "kernel_task", n: 1, share: 0.08, ram: 300 * MB, pid0: 0, own: false },
  { app: "mds_stores", name: "mds_stores", n: 1, share: 0.04, ram: 220 * MB, pid0: 338, own: false },
  { app: "Terminal", name: "Terminal", n: 1, share: 0.01, ram: 120 * MB, pid0: 9930 },
  { app: "node", name: "node", n: 3, share: 0.08, ram: 0.6 * GB, pid0: 10240, step: 33 },
]
const MAC_SPIKERS = [
  { name: "Codex", weight: 3 },
  { name: "Google Chrome", weight: 2 },
]

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
// An opaque start token, shaped like the real one for each platform.
function startedToken(space, pid) {
  if (space === "windows") return String(133_900_000_000_000_000n + BigInt(pid) * 90_000_000_000n)
  if (space === "wsl") return String(4_000 + pid * 131)
  const d = new Date(Date.UTC(2026, 9, 1, 6, 0, 0) + pid * 71_000)
  const p2 = (n) => String(n).padStart(2, "0")
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

function buildProcs(specs, os, rand) {
  const procs = []
  const used = new Set()
  for (const s of specs) {
    const ws = [], rs = []
    for (let i = 0; i < s.n; i++) {
      const o = s.over?.[i]
      ws.push(o?.w ?? (i === 0 ? 1 : 0.05 + rand() * 0.5))
      rs.push(0.3 + rand())
    }
    const wSum = sum(ws)
    const fixed = sum(Array.from({ length: s.n }, (_, i) => s.over?.[i]?.ram ?? 0))
    const freeSum = sum(rs.filter((_, i) => s.over?.[i]?.ram === undefined))
    for (let i = 0; i < s.n; i++) {
      const o = s.over?.[i] ?? {}
      const pid = o.pid ?? s.pid0 + i * (s.step ?? 4)
      const key = `${s.wsl ? "wsl" : "host"}:${pid}`
      if (used.has(key)) throw new Error(`duplicate pid ${key}`)
      used.add(key)
      const space = s.wsl ? "wsl" : os
      const ram = o.ram ?? Math.round(((s.ram - fixed) * rs[i]) / freeSum)
      procs.push({
        pid,
        name: o.name ?? (s.names ? s.names[Math.min(i, s.names.length - 1)] : s.name),
        app: s.app,
        share: (s.share * ws[i]) / wSum,
        cpu: 0,
        ramBase: ram,
        ram,
        started: o.started ?? startedToken(space, pid),
        own: s.own ?? true,
        protected: o.protected ?? (s.protected === true),
        ...(s.wsl ? { where: "wsl" } : {}),
        ...(o.needsForce ? { needsForce: true } : {}),
        ...(o.ignores ? { ignores: true } : {}),
      })
    }
  }
  return procs
}

// Gives a Machine its Processes: m.procs stays the source of truth.
function attachApps(m, specs, spikers, seed) {
  m.specs = specs
  m.spikers = spikers
  m.prand = noise(seed)
  m.procs = buildProcs(specs, m.os, m.prand)
  m.vmmemRam = specs.some((s) => s.wsl) ? 7 * GB : 0
  refreshProcs(m, m.usage.cpu, m.lastSeenMs)
}

// A report's worth of jitter: each Process takes its share of the Machine's CPU.
function refreshProcs(m, cpu, at) {
  for (const p of m.procs) {
    p.cpu = round1(cpu * p.share * (0.75 + 0.5 * m.prand()))
    p.ram = Math.round(p.ramBase * (0.97 + 0.06 * m.prand()))
  }
  if (m.vmmemRam) m.vmmemRam = Math.round(7 * GB * (0.99 + 0.02 * m.prand()))
  m.appsAtMs = at
}

const canQuit = (p) => p.own && !p.protected

function groupApps(procs) {
  const by = new Map()
  for (const p of procs) {
    if (!by.has(p.app)) by.set(p.app, [])
    by.get(p.app).push(p)
  }
  return [...by].map(([name, ps]) => ({
    name,
    cpu: round1(sum(ps.map((p) => p.cpu))),
    ram: sum(ps.map((p) => p.ram)),
    count: ps.length,
    quit: ps.some(canQuit),
    processes: [...ps]
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 20)
      .map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, ram: p.ram, started: p.started, quit: canQuit(p) })),
  }))
}

// The 10 Apps using the most CPU and the 10 using the most RAM, by CPU.
function topUnion(apps) {
  const byCpu = [...apps].sort((a, b) => b.cpu - a.cpu)
  const byRam = [...apps].sort((a, b) => b.ram - a.ram)
  const keep = new Set([...byCpu.slice(0, 10), ...byRam.slice(0, 10)])
  return byCpu.filter((a) => keep.has(a))
}

function appsView(m) {
  if (!m.procs) return null
  const host = groupApps(m.procs.filter((p) => !p.where))
  const inner = groupApps(m.procs.filter((p) => p.where === "wsl"))
  if (inner.length) {
    host.push({
      name: "WSL",
      cpu: round1(sum(inner.map((a) => a.cpu)) * 1.05),
      ram: m.vmmemRam,
      count: sum(inner.map((a) => a.count)),
      quit: false,
      processes: [],
      apps: topUnion(inner),
    })
  }
  return { at: iso(m.appsAtMs), list: topUnion(host) }
}

// The Top Apps of one History minute, made from the minute alone so repeated
// requests agree, and following the minute's cpu: a spike is mostly one or two Apps.
function minuteApps(m, point) {
  const rand = noise(hash(`${m.id}|${point.t}`))
  const roster = m.specs.map((s) => ({ name: s.app, where: s.wsl ? "wsl" : undefined, share: s.share, ram: s.ram }))
  const ws = roster.map((r) => r.share * (0.5 + rand()))
  const boost = clamp((point.cpu - 12) / 40, 0, 1)
  const dominant = new Set()
  const pick = (exclude) => {
    const pool = m.spikers.filter((s) => !exclude.has(s))
    let x = rand() * sum(pool.map((s) => s.weight))
    for (const s of pool) if ((x -= s.weight) < 0) return s
    return pool[0]
  }
  const first = pick(new Set())
  dominant.add(first)
  if (rand() < 0.4) dominant.add(pick(dominant))
  const base = sum(ws)
  roster.forEach((r, i) => {
    if ([...dominant].some((d) => d.name === r.name && d.where === r.where)) ws[i] += (base * boost * 9) / dominant.size
  })
  const total = sum(ws)
  const out = roster.map((r, i) => {
    const hot = [...dominant].some((d) => d.name === r.name && d.where === r.where)
    const ramRand = noise(hash(`${r.name}|${r.where}|${Math.floor(Date.parse(point.t) / (15 * MINUTE))}`))()
    return {
      name: r.name,
      ...(r.where ? { where: r.where } : {}),
      cpu: round1((point.cpu * ws[i]) / total * (0.97 + 0.06 * rand())),
      ram: Math.round(r.ram * (0.92 + 0.16 * ramRand) * (hot ? 1 + 0.6 * boost : 1)),
    }
  })
  const keep = new Set([
    ...[...out].sort((a, b) => b.cpu - a.cpu).slice(0, 5),
    ...[...out].sort((a, b) => b.ram - a.ram).slice(0, 5),
  ])
  return out.filter((a) => keep.has(a)).sort((a, b) => b.cpu - a.cpu)
}

function makeMachines(now) {
  const machines = []

  // Stormtrooper: Online, two drives, D: nearly full, T3 running.
  {
    const rand = noise(7)
    const ramTotal = 32 * GB
    const disks = [
      { name: "C:", used: 588 * GB, total: 930 * GB },
      { name: "D:", used: (calm ? 1320 : 1732) * GB, total: 1863 * GB },
    ]
    const history = []
    let ramPct = 34
    for (let t = minuteStart(now - DAY) + MINUTE; t <= minuteStart(now); t += MINUTE) {
      if (rand() < 0.004) continue // a missed minute now and then
      const cpu = cpuAt(t, rand, 4, 22)
      ramPct = clamp(ramPct + (rand() - 0.5) * 1.6 + (cpu > 40 ? 0.5 : -0.1), 28, 72)
      const progress = (t - (now - DAY)) / DAY
      const diskD = ((calm ? 1290 : 1690) + 30 * progress) / 1863 * 100
      history.push({ t: iso(t), cpu: round1(cpu), ram: round1(ramPct), disk: round1(diskD), temp: round1(tempOf(cpu, 38, rand)) })
    }
    const last = history.at(-1)
    machines.push({
      id: "stormtrooper",
      name: "Stormtrooper",
      os: "windows",
      lastSeenMs: now - 4_000,
      rand,
      ramPct: last.ram,
      usage: {
        at: iso(now - 4_000),
        cpu: last.cpu,
        ram: { used: Math.round((last.ram / 100) * ramTotal), total: ramTotal },
        disks,
        services: { t3: true },
        temps: { cpu: last.temp, gpu: 41 },
      },
      tempLimits: { high: 75, hot: 85 },
      tempIdle: 38,
      vpns: [vpn("Steeprock", "connected")],
      power: { actions: ["sleep", "shutdown"], pending: null, error: null },
      history,
      live: true,
    })
    attachApps(machines.at(-1), PC_SPECS, PC_SPIKERS, 101)
  }

  // MacBook Air: Offline, last seen ~2 h ago.
  {
    const rand = noise(11)
    const lastSeenMs = calm ? now - 6_000 : now - (2 * 60 + 7) * MINUTE
    const ramTotal = 16 * GB
    const history = []
    let ramPct = 58
    for (let t = minuteStart(now - DAY) + MINUTE; t <= minuteStart(lastSeenMs); t += MINUTE) {
      if (t > now - 20 * 60 * MINUTE && t < now - 13 * 60 * MINUTE) continue // asleep: no reports
      const cpu = cpuAt(t, rand, 6, 14)
      ramPct = clamp(ramPct + (rand() - 0.5) * 2, 48, 86)
      history.push({ t: iso(t), cpu: round1(cpu), ram: round1(ramPct), disk: 61.2, temp: round1(tempOf(cpu, 46, rand, 0.9)) })
    }
    const last = history.at(-1)
    machines.push({
      id: "rogers-macbook-air",
      name: "MacBook Air",
      os: "macos",
      lastSeenMs,
      usage: {
        at: iso(lastSeenMs),
        cpu: last.cpu,
        ram: { used: Math.round((last.ram / 100) * ramTotal), total: ramTotal },
        disks: [{ name: "Macintosh HD", used: Math.round(0.612 * 460.4 * GB), total: Math.round(460.4 * GB) }],
        temps: { cpu: last.temp },
      },
      tempLimits: { high: 95, hot: 105 },
      tempIdle: 46,
      vpns: [vpn("Steeprock", "connected"), vpn("Office", "disconnected")],
      history,
      rand,
      ramPct: last.ram,
      live: calm,
    })
    attachApps(machines.at(-1), MAC_SPECS, MAC_SPIKERS, 202)
  }

  if (extra) {
    machines.push({
      id: "lab-mini",
      name: "Lab Mini",
      os: "linux",
      lastSeenMs: null,
      usage: null,
      vpns: [],
      history: [],
      live: false,
    })

    const rand = noise(23)
    const history = []
    for (let t = minuteStart(now - DAY) + MINUTE; t <= minuteStart(now); t += MINUTE) {
      history.push({ t: iso(t), cpu: round1(cpuAt(t, rand, 10, 30)), ram: round1(80 + rand() * 6), disk: 87.5, temp: round1(80 + rand() * 6) })
    }
    machines.push({
      id: "render-box",
      name: "Render Station",
      os: "windows",
      lastSeenMs: now - 3_000,
      rand,
      ramPct: 84,
      usage: {
        at: iso(now - 3_000),
        cpu: history.at(-1).cpu,
        ram: { used: Math.round(0.84 * 64 * GB), total: 64 * GB },
        disks: [
          { name: "C:", used: 402 * GB, total: 930 * GB },
          { name: "D:", used: 3260 * GB, total: 3726 * GB },
          { name: "E:", used: 120 * GB, total: 1863 * GB },
          { name: "F:", used: 1490 * GB, total: 1863 * GB },
          { name: "G:", used: 12 * GB, total: 238 * GB },
        ],
        services: { t3: false },
        temps: { cpu: 87 },
      },
      tempLimits: { high: 75, hot: 85 },
      tempIdle: 80,
      vpns: [],
      history,
      live: true,
    })
  }

  return machines
}

const machines = makeMachines(Date.now())

// Updates, as `hangar outdated --json` would say.
function upd(id, name, current, latest, extra = {}) {
  return { id, name, current, latest, available: latest !== null && current !== latest, blocked: null, ...extra }
}
for (const m of machines) {
  if (m.id === "stormtrooper") {
    m.updates = {
      checkedAt: iso(Date.now() - 2 * 3600_000),
      checking: false,
      items: [
        upd("t3", "T3 Code", "0.0.27", "0.0.29"),
        upd("claude", "Claude Code", "2.1.302", "2.1.310"),
        upd("codex", "Codex", "0.48.0", "0.50.1"),
        upd("gh", "GitHub CLI", "2.81.0", "2.82.1", { blocked: "Run `hangar update` on the PC" }),
        upd("tea", "Gitea CLI", "0.11.1", "0.11.1"),
        upd("hangar", "Hangar", "2fc68d8", "7a1c9e0", { behind: 2 }),
      ],
      pending: null,
      error: null,
    }
  } else if (m.id === "rogers-macbook-air") {
    m.updates = {
      checkedAt: iso(Date.now() - 2 * 3600_000 - 600_000),
      checking: false,
      items: [
        upd("claude", "Claude Code", "2.1.305", "2.1.310"),
        upd("codex", "Codex", "0.50.1", "0.50.1"),
        upd("gh", "GitHub CLI", "2.82.1", "2.82.1"),
        upd("tea", "Gitea CLI", "0.10.1", "0.11.1"),
        upd("hangar", "Hangar", "2fc68d8", "7a1c9e0", { behind: 2 }),
      ],
      pending: null,
      error: null,
    }
  } else {
    m.updates = { checkedAt: null, checking: false, items: [], pending: null, error: null }
  }
}

function view(m, now) {
  return {
    id: m.id,
    name: m.name,
    os: m.os,
    online: isOnline(m, now),
    lastSeen: m.lastSeenMs === null ? null : iso(m.lastSeenMs),
    usage: m.usage,
    tempLimits: m.tempLimits ?? null,
    vpns: m.vpns.map((v) => ({ ...v })),
    apps: appsView(m),
    ...(m.power ? { power: { ...m.power } } : {}),
    updates: { ...m.updates, items: m.updates.items.map((u) => ({ ...u })) },
  }
}

// One report from a live Machine: new Usage, folded into the current minute.
function report(m, now) {
  const cpu = round1(clamp(m.usage.cpu * 0.6 + cpuAt(now, m.rand, 4, 22) * 0.4, 0.5, 100))
  m.ramPct = clamp(m.ramPct + (m.rand() - 0.5) * 1.2, 20, 95)
  const ramTotal = m.usage.ram.total
  const temp = m.usage.temps?.cpu === undefined ? undefined : round1(clamp(m.usage.temps.cpu * 0.7 + tempOf(cpu, m.tempIdle, m.rand) * 0.3, 25, 110))
  m.usage = {
    ...m.usage,
    at: iso(now),
    cpu,
    ram: { used: Math.round((m.ramPct / 100) * ramTotal), total: ramTotal },
    ...(m.usage.temps ? { temps: { ...m.usage.temps, ...(temp === undefined ? {} : { cpu: temp }) } } : {}),
  }
  m.lastSeenMs = now
  if (m.procs) refreshProcs(m, cpu, now)

  const t = iso(minuteStart(now))
  const fullest = Math.max(...m.usage.disks.map((d) => (d.used / d.total) * 100))
  const last = m.history.at(-1)
  if (last && last.t === t) {
    last.n = (last.n ?? 1) + 1
    last.cpu = round1(last.cpu + (cpu - last.cpu) / last.n)
    last.ram = round1(last.ram + (m.ramPct - last.ram) / last.n)
    last.disk = round1(fullest)
    if (temp !== undefined) last.temp = round1(last.temp == null ? temp : last.temp + (temp - last.temp) / last.n)
  } else {
    m.history.push({ t, cpu, ram: round1(m.ramPct), disk: round1(fullest), temp: temp ?? null, n: 1 })
  }
  while (m.history.length && Date.parse(m.history[0].t) < now - DAY) m.history.shift()
  const { n: _n, ...minute } = m.history.at(-1)
  return { ...view(m, now), minute }
}

// --- Alerts ---------------------------------------------------------------
// A real P-256 key, so the browser accepts it as applicationServerKey.
const vapid = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const vapidJwk = vapid.publicKey.export({ format: "jwk" })
const alertsKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(vapidJwk.x, "base64url"),
  Buffer.from(vapidJwk.y, "base64url"),
]).toString("base64url")
const subscriptions = new Map()

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i

function send(res, status, text = "", type = "text/plain") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(text)
}
const sendJson = (res, status, body) => send(res, status, JSON.stringify(body), "application/json")

// Reads a JSON body; answers 400 itself when it is malformed (or, with
// requireJson, when the Content-Type isn't JSON, as a CSRF guard).
function readJson(req, res, requireJson, handler) {
  if (requireJson && !JSON_TYPE.test(req.headers["content-type"] ?? "")) {
    send(res, 400)
    req.resume()
    return
  }
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return send(res, 400)
    }
    handler(body)
  })
}

const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x)

// POST /api/machines/:id/quit
const GONE_AFTER_MS = 1_500
function quit(m, targets, force) {
  const removed = new Set()
  // Every result names the Process it was checked against, in target order.
  const results = targets.map((t) => {
    const id = { pid: t.pid, started: t.started, ...(t.where ? { where: t.where } : {}) }
    const p = m.procs.find((x) => x.pid === t.pid && x.where === t.where)
    if (!p) return { ...id, result: "gone" }
    if (p.started !== t.started) return { ...id, result: "changed" }
    if (!canQuit(p)) return { ...id, result: "protected" }
    if (p.needsForce && !force) {
      return {
        ...id,
        result: "failed",
        message: `ERROR: The process with PID ${p.pid} could not be terminated. Reason: This process can only be terminated forcefully (with /F option).`,
      }
    }
    if (!(p.ignores && !force)) removed.add(p)
    return { ...id, result: "sent" }
  })
  setTimeout(() => {
    m.procs = m.procs.filter((p) => !removed.has(p))
  }, GONE_AFTER_MS)
  console.log(
    `quit ${m.id}: ${targets.map((t) => `${t.where === "wsl" ? "wsl:" : ""}${t.pid}`).join(",")}${force ? " (force)" : ""} -> ${results.map((r) => r.result).join(",")}`
  )
  return results
}

const clients = new Set()

function broadcast(machine) {
  const frame = `event: machine\ndata: ${JSON.stringify(machine)}\n\n`
  for (const res of clients) res.write(frame)
}

const isOnline = (m, now) => m.lastSeenMs !== null && now - m.lastSeenMs < ONLINE_WINDOW

// A VPN command, as the server runs one: pending at once, the operating system
// reporting the transition a moment later, then done (or failed).
function runVpnCommand(m, v, action) {
  v.pending = { action, since: iso(Date.now()) }
  v.error = null
  broadcast({ ...view(m, Date.now()), minute: null })

  setTimeout(() => {
    v.status = action === "connect" ? "connecting" : "disconnecting"
    broadcast({ ...view(m, Date.now()), minute: null })
  }, Math.min(1_500, vpnMs / 2))

  setTimeout(() => {
    if (action === "connect" && v.name === "Office") {
      v.status = "disconnected"
      v.error = { message: "L2TP: incorrect user shared secret found.", at: iso(Date.now()) }
    } else {
      v.status = action === "connect" ? "connected" : "disconnected"
    }
    v.pending = null
    broadcast({ ...view(m, Date.now()), minute: null })
  }, vpnMs)
}

// Power: asleep, the mock answers nothing at all, as if the PC were off.
const asleepMs = Number(process.env.MOCK_ASLEEP_MS ?? 25_000)
const powerFailMs = Number(process.env.MOCK_POWER_FAIL_MS ?? 8_000)
let asleep = false
const sockets = new Set()

function runPowerCommand(m, action) {
  m.power.pending = { action, since: iso(Date.now()) }
  m.power.error = null
  broadcast({ ...view(m, Date.now()), minute: null })
  if (action === "shutdown" && process.env.MOCK_SHUTDOWN !== "ok") {
    setTimeout(() => {
      m.power.pending = null
      m.power.error = { message: `${m.name} didn't shut down — an app may have blocked it`, at: iso(Date.now()) }
      broadcast({ ...view(m, Date.now()), minute: null })
    }, powerFailMs)
    return
  }
  setTimeout(() => {
    asleep = true
    console.log(`power: ${m.id} ${action} -> down for ${asleepMs / 1000} s`)
    for (const socket of sockets) socket.destroy()
    clients.clear()
    setTimeout(() => {
      asleep = false
      m.power.pending = null
      m.lastSeenMs = Date.now()
      broadcast({ ...view(m, Date.now()), minute: null })
      console.log(`power: ${m.id} is back`)
    }, asleepMs)
  }, 1_500)
}

// Updates.
const updateMs = Number(process.env.MOCK_UPDATE_MS ?? 4_000)
// The Dashboard build GET /api/machines names; a Hangar update on the PC changes it.
let build = process.env.MOCK_BUILD ?? "2fc68d8"
const restartMs = Number(process.env.MOCK_RESTART_MS ?? 8_000)
const T3_THREADS = [
  { title: "Fix the flaky reporter test on the Mac", status: "running" },
  { title: "Dashboard: Updates row and confirmations", status: "waiting" },
]

function recheck(m) {
  m.updates.checking = true
  broadcast({ ...view(m, Date.now()), minute: null })
  setTimeout(() => {
    m.updates.checking = false
    m.updates.checkedAt = iso(Date.now())
    broadcast({ ...view(m, Date.now()), minute: null })
  }, 1_500)
}

function runUpdate(m, ids) {
  m.updates.pending = { items: ids, since: iso(Date.now()) }
  m.updates.error = null
  broadcast({ ...view(m, Date.now()), minute: null })
  const step = (i) => {
    if (i === ids.length) {
      m.updates.pending = null
      console.log(`updates: ${m.id} done`)
      return recheck(m)
    }
    setTimeout(() => {
      const item = m.updates.items.find((u) => u.id === ids[i])
      if (item.id === "codex" && m.id === "stormtrooper" && process.env.MOCK_UPDATE_FAIL !== "0") {
        m.updates.pending = null
        m.updates.error = { message: "npm error EACCES: permission denied, rename '/usr/lib/node_modules/@openai/codex'", at: iso(Date.now()) }
        console.log(`updates: ${m.id} codex failed`)
        return recheck(m)
      }
      if (item.id === "hangar" && m.os === "windows") {
        // Restarts the Dashboard: everything drops, and pending goes with it.
        asleep = true
        console.log(`updates: ${m.id} hangar -> restarting for ${restartMs / 1000} s`)
        for (const socket of sockets) socket.destroy()
        clients.clear()
        setTimeout(() => {
          Object.assign(item, { current: item.latest, available: false })
          delete item.behind
          build = item.latest
          m.updates.pending = null
          m.updates.checkedAt = iso(Date.now())
          m.lastSeenMs = Date.now()
          asleep = false
          console.log(`updates: ${m.id} back after the restart`)
        }, restartMs)
        return
      }
      Object.assign(item, { current: item.latest, available: false })
      delete item.behind
      broadcast({ ...view(m, Date.now()), minute: null })
      step(i + 1)
    }, updateMs)
  }
  step(0)
}

setInterval(() => {
  if (asleep) return
  const now = Date.now()
  for (const m of machines) if (m.live) broadcast(report(m, now))
}, Number(process.env.MOCK_REPORT_MS ?? REPORT_EVERY))

// The real server's same-origin guard for mutating requests.
function crossOrigin(req) {
  const host = req.headers.host ?? ""
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return true
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return true
    } catch {
      return true
    }
  }
  const site = req.headers["sec-fetch-site"]
  return site !== undefined && site !== "same-origin" && site !== "none"
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (asleep) {
    req.socket.destroy()
    return
  }

  if (req.method !== "GET" && url.pathname !== "/api/report" && crossOrigin(req)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Not from the Dashboard's origin.\n")
    req.resume()
    return
  }

  if (req.method === "GET" && url.pathname === "/api/machines") {
    const now = Date.now()
    const body = {
      now: iso(now),
      build,
      machines: machines.map((m) => ({
        ...view(m, now),
        history: m.history.map(({ n: _n, ...p }) => p),
      })),
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify(body))
    return
  }

  const vpnPath = url.pathname.match(/^\/api\/machines\/([^/]+)\/vpns\/([^/]+)$/)
  if (req.method === "POST" && vpnPath) {
    // Like the real server: the body must be declared JSON.
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      res.writeHead(400).end()
      req.resume()
      return
    }
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const reply = (status, text = "") => {
        res.writeHead(status, { "content-type": "text/plain" })
        res.end(text)
      }
      let action
      try {
        action = JSON.parse(body)?.action
      } catch {
        return reply(400)
      }
      if (action !== "connect" && action !== "disconnect") return reply(400)
      const m = machines.find((x) => x.id === decodeURIComponent(vpnPath[1]))
      const v = m?.vpns.find((x) => x.name === decodeURIComponent(vpnPath[2]))
      if (!m || !v) return reply(404)
      if (!isOnline(m, Date.now()) || v.pending) return reply(409)
      runVpnCommand(m, v, action)
      reply(202)
    })
    return
  }

  const powerPath = url.pathname.match(/^\/api\/machines\/([^/]+)\/power$/)
  if (req.method === "POST" && powerPath) {
    readJson(req, res, true, (body) => {
      const action = isObject(body) ? body.action : undefined
      if (action !== "sleep" && action !== "shutdown") return send(res, 400)
      const m = machines.find((x) => x.id === decodeURIComponent(powerPath[1]))
      if (!m?.power) return send(res, 404)
      if (!isOnline(m, Date.now()) || m.power.pending) return send(res, 409)
      runPowerCommand(m, action)
      sendJson(res, 202, m.power)
    })
    return
  }

  const updatesPath = url.pathname.match(/^\/api\/machines\/([^/]+)\/updates(\/check)?$/)
  if (req.method === "POST" && updatesPath) {
    readJson(req, res, true, (body) => {
      const m = machines.find((x) => x.id === decodeURIComponent(updatesPath[1]))
      if (!m) return send(res, 404)
      if (updatesPath[2]) {
        if (!isOnline(m, Date.now()) || m.updates.checking) return send(res, 409)
        recheck(m)
        return send(res, 202)
      }
      const ids = isObject(body) ? body.items : undefined
      const known = new Set(m.updates.items.map((u) => u.id))
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
        return send(res, 400)
      }
      if (!isOnline(m, Date.now()) || m.updates.pending) return send(res, 409)
      if (ids.some((id) => m.updates.items.find((u) => u.id === id).blocked)) return send(res, 409)
      console.log(`updates: ${m.id} ${ids.join(",")}`)
      runUpdate(m, ids)
      sendJson(res, 202, view(m, Date.now()).updates)
    })
    return
  }

  const threadsPath = url.pathname.match(/^\/api\/machines\/([^/]+)\/t3-threads$/)
  if (req.method === "GET" && threadsPath) {
    const m = machines.find((x) => x.id === decodeURIComponent(threadsPath[1]))
    if (!m?.updates.items.some((u) => u.id === "t3")) return send(res, 404)
    const mode = process.env.MOCK_T3_THREADS
    const threads = mode === "null" ? null : mode === "none" ? [] : T3_THREADS
    setTimeout(() => sendJson(res, 200, { threads }), 300)
    return
  }

  const minutePath = url.pathname.match(/^\/api\/machines\/([^/]+)\/minutes\/([^/]+)$/)
  if (req.method === "GET" && minutePath) {
    let id, t
    try {
      id = decodeURIComponent(minutePath[1])
      t = decodeURIComponent(minutePath[2])
    } catch {
      return send(res, 404)
    }
    const m = machines.find((x) => x.id === id)
    const point = m?.history.find((p) => p.t === t)
    if (!m?.specs || !point) return send(res, 404)
    setTimeout(() => sendJson(res, 200, { t, apps: minuteApps(m, point) }), 250)
    return
  }

  const quitPath = url.pathname.match(/^\/api\/machines\/([^/]+)\/quit$/)
  if (req.method === "POST" && quitPath) {
    readJson(req, res, true, (body) => {
      const { targets: given, app, where, force } = isObject(body) ? body : {}
      const m0 = machines.find((x) => x.id === decodeURIComponent(quitPath[1]))
      if (typeof app === "string" && given === undefined) {
        // An App by name: all of its Processes that may be quit.
        if ((where !== undefined && where !== "wsl") || typeof force !== "boolean") return send(res, 400)
        if (!m0?.procs) return send(res, 404)
        if (!isOnline(m0, Date.now())) return send(res, 409)
        const procs = m0.procs.filter((p) => p.app === app && p.where === where && canQuit(p))
        const targets = procs.map((p) => ({ pid: p.pid, started: p.started, ...(p.where ? { where: p.where } : {}) }))
        const results = quit(m0, targets, force)
        return sendJson(res, 200, { results })
      }
      const targets = given
      const valid =
        Array.isArray(targets) &&
        targets.length >= 1 &&
        targets.length <= 200 &&
        targets.every(
          (t) =>
            isObject(t) &&
            Number.isInteger(t.pid) &&
            typeof t.started === "string" &&
            (t.where === undefined || t.where === "wsl")
        ) &&
        (force === undefined || typeof force === "boolean")
      if (!valid) return send(res, 400)
      const m = machines.find((x) => x.id === decodeURIComponent(quitPath[1]))
      if (!m?.procs) return send(res, 404)
      if (!isOnline(m, Date.now())) return send(res, 409)
      sendJson(res, 200, { results: quit(m, targets, force === true) })
    })
    return
  }

  if (req.method === "GET" && url.pathname === "/api/alerts/key") {
    return sendJson(res, 200, { publicKey: alertsKey })
  }

  if (req.method === "POST" && url.pathname === "/api/alerts/subscriptions") {
    readJson(req, res, true, (body) => {
      const { endpoint, keys } = isObject(body) ? body : {}
      const ok =
        typeof endpoint === "string" &&
        endpoint.startsWith("https:") &&
        isObject(keys) &&
        typeof keys.p256dh === "string" &&
        keys.p256dh !== "" &&
        typeof keys.auth === "string" &&
        keys.auth !== ""
      if (!ok) return send(res, 400)
      subscriptions.set(endpoint, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } })
      console.log(`alerts: subscribed ${endpoint.slice(0, 60)} (${subscriptions.size} total)`)
      send(res, 201)
    })
    return
  }

  if (req.method === "DELETE" && url.pathname === "/api/alerts/subscriptions") {
    readJson(req, res, false, (body) => {
      const endpoint = isObject(body) ? body.endpoint : undefined
      const had = typeof endpoint === "string" && subscriptions.delete(endpoint)
      console.log(`alerts: unsubscribed ${had ? "" : "(was not subscribed) "}${String(endpoint).slice(0, 60)}`)
      send(res, 204)
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/api/alerts/test") {
    readJson(req, res, false, (body) => {
      const endpoint = isObject(body) ? body.endpoint : undefined
      if (typeof endpoint !== "string" || !subscriptions.has(endpoint)) return send(res, 404)
      if (process.env.MOCK_ALERTS_TEST === "502") {
        console.log(`alerts: test for ${endpoint.slice(0, 60)} -> 502`)
        return send(res, 502, "push service answered 403")
      }
      console.log(`alerts: test for ${endpoint.slice(0, 60)} -> 204`)
      send(res, 204)
    })
    return
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    res.write(": hello\n\n")
    clients.add(res)
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000)
    req.on("close", () => {
      clearInterval(ping)
      clients.delete(res)
    })
    return
  }

  res.writeHead(404, { "content-type": "text/plain" })
  res.end("Not found\n")
})

server.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
})

server.listen(port, "127.0.0.1", () => {
  console.log(`mock dashboard server on http://127.0.0.1:${port}${extra ? " (with --extra Machines)" : ""}`)
  for (const m of machines) {
    if (!m.procs) continue
    const pick = (app, where) => m.procs.filter((p) => p.app === app && p.where === where && canQuit(p)).slice(0, 2).map((p) => p.pid)
    const names = m.os === "windows" ? [["Discord"], ["Spotify"], ["chrome"], ["claude", "wsl"], ["bash", "wsl"]] : [["Slack"], ["Terminal"], ["node"], ["Google Chrome"]]
    console.log(`  ${m.id} quittable pids: ${names.map(([a, w]) => `${w ? "wsl " : ""}${a} ${pick(a, w).join("/")}`).join(", ")}`)
  }
  console.log("  demo: wsl node 5121 ignores a plain quit; Code.exe 14608 needs force")
})
