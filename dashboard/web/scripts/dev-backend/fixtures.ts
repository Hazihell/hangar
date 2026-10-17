// The made-up parts of the dev backend: what the fake Machines are (their specs, Processes and curves). The Dashboard server
// itself is the real one; nothing here decides what a Quit result or an App is.
export const GB = 1024 ** 3
export const MB = 1024 ** 2
export const MINUTE = 60_000
export const DAY = 24 * 60 * MINUTE

export const round1 = (n: number) => Math.round(n * 10) / 10
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
export const minuteStart = (ms: number) => Math.floor(ms / MINUTE) * MINUTE
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export type Rand = () => number

// Deterministic noise so reloads show the same History.
export function noise(seed: number): Rand {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// A working-day CPU curve: quiet overnight, busy bursts while agents run.
export function cpuAt(ms: number, rand: Rand, base: number, busy: number) {
  const hour = new Date(ms).getHours() + new Date(ms).getMinutes() / 60
  const day = Math.max(0, Math.sin(((hour - 7) / 16) * Math.PI))
  const burst = rand() < 0.08 * day ? 25 + rand() * 45 : 0
  return clamp(base + busy * day + burst + (rand() - 0.5) * 6, 0.5, 100)
}

// CPU Temperature, °C: an idle floor plus what the load adds, and a little noise.
export function tempOf(cpu: number, idle: number, rand: Rand, gain = 0.55) {
  return clamp(idle + cpu * gain + (rand() - 0.5) * 2, 25, 110)
}

// --- Processes and Apps ---------------------------------------------------
// A spec makes `n` Processes of one App: `share` is the App's fraction of the
// Machine's CPU, `ram` its total bytes. pid_i = pid0 + i * step. `over` tweaks
// single Processes by index. Whether one may be quit is the server's call
// (names, `own`, Protection), not the fixture's.
type Over = { pid?: number; started?: string; ram?: number; w?: number; ignores?: boolean; needsForce?: boolean }
export type Spec = {
  app: string
  name?: string
  names?: string[]
  n: number
  share: number
  ram: number
  pid0: number
  step?: number
  wsl?: boolean
  own?: boolean
  over?: Record<number, Over>
}
export type Proc = {
  pid: number
  name: string
  app: string
  wsl: boolean
  share: number
  ramBase: number
  started: string
  own: boolean
  /** Ignores a plain quit (SIGTERM): `sent`, but it stays. */
  ignores?: true
  /** Refuses a plain quit with a message, as Windows does for a process that "can only be terminated forcefully". */
  needsForce?: true
}
export type Spiker = { name: string; where?: "wsl"; weight: number }

/** The T3 service's main process in WSL: the Quit module protects it once `mainPid` says so. */
export const T3_MAIN_PID = 4802
/** The WSL `node` that ignores a plain Quit, and the Windows `Code.exe` that refuses one: the Quit demos. */
export const STUCK_PID = 5121
export const CODE_NEEDS_FORCE_PID = 14608

export const PC_SPECS: Spec[] = [
  { app: "chrome", name: "chrome.exe", n: 14, share: 0.07, ram: 2.5 * GB, pid0: 9200 },
  { app: "Code", name: "Code.exe", n: 8, share: 0.06, ram: 1.3 * GB, pid0: 14600, over: { 2: { needsForce: true } } },
  { app: "WindowsTerminal", name: "WindowsTerminal.exe", n: 1, share: 0.01, ram: 95 * MB, pid0: 7320 },
  { app: "Discord", name: "Discord.exe", n: 5, share: 0.02, ram: 0.7 * GB, pid0: 11040 },
  { app: "Spotify", name: "Spotify.exe", n: 4, share: 0.01, ram: 0.45 * GB, pid0: 12880 },
  { app: "explorer", name: "explorer.exe", n: 1, share: 0.005, ram: 150 * MB, pid0: 5812 },
  { app: "dwm", name: "dwm.exe", n: 1, share: 0.01, ram: 110 * MB, pid0: 1296 },
  { app: "MsMpEng", name: "MsMpEng.exe", n: 1, share: 0.02, ram: 250 * MB, pid0: 3104, own: false },
  { app: "svchost", name: "svchost.exe", n: 40, share: 0.04, ram: 0.55 * GB, pid0: 1000, step: 28, own: false },
  { app: "OneDrive", name: "OneDrive.exe", n: 1, share: 0.003, ram: 140 * MB, pid0: 6644 },
  // Inside WSL.
  {
    app: "node", name: "node", n: 9, share: 0.45, ram: 0.9 * GB, pid0: 5300, step: 19, wsl: true,
    over: {
      0: { pid: STUCK_PID, started: "1234567", ram: 483_000_000, w: 3, ignores: true },
      1: { pid: T3_MAIN_PID, ram: 130 * MB, w: 0.1 }, // the T3 server's main process
    },
  },
  { app: "claude", name: "claude", n: 2, share: 0.12, ram: 0.55 * GB, pid0: 5601, step: 41, wsl: true },
  { app: "codex", name: "codex", n: 1, share: 0.04, ram: 0.2 * GB, pid0: 5890, wsl: true },
  { app: "chrome-headless-shell", name: "chrome-headless-shell", n: 4, share: 0.06, ram: 0.6 * GB, pid0: 6310, step: 9, wsl: true },
  { app: "bash", name: "bash", n: 6, share: 0.01, ram: 40 * MB, pid0: 5004, step: 37, wsl: true },
  { app: "python3", name: "python3", n: 1, share: 0.01, ram: 60 * MB, pid0: 6020, wsl: true },
  { app: "sshd", name: "sshd", n: 1, share: 0.001, ram: 8 * MB, pid0: 705, wsl: true },
  { app: "systemd", name: "systemd", n: 1, share: 0.002, ram: 18 * MB, pid0: 1, wsl: true },
  { app: "tailscaled", name: "tailscaled", n: 1, share: 0.005, ram: 70 * MB, pid0: 612, wsl: true },
]
export const PC_SPIKERS: Spiker[] = [
  { name: "node", where: "wsl", weight: 5 },
  { name: "claude", where: "wsl", weight: 3 },
  { name: "chrome-headless-shell", where: "wsl", weight: 1.5 },
  { name: "chrome", weight: 1.5 },
]

export const MAC_SPECS: Spec[] = [
  { app: "Codex", names: ["Codex", "Codex Helper (Renderer)", "Codex Helper (GPU)"], n: 3, share: 0.3, ram: 1.6 * GB, pid0: 8211, step: 3 },
  { app: "Slack", names: ["Slack", "Slack Helper (Renderer)", "Slack Helper (GPU)", "Slack Helper"], n: 4, share: 0.05, ram: 1.0 * GB, pid0: 7120, step: 5 },
  {
    app: "Google Chrome",
    names: ["Google Chrome", "Google Chrome Helper (GPU)", "Google Chrome Helper (Renderer)"],
    n: 12, share: 0.25, ram: 2.2 * GB, pid0: 9012, step: 17,
  },
  { app: "T3 Code", names: ["T3 Code", "T3 Code Helper (Renderer)", "T3 Code Helper (GPU)"], n: 3, share: 0.06, ram: 0.9 * GB, pid0: 7650, step: 4 },
  { app: "WindowServer", name: "WindowServer", n: 1, share: 0.06, ram: 350 * MB, pid0: 412, own: false },
  { app: "Finder", name: "Finder", n: 1, share: 0.002, ram: 140 * MB, pid0: 640 },
  { app: "Dock", name: "Dock", n: 1, share: 0.005, ram: 60 * MB, pid0: 598 },
  { app: "Tailscale", name: "Tailscale", n: 1, share: 0.003, ram: 90 * MB, pid0: 702 },
  { app: "kernel_task", name: "kernel_task", n: 1, share: 0.08, ram: 300 * MB, pid0: 0, own: false },
  { app: "mds_stores", name: "mds_stores", n: 1, share: 0.04, ram: 220 * MB, pid0: 338, own: false },
  { app: "Terminal", name: "Terminal", n: 1, share: 0.01, ram: 120 * MB, pid0: 9930 },
  { app: "node", name: "node", n: 3, share: 0.08, ram: 0.6 * GB, pid0: 10240, step: 33 },
]
export const MAC_SPIKERS: Spiker[] = [
  { name: "Codex", weight: 3 },
  { name: "Google Chrome", weight: 2 },
]

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
// An opaque start token, shaped like the real one for each platform.
export function startedToken(space: "windows" | "wsl" | "macos", pid: number) {
  if (space === "windows") return String(133_900_000_000_000_000n + BigInt(pid) * 90_000_000_000n)
  if (space === "wsl") return String(4_000 + pid * 131)
  const d = new Date(Date.UTC(2026, 9, 1, 6, 0, 0) + pid * 71_000)
  const p2 = (n: number) => String(n).padStart(2, "0")
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

export function buildProcs(specs: Spec[], os: "windows" | "macos", rand: Rand): Proc[] {
  const procs: Proc[] = []
  const used = new Set<string>()
  for (const s of specs) {
    const ws: number[] = [], rs: number[] = []
    for (let i = 0; i < s.n; i++) {
      ws.push(s.over?.[i]?.w ?? (i === 0 ? 1 : 0.05 + rand() * 0.5))
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
      procs.push({
        pid,
        name: s.names ? s.names[Math.min(i, s.names.length - 1)] : s.name!,
        app: s.app,
        wsl: s.wsl === true,
        share: (s.share * ws[i]) / wSum,
        ramBase: o.ram ?? Math.round(((s.ram - fixed) * rs[i]) / freeSum),
        started: o.started ?? startedToken(space, pid),
        own: s.own ?? true,
        ...(o.needsForce ? { needsForce: true as const } : {}),
        ...(o.ignores ? { ignores: true as const } : {}),
      })
    }
  }
  return procs
}

/**
 * What each App of a Machine uses in one History minute, made from the minute alone so every report in it agrees, and
 * following the minute's cpu: a spike is mostly one or two Apps (the Machine's spikers), so Top Apps can explain it.
 */
export function appLoad(specs: Spec[], spikers: Spiker[], id: string, minute: number, cpu: number) {
  const rand = noise(hash(`${id}|${new Date(minute).toISOString()}`))
  const roster = specs.map((s) => ({ name: s.app, where: s.wsl ? ("wsl" as const) : undefined, share: s.share, ram: s.ram }))
  const ws = roster.map((r) => r.share * (0.5 + rand()))
  const boost = clamp((cpu - 12) / 40, 0, 1)
  const dominant = new Set<Spiker>()
  const pick = (exclude: Set<Spiker>) => {
    const pool = spikers.filter((s) => !exclude.has(s))
    let x = rand() * sum(pool.map((s) => s.weight))
    for (const s of pool) if ((x -= s.weight) < 0) return s
    return pool[0]
  }
  dominant.add(pick(new Set()))
  if (rand() < 0.4) dominant.add(pick(dominant))
  const base = sum(ws)
  const isHot = (r: (typeof roster)[number]) => [...dominant].some((d) => d.name === r.name && d.where === r.where)
  roster.forEach((r, i) => {
    if (isHot(r)) ws[i] += (base * boost * 9) / dominant.size
  })
  const total = sum(ws)
  const load = new Map<string, { cpu: number; ramFactor: number }>()
  roster.forEach((r, i) => {
    const ramRand = noise(hash(`${r.name}|${r.where}|${Math.floor(minute / (15 * MINUTE))}`))()
    load.set(loadKey(r.name, r.where === "wsl"), {
      cpu: ((cpu * ws[i]) / total) * (0.97 + 0.06 * rand()),
      ramFactor: (0.92 + 0.16 * ramRand) * (isHot(r) ? 1 + 0.6 * boost : 1),
    })
  })
  return load
}
export const loadKey = (app: string, wsl: boolean) => `${wsl ? "wsl:" : ""}${app}`
