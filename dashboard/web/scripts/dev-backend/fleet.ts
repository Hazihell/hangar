// The fake Machines: what each one is, what it reports, and how it answers the commands the real server sends it. The server
// reaches a Machine only through the adapters it is given (`exec`, `local`, `mainPid`, `fetch`); this is the scripted other
// side of them. It decides nothing the server decides: Quit policy, command lifecycles and the Apps view stay in the server.
import { DatabaseSync } from "node:sqlite"
import type { Disk, Process, Report, ReportVpn, Update } from "../../../contract.ts"
import type { Local } from "../../../server/quit.ts"
import type { FetchLike } from "../../../server/push.ts"
import type { Machine } from "../../../server/store.ts"
import type { Exec } from "../../../server/vpn.ts"
import {
  CODE_NEEDS_FORCE_PID, DAY, GB, MAC_SPECS, MAC_SPIKERS, PC_SPECS, PC_SPIKERS, STUCK_PID, T3_MAIN_PID,
  appLoad, buildProcs, clamp, cpuAt, loadKey, minuteStart, noise, round1, startedToken, tempOf,
} from "./fixtures.ts"
import type { Proc, Rand, Spec, Spiker } from "./fixtures.ts"

export type Timing = {
  /** A VPN command, from click to the operating system's answer. */
  vpnMs: number
  /** How long the PC is gone after Sleep (or after Shut down, with `shutdownOk`). */
  asleepMs: number
  /** How long Shut down takes to be refused ("blocked by an app"). */
  powerFailMs: number
  /** Each item of an Update. */
  updateMs: number
  /** How long the Dashboard is down while Hangar updates itself on the PC. */
  restartMs: number
  /** `hangar outdated`, when asked for. */
  checkMs: number
  /** How long a Process that was sent a quit takes to exit. */
  goneMs: number
  /** How long a minute's Top Apps, and T3's running threads, take to come back: long enough for the page's loading state to show. */
  minuteMs: number
  threadsMs: number
}
export type Script = {
  timing: Timing
  /** Shut down goes down like Sleep, instead of being refused. */
  shutdownOk: boolean
  /** Codex fails to update on the PC. */
  updateFails: boolean
  /** What T3 says about its running threads: some, none, or unreadable. */
  t3Threads: "running" | "none" | "null"
  /** The HTTP status the fake push service answers with. */
  pushStatus: number
  /** `calm`: every Machine Online and no drive nearly full. */
  calm: boolean
  /** `extra`: two more Machines that exercise edge states. */
  extra: boolean
}
/** What the fleet asks of the dev backend around it: things only the process hosting the server can do. */
export type World = {
  /** Sends the Machine's report now, instead of at the next interval. */
  reportNow: (id: string) => void
  /** The Dashboard server's computer goes to sleep for `ms`: connections drop and are refused; resolves on wake. */
  suspend: (ms: number) => Promise<void>
  /** The Dashboard server restarts (it was shut down, or updated): it is down for `ms`, then comes back fresh with `build`. */
  restart: (ms: number, build?: string) => void
  /** True while the dev backend is replaying the past at start: commands answer at once. */
  booting: () => boolean
}

type Vpn = ReportVpn
type Tool = { id: string; name: string; current: string; latest: string; blocked: string | null; behind?: number }
export type Persona = {
  machine: Machine
  rand: Rand
  /** Reports now. The offline Mac doesn't, and neither does a Machine that never reported. */
  live: boolean
  /** A PC that is asleep reports nothing. */
  down: boolean
  /** Has a History to seed (the Machine that never reported has none). */
  history: boolean
  /** The chance a minute of the seeded History is missing, and hours-ago windows with no reports at all (the Mac asleep). */
  missRate: number
  silent: [number, number] | null
  ramTotal: number
  ramPct: number
  ramRange: [number, number]
  ramSpread: number
  /** The PC's RAM climbs a little under load. */
  ramLoadBias: boolean
  cpu: number
  cpuBase: number
  cpuBusy: number
  tempIdle: number | null
  tempGain: number
  temp: number | undefined
  gpuTemp: number | null
  disks: (now: number) => Disk[]
  services: Record<string, boolean> | null
  vpns: Vpn[]
  specs: Spec[] | null
  spikers: Spiker[]
  /** The fake operating system's Processes, which quits act on. */
  procs: Proc[]
  prand: Rand
  tools: Tool[]
}

const LOCAL_UID = 1000
const VMMEM_PID = 3920

export function createFleet(base: Machine[], script: Script, world: World, now = Date.now()) {
  const { timing } = script
  const machines: Machine[] = [...base]
  const personas = new Map<string, Persona>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); run() }, ms)
    timers.add(timer)
  }
  const diskCurve = (name: string, from: number, total: number) => (at: number): Disk => ({ name, total: total * GB, used: (from + 30 * clamp((at - (now - DAY)) / DAY, 0, 1)) * GB })
  const fixedDisk = (name: string, used: number, total: number): Disk => ({ name, used: used * GB, total: total * GB })
  const persona = (machine: Machine, p: Partial<Persona>): Persona => {
    const seed = noise(0)
    const made: Persona = {
      machine, rand: seed, live: true, down: false, history: true, missRate: 0, silent: null, ramTotal: 16 * GB, ramPct: 50, ramRange: [20, 95], ramSpread: 1.2, ramLoadBias: false,
      cpu: 10, cpuBase: 4, cpuBusy: 22, tempIdle: null, tempGain: 0.55, temp: undefined, gpuTemp: null, disks: () => [], services: null, vpns: [],
      specs: null, spikers: [], procs: [], prand: seed, tools: [], ...p,
    }
    made.cpu = made.cpuBase
    personas.set(machine.id, made)
    return made
  }
  const tool = (id: string, name: string, current: string, latest: string, extra: Partial<Tool> = {}): Tool => ({ id, name, current, latest, blocked: null, ...extra })

  for (const machine of base) {
    if (machine.collector === "wsl") {
      // Stormtrooper: Online, two drives, D: nearly full, T3 running.
      persona(machine, {
        rand: noise(7), prand: noise(101), missRate: 0.004, ramTotal: 32 * GB, ramPct: 34, ramRange: [28, 72], ramSpread: 1.6, ramLoadBias: true, cpuBase: 4, cpuBusy: 22,
        tempIdle: 38, gpuTemp: 41, services: { t3: true },
        disks: (at) => [fixedDisk("C:", 588, 930), diskCurve("D:", script.calm ? 1290 : 1702, 1863)(at)],
        vpns: [{ name: "Steeprock", status: "connected", kind: "other" }],
        specs: PC_SPECS, spikers: PC_SPIKERS,
        tools: [
          tool("t3", "T3 Code", "0.0.27", "0.0.29"), tool("claude", "Claude Code", "2.1.302", "2.1.310"), tool("codex", "Codex", "0.48.0", "0.50.1"),
          tool("gh", "GitHub CLI", "2.81.0", "2.82.1", { blocked: "Run `hangar update` on the PC" }), tool("tea", "Gitea CLI", "0.11.1", "0.11.1"),
          tool("hangar", "Hangar", "2fc68d8", "7a1c9e0", { behind: 2 }),
        ],
      })
    } else {
      // MacBook Air: Offline, last seen ~2 h ago, unless calm.
      persona(machine, {
        rand: noise(11), prand: noise(202), ramPct: 58, ramRange: [48, 86], ramSpread: 2, cpuBase: 6, cpuBusy: 14, tempIdle: 46, tempGain: 0.9,
        live: script.calm, silent: [13, 20], disks: () => [{ name: "Macintosh HD", used: Math.round(0.612 * 460.4 * GB), total: Math.round(460.4 * GB) }],
        vpns: [{ name: "Steeprock", status: "connected", kind: "other" }, { name: "Office", status: "disconnected", kind: "ppp" }],
        specs: MAC_SPECS, spikers: MAC_SPIKERS,
        tools: [
          tool("claude", "Claude Code", "2.1.305", "2.1.310"), tool("codex", "Codex", "0.50.1", "0.50.1"), tool("gh", "GitHub CLI", "2.82.1", "2.82.1"),
          tool("tea", "Gitea CLI", "0.10.1", "0.11.1"), tool("hangar", "Hangar", "2fc68d8", "7a1c9e0", { behind: 2 }),
        ],
      })
    }
  }
  if (script.extra) {
    // One that never reported, and one with many drives and a hot CPU. Neither lists Processes, so the page hides their Apps.
    const lab: Machine = { id: "lab-mini", name: "Lab Mini", os: "linux", collector: "mac" }
    const render: Machine = { id: "render-box", name: "Render Station", os: "windows", collector: "mac" }
    machines.push(lab, render)
    persona(lab, { live: false, history: false })
    persona(render, {
      rand: noise(23), ramTotal: 64 * GB, ramPct: 84, ramRange: [78, 90], cpuBase: 10, cpuBusy: 30, tempIdle: 86, tempGain: 0.15, services: { t3: false },
      disks: () => [fixedDisk("C:", 402, 930), fixedDisk("D:", 3260, 3726), fixedDisk("E:", 120, 1863), fixedDisk("F:", 1490, 1863), fixedDisk("G:", 12, 238)],
    })
  }
  for (const p of personas.values()) if (p.specs) p.procs = buildProcs(p.specs, p.machine.os === "windows" ? "windows" : "macos", p.prand)

  const personaOf = (id: string) => personas.get(id)!

  // --- What a Machine reports ---------------------------------------------
  /** One Usage report, as the Machine's reporter would send it at `at`. `live` reports smooth over the last one; a seeded History minute doesn't. */
  function report(id: string, at: number, live = true): Report {
    const p = personaOf(id)
    const k = live ? 0.6 : 0
    p.cpu = clamp(p.cpu * k + cpuAt(at, p.rand, p.cpuBase, p.cpuBusy) * (1 - k), 0.5, 100)
    p.ramPct = clamp(p.ramPct + (p.rand() - 0.5) * p.ramSpread + (p.ramLoadBias ? (p.cpu > 40 ? 0.5 : -0.1) : 0), p.ramRange[0], p.ramRange[1])
    if (p.tempIdle !== null) {
      const target = tempOf(p.cpu, p.tempIdle, p.rand, p.tempGain)
      p.temp = p.temp === undefined ? target : clamp(p.temp * (live ? 0.7 : 0) + target * (live ? 0.3 : 1), 25, 110)
    }
    const body: Report = {
      machine: id,
      cpu: round1(p.cpu),
      ram: { used: Math.round((p.ramPct / 100) * p.ramTotal), total: p.ramTotal },
      disks: p.disks(at),
      ...(p.services ? { services: p.services } : {}),
      ...(p.temp === undefined ? {} : { temps: { cpu: round1(p.temp), ...(p.gpuTemp === null ? {} : { gpu: p.gpuTemp }) } }),
      vpns: p.vpns.map((v) => ({ ...v })),
    }
    if (p.specs) Object.assign(body, processLists(p, at))
    return body
  }

  function processLists(p: Persona, at: number) {
    const load = appLoad(p.specs!, p.spikers, p.machine.id, minuteStart(at), p.cpu)
    const shares = new Map<string, number>()
    for (const proc of p.procs) shares.set(loadKey(proc.app, proc.wsl), (shares.get(loadKey(proc.app, proc.wsl)) ?? 0) + proc.share)
    const row = (proc: Proc): Process => {
      const key = loadKey(proc.app, proc.wsl), app = load.get(key)!
      return {
        pid: proc.pid, name: proc.name, app: proc.app, started: proc.started, own: proc.own,
        cpu: round1((app.cpu * proc.share) / shares.get(key)! * (0.75 + 0.5 * p.prand())),
        ram: Math.round(proc.ramBase * app.ramFactor * (0.97 + 0.06 * p.prand())),
      }
    }
    const host = p.procs.filter((x) => !x.wsl).map(row)
    const wsl = p.procs.filter((x) => x.wsl).map(row)
    // Windows lists WSL's virtual machine as a Process of its own, which is where the WSL App's RAM comes from.
    if (wsl.length) host.push({ pid: VMMEM_PID, name: "vmmemWSL", app: "vmmemWSL", cpu: 0, ram: Math.round(7 * GB * (0.99 + 0.02 * p.prand())), started: startedToken("windows", VMMEM_PID), own: false })
    return { processes: host, ...(wsl.length ? { wsl } : {}) }
  }

  // --- The commands the server runs ---------------------------------------
  const failure = (code = 1) => Object.assign(new Error("Command failed"), { code })
  const exit = (p: Persona, proc: Proc) => later(timing.goneMs, () => { p.procs = p.procs.filter((x) => x !== proc) })
  const decode = (args: string[]) => {
    const at = args.indexOf("-EncodedCommand")
    return at < 0 ? "" : Buffer.from(args[at + 1], "base64").toString("utf16le")
  }
  const base64Of = (text: string, pattern: RegExp) => { const m = text.match(pattern); return m ? Buffer.from(m[1], "base64").toString("utf8") : null }
  const pc = () => [...personas.values()].find((p) => p.machine.collector === "wsl")!
  const asleep = (p: Persona, ms: number) => { p.down = true; return world.suspend(ms).finally(() => { p.down = false; world.reportNow(p.machine.id) }) }
  const outdated = (p: Persona) => JSON.stringify({ items: p.tools.map((t): Update => ({ id: t.id, name: t.name, current: t.current, latest: t.latest, available: t.current !== t.latest, blocked: t.blocked, ...(t.behind === undefined ? {} : { behind: t.behind }) })) })

  type Done = Parameters<Exec>[3]
  /** A VPN command: the operating system moves the VPN through its states and the next report shows them; "Office" never connects. */
  function vpnCommand(p: Persona, name: string, action: "connect" | "disconnect", done: Done) {
    const v = p.vpns.find((x) => x.name === name)
    if (!v) return done(failure(), "", `no VPN named ${name}`)
    later(Math.min(1500, timing.vpnMs / 2), () => { v.status = action === "connect" ? "connecting" : "disconnecting"; world.reportNow(p.machine.id) })
    later(timing.vpnMs, () => {
      if (action === "connect" && name === "Office") {
        v.status = "disconnected"; world.reportNow(p.machine.id)
        done(failure(), "", "L2TP: incorrect user shared secret found.")
      } else {
        v.status = action === "connect" ? "connected" : "disconnected"; world.reportNow(p.machine.id)
        done(null, "", "")
      }
    })
  }

  /** Windows' answer to a Quit: the PowerShell the server sends carries the targets, and the host's own checks are scripted here. */
  function quitWindows(p: Persona, source: string, done: Done) {
    const data = JSON.parse(base64Of(source, /FromBase64String\('([^']+)'\)\) \| ConvertFrom-Json/)!) as { targets: { pid: number; started: string }[]; force: boolean }
    const results = data.targets.map((t) => {
      const proc = p.procs.find((x) => !x.wsl && x.pid === t.pid)
      if (!proc) return { pid: t.pid, result: "gone" }
      if (proc.started !== t.started) return { pid: t.pid, result: "changed" }
      if (proc.needsForce && !data.force) return { pid: t.pid, result: "failed", message: `ERROR: The process with PID ${proc.pid} could not be terminated. Reason: This process can only be terminated forcefully (with /F option).` }
      exit(p, proc)
      return { pid: t.pid, result: "sent" }
    })
    console.log(`quit ${p.machine.id}: ${data.targets.map((t) => t.pid).join(",")}${data.force ? " (force)" : ""} -> ${results.map((r) => r.result).join(",")}`)
    done(null, JSON.stringify(results), "")
  }

  /** The Mac's answer to a Quit over SSH: the shell script's last argument lists `pid 'started'` pairs and each gets a line back. */
  function quitMac(p: Persona, remote: string, done: Done) {
    const tail = remote.slice(remote.lastIndexOf("' sh ") + 5), force = tail.startsWith("1")
    const targets = [...tail.matchAll(/(\d+) '([^']*)'/g)].map((m) => ({ pid: Number(m[1]), started: m[2] }))
    const lines = targets.map((t) => {
      const proc = p.procs.find((x) => x.pid === t.pid)
      const result = !proc ? "gone" : proc.started !== t.started ? "changed" : "sent"
      if (proc && result === "sent") exit(p, proc)
      return `${t.pid}\t${result}\t`
    })
    console.log(`quit ${p.machine.id}: ${targets.map((t) => t.pid).join(",")}${force ? " (force)" : ""} -> ${lines.map((l) => l.split("\t")[1]).join(",")}`)
    done(null, lines.join("\n"), "")
  }

  /** `hangar outdated --json` and `hangar update ...`, which run on the Machine itself. */
  function hangar(p: Persona, words: string[], done: Done) {
    if (words[0] === "outdated") {
      const answer = () => done(null, outdated(p), "")
      // At start the past is being replayed, and nothing may wait.
      return world.booting() ? answer() : void later(timing.checkMs, answer)
    }
    const ids = words.slice(1)
    console.log(`updates: ${p.machine.id} ${ids.join(",")}`)
    const step = (i: number) => {
      if (i === ids.length) return done(null, "", "")
      later(timing.updateMs, () => {
        const item = p.tools.find((t) => t.id === ids[i])!
        if (item.id === "codex" && p.machine.collector === "wsl" && script.updateFails) {
          console.log(`updates: ${p.machine.id} codex failed`)
          return done(failure(), "", "npm error EACCES: permission denied, rename '/usr/lib/node_modules/@openai/codex'")
        }
        Object.assign(item, { current: item.latest }); item.behind = item.behind === undefined ? undefined : 0
        // Updating Hangar on the PC restarts the Dashboard, which takes the update's own process with it: nothing reports back.
        if (item.id === "hangar" && p.machine.collector === "wsl") { console.log(`updates: ${p.machine.id} hangar -> restarting for ${timing.restartMs / 1000} s`); return world.restart(timing.restartMs, item.latest) }
        step(i + 1)
      })
    }
    step(0)
  }

  const hangarPath = "/dev-backend/hangar"
  const exec: Exec = (file, args, _options, done) => {
    const source = decode(args)
    const remote = file === "ssh" ? args.at(-1)! : ""
    const mac = file === "ssh" ? [...personas.values()].find((p) => p.machine.ssh && args.includes(p.machine.ssh)) : undefined
    let m: RegExpMatchArray | null
    if (file === "/mnt/c/Windows/System32/rasdial.exe") vpnCommand(pc(), args[0], "disconnect", done)
    else if (source.includes("SetSuspendState")) {
      console.log(`power: ${pc().machine.id} sleep -> down for ${timing.asleepMs / 1000} s`)
      void asleep(pc(), timing.asleepMs).then(() => { console.log(`power: ${pc().machine.id} is back`); done(null, "", "") })
    } else if (file === "/mnt/c/Windows/System32/shutdown.exe") {
      if (script.shutdownOk) { console.log(`power: ${pc().machine.id} shutdown -> down for ${timing.asleepMs / 1000} s`); world.restart(timing.asleepMs) }
      else later(Math.max(0, timing.powerFailMs - 1500), () => done(failure(), "", `${pc().machine.name} didn't shut down — an app may have blocked it`))
    } else if (source.includes("ConvertFrom-Json") && source.includes("$data.targets")) quitWindows(pc(), source, done)
    else if ((m = source.match(/-Name \(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)\)\s*$/))) vpnCommand(pc(), Buffer.from(m[1], "base64").toString("utf8"), "connect", done)
    else if (file === hangarPath) hangar(pc(), args, done)
    else if (mac && (m = remote.match(/^"\$HOME\/\.local\/bin\/hangar" (.*)$/))) hangar(mac, m[1].split(" "), done)
    else if (mac && (m = remote.match(/(scutil --nc (start|stop)|networksetup -connectpppoeservice) '(.*)'$/))) vpnCommand(mac, m[3], m[2] === "stop" ? "disconnect" : "connect", done)
    else if (mac && remote.startsWith("sh -c ")) quitMac(mac, remote, done)
    else {
      console.error(`dev backend: no script for ${file} ${args.join(" ").slice(0, 120)}`)
      done(failure(127), "", "dev backend has no script for this command")
    }
    return undefined
  }

  // WSL's Processes are read and signalled by the server itself, so those are scripted here too.
  const local: Local = {
    uid: LOCAL_UID,
    read: (pid) => {
      const proc = pc().procs.find((x) => x.wsl && x.pid === pid)
      if (!proc) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return { pid, name: proc.name, started: proc.started, uid: proc.own ? LOCAL_UID : 0, ppid: 1, ticks: 0, ram: proc.ramBase }
    },
    quit: (pid, signal) => {
      const p = pc(), proc = p.procs.find((x) => x.wsl && x.pid === pid)
      if (!proc) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
      console.log(`quit ${p.machine.id}: wsl:${pid} (${signal})${proc.ignores && signal === "SIGTERM" ? " -> ignored" : ""}`)
      if (!(proc.ignores && signal === "SIGTERM")) exit(p, proc)
    },
  }

  // Alerts: pushes go to a fake push service, never a real one.
  const fetch: FetchLike = async (url) => {
    console.log(`alerts: push to ${new URL(url).host} -> ${script.pushStatus}`)
    return { status: script.pushStatus, ok: script.pushStatus >= 200 && script.pushStatus < 300 }
  }

  /** T3's own database, as far as the Dashboard reads it: threads with a run that hasn't finished. */
  function writeT3Db(path: string) {
    if (script.t3Threads === "null") return // nothing there: unreadable
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, deleted_at TEXT, archived_at TEXT);
      CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT, completed_at TEXT, ordinal INTEGER)`)
    if (script.t3Threads === "running") {
      const threads = [["Fix the flaky reporter test on the Mac", "running"], ["Dashboard: Updates row and confirmations", "waiting"]]
      threads.forEach(([title, status], i) => {
        db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,NULL,NULL)").run(`thread-${i}`, title)
        db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,NULL,?)").run(`thread-${i}`, status, threads.length - i)
      })
    }
    db.close()
  }

  /** For the start-up log: a few pids of each demo App that may be quit. */
  function demoPids() {
    return [...personas.values()].filter((p) => p.procs.length).map((p) => {
      const names: [string, boolean][] = p.machine.os === "windows"
        ? [["Discord", false], ["Spotify", false], ["chrome", false], ["claude", true], ["bash", true]]
        : [["Slack", false], ["Terminal", false], ["node", false], ["Google Chrome", false]]
      return `  ${p.machine.id} quittable pids: ${names.map(([app, wsl]) => `${wsl ? "wsl " : ""}${app} ${p.procs.filter((x) => x.app === app && x.wsl === wsl && x.own).slice(0, 2).map((x) => x.pid).join("/")}`).join(", ")}`
    })
  }

  return {
    machines, personas, report, exec, local, fetch, writeT3Db, demoPids, hangarPath,
    kill: (() => {}) as (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
    mainPid: async () => T3_MAIN_PID as number | null,
    demo: `  demo: wsl node ${STUCK_PID} ignores a plain quit; Code.exe ${CODE_NEEDS_FORCE_PID} needs force`,
    close() { for (const timer of timers) clearTimeout(timer); timers.clear() },
  }
}
export type Fleet = ReturnType<typeof createFleet>
