#!/usr/bin/env node
// Dev stand-in for dashboard/server: GET /api/machines, GET /api/events and
// POST /api/machines/:id/vpns/:name per dashboard/API.md, with fake Usage and
// VPNs. No dependencies.
//
//   node scripts/mock-server.mjs [port] [--extra] [--calm]
//
// Port: argv, else MOCK_PORT, else HANGAR_DASHBOARD_PORT, else 4398.
// --extra (or MOCK_EXTRA=1) adds two Machines that exercise edge states:
// one that never reported and one with many drives.
// --calm (or MOCK_CALM=1) is the all-is-well case: both Machines Online, no
// drive nearly full.
//
// VPN commands take MOCK_VPN_MS (default 4 s); connecting "Office" always fails,
// so the error state can be seen. The MacBook is Offline unless --calm, so its
// VPNs only take commands with --calm.

import { createServer } from "node:http"

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
      history.push({ t: iso(t), cpu: round1(cpu), ram: round1(ramPct), disk: round1(diskD) })
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
      },
      vpns: [vpn("Steeprock", "connected")],
      history,
      live: true,
    })
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
      history.push({ t: iso(t), cpu: round1(cpu), ram: round1(ramPct), disk: 61.2 })
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
      },
      vpns: [vpn("Steeprock", "connected"), vpn("Office", "disconnected")],
      history,
      rand,
      ramPct: last.ram,
      live: calm,
    })
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
      history.push({ t: iso(t), cpu: round1(cpuAt(t, rand, 10, 30)), ram: round1(80 + rand() * 6), disk: 87.5 })
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
      },
      vpns: [],
      history,
      live: true,
    })
  }

  return machines
}

const machines = makeMachines(Date.now())

function view(m, now) {
  return {
    id: m.id,
    name: m.name,
    os: m.os,
    online: isOnline(m, now),
    lastSeen: m.lastSeenMs === null ? null : iso(m.lastSeenMs),
    usage: m.usage,
    vpns: m.vpns.map((v) => ({ ...v })),
  }
}

// One report from a live Machine: new Usage, folded into the current minute.
function report(m, now) {
  const cpu = round1(clamp(m.usage.cpu * 0.6 + cpuAt(now, m.rand, 4, 22) * 0.4, 0.5, 100))
  m.ramPct = clamp(m.ramPct + (m.rand() - 0.5) * 1.2, 20, 95)
  const ramTotal = m.usage.ram.total
  m.usage = {
    ...m.usage,
    at: iso(now),
    cpu,
    ram: { used: Math.round((m.ramPct / 100) * ramTotal), total: ramTotal },
  }
  m.lastSeenMs = now

  const t = iso(minuteStart(now))
  const fullest = Math.max(...m.usage.disks.map((d) => (d.used / d.total) * 100))
  const last = m.history.at(-1)
  if (last && last.t === t) {
    last.n = (last.n ?? 1) + 1
    last.cpu = round1(last.cpu + (cpu - last.cpu) / last.n)
    last.ram = round1(last.ram + (m.ramPct - last.ram) / last.n)
    last.disk = round1(fullest)
  } else {
    m.history.push({ t, cpu, ram: round1(m.ramPct), disk: round1(fullest), n: 1 })
  }
  while (m.history.length && Date.parse(m.history[0].t) < now - DAY) m.history.shift()
  const { n: _n, ...minute } = m.history.at(-1)
  return { ...view(m, now), minute }
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

setInterval(() => {
  const now = Date.now()
  for (const m of machines) if (m.live) broadcast(report(m, now))
}, Number(process.env.MOCK_REPORT_MS ?? REPORT_EVERY))

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")

  if (req.method === "GET" && url.pathname === "/api/machines") {
    const now = Date.now()
    const body = {
      now: iso(now),
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

server.listen(port, "127.0.0.1", () => {
  console.log(`mock dashboard server on http://127.0.0.1:${port}${extra ? " (with --extra Machines)" : ""}`)
})
