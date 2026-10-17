// The dev backend: the real Dashboard server (`createDashboard`), standing on fake adapters, with a feeder standing in for the
// Machines' reporters. See scripts/mock-server.mjs for the scenarios it can show.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createDashboard } from "../../../server/server.ts"
import type { Machine } from "../../../server/store.ts"
import { MINUTE } from "./fixtures.ts"
import { createFleet } from "./fleet.ts"
import type { Report } from "../../../contract.ts"
import type { Script, Timing, World } from "./fleet.ts"
import { seedHistory } from "./seed.ts"

export const DEFAULT_TIMING: Timing = { vpnMs: 4_000, asleepMs: 25_000, powerFailMs: 8_000, updateMs: 4_000, restartMs: 8_000, checkMs: 1_500, goneMs: 1_500, minuteMs: 250, threadsMs: 300 }
export type Options = Partial<Omit<Script, "timing">> & {
  /** 0 picks a free one. */
  port?: number
  timing?: Partial<Timing>
  /** How often each live Machine reports. */
  reportMs?: number
  /** The page the Dashboard says it is serving; a Hangar update on the PC changes it. */
  build?: string
  quiet?: boolean
}

const machinesJson = resolve(import.meta.dirname, "../../../machines.json")
// What each Machine's Updates were last checked, and when the Mac last reported (if it is Offline).
const CHECKED_AGO: Record<string, number> = { wsl: 120 * MINUTE, mac: 130 * MINUTE }
const MAC_LAST_SEEN = 127 * MINUTE
// The reports the Dashboard has already taken from live Machines when it starts: long enough for an Alert that waits on a streak
// (CPU, RAM or Temperature high for 5 minutes) to be firing already.
const CATCH_UP = 6 * MINUTE
const REPORT_EVERY = 10_000

export async function startDevBackend(options: Options = {}) {
  const script: Script = {
    timing: { ...DEFAULT_TIMING, ...options.timing }, shutdownOk: options.shutdownOk ?? false, updateFails: options.updateFails ?? true,
    t3Threads: options.t3Threads ?? "running", pushStatus: options.pushStatus ?? 201, calm: options.calm ?? false, extra: options.extra ?? false,
  }
  const reportMs = options.reportMs ?? 10_000
  const dir = mkdtempSync(join(tmpdir(), "hangar-dev-backend-")) // the only place it writes: never ~/.local/state/hangar
  const paths = { db: join(dir, "dashboard.db"), t3Db: join(dir, "t3.sqlite"), dist: join(dir, "dist"), vapid: join(dir, "vapid.json") }
  const log = (message: string) => { if (!options.quiet) console.log(message) }
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // The Dashboard's clock is scripted so the past can be replayed at start-up (it stands still at `replayAt`); apart from that it is the real one.
  const clock = { replayAt: null as number | null }
  let suspended = false, restarting = false, replaying = false, closed = false
  let app: ReturnType<typeof createDashboard> | undefined
  let stopping: Promise<void> | undefined
  let restartRun: Promise<void> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let port = options.port ?? 0
  const url = () => `http://127.0.0.1:${port}`
  const world: World = {
    reportNow: id => feed(id),
    suspend: async ms => {
      if (closed || restarting || suspended) return
      suspended = true
      const server = app!.server // a restart in the meantime brings its own
      server.close(); server.closeAllConnections()
      await wait(ms)
      if (!closed && !restarting && app!.server === server) await listen().catch(error => console.error("dev backend: could not wake the Dashboard:", error))
      suspended = false
    },
    restart: (ms, build) => { restartRun = restart(ms, build) },
    booting: () => replaying,
  }
  const base: Machine[] = JSON.parse(readFileSync(machinesJson, "utf8"))
  const now = Date.now()
  const fleet = createFleet(base, script, world, now)

  const writeDist = (build: string) => {
    mkdirSync(paths.dist, { recursive: true })
    writeFileSync(join(paths.dist, "index.html"), `<!doctype html>\n<title>Hangar dev backend</title>\n<!-- build ${build} -->\n<p>This is the dev backend's API; the page is served by Vite.</p>\n`)
  }
  const lastSeen = (id: string) => { const p = fleet.personas.get(id)!; return p.live ? now - CATCH_UP : now - MAC_LAST_SEEN - 3 * MINUTE }

  // Some answers take a moment on the real thing (a minute's Top Apps from disk, T3's database), which is what lets the page's
  // loading states be seen. The real server answers at once, so the delay is added in front of its handler.
  const slow: [RegExp, number][] = [[/^\/api\/machines\/[^/]+\/minutes\//, script.timing.minuteMs], [/^\/api\/machines\/[^/]+\/t3-threads/, script.timing.threadsMs]]
  const delays = new Set<ReturnType<typeof setTimeout>>()
  function delayed(server: Server) {
    const handlers = server.listeners("request") as ((req: IncomingMessage, res: ServerResponse) => void)[]
    server.removeAllListeners("request")
    server.on("request", (req, res) => {
      const ms = req.method === "GET" ? slow.find(([pattern]) => pattern.test(req.url ?? ""))?.[1] ?? 0 : 0
      for (const handler of handlers) {
        if (!ms) { handler(req, res); continue }
        const timer = setTimeout(() => { delays.delete(timer); handler(req, res) }, ms)
        delays.add(timer)
      }
    })
  }
  function open() {
    stopping = undefined
    app = createDashboard({
      db: paths.db, t3Db: paths.t3Db, hangar: fleet.hangarPath, updateChecks: false, kill: fleet.kill, machines: fleet.machines, clock: () => clock.replayAt ?? Date.now(),
      collect: false, dist: paths.dist, exec: fleet.exec, local: fleet.local, vapid: paths.vapid, fetch: fleet.fetch, mainPid: fleet.mainPid,
      hosts: (process.env.HANGAR_DASHBOARD_HOSTS ?? "").split(/[\s,]+/).filter(Boolean),
    })
    delayed(app.server)
    return listen()
  }
  function listen() {
    const server = app!.server
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); port = (server.address() as { port: number }).port; resolve() })
    })
  }
  const stopApp = () => (stopping ??= app?.close() ?? Promise.resolve())

  // --- Reporters ------------------------------------------------------------
  const post = (path: string, body: unknown) => fetch(url() + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined)
  function feed(id: string) {
    const p = fleet.personas.get(id)!
    if (!p.live || p.down || suspended || restarting || replaying || closed) return
    void post("/api/report", fleet.report(id, Date.now()))
  }
  const feedAll = () => { for (const id of fleet.personas.keys()) feed(id) }

  // What was reported at a time in the past, kept so that replaying it after a restart (at the same times) changes no History minute that has closed.
  const reported = new Map<string, Report>()
  const reportAt = (id: string, ago: number): Report => {
    const key = `${id}@${ago}`
    if (!reported.has(key)) reported.set(key, fleet.report(id, now - ago))
    return reported.get(key)!
  }
  const checkedAgo = (p: { machine: Machine }) => CHECKED_AGO[p.machine.collector === "wsl" ? "wsl" : "mac"]

  /**
   * Replays what the Dashboard would already have seen: the Machines' Updates checked a while ago, the Mac's last report if it is
   * Offline, and (at start, not after a restart) the last few minutes of every live Machine's reports, so a streak the Alerts wait
   * on is under way. The server only learns these from Machines as they report, so its clock is set to the time of each.
   */
  async function replay(restarted: boolean) {
    replaying = true
    // `ago` is from the moment the dev backend started, so a replay after a restart lands in the same minutes as the first.
    const at = async (ago: number, run: () => Promise<unknown>) => { clock.replayAt = now - ago; try { await run() } finally { clock.replayAt = null } }
    const report = (id: string, ago: number) => post("/api/report", ago === 0 ? fleet.report(id, Date.now()) : reportAt(id, ago))
    const checked = [...fleet.personas.values()].filter(p => p.tools.length).sort((a, b) => checkedAgo(b) - checkedAgo(a))
    for (const p of checked) {
      const ago = restarted && p.live ? 0 : checkedAgo(p)
      await at(ago, async () => { await report(p.machine.id, ago); await post(`/api/machines/${p.machine.id}/updates/check`, {}) })
    }
    for (const p of fleet.personas.values()) if (p.history && !p.live) await at(MAC_LAST_SEEN, () => report(p.machine.id, MAC_LAST_SEEN))
    if (!restarted) {
      for (let ago = CATCH_UP; ago >= 0; ago -= REPORT_EVERY) {
        await at(ago, async () => { for (const p of fleet.personas.values()) if (p.live && !p.down) await report(p.machine.id, 0) })
      }
    }
    // Quit looks up the T3 service's PID to protect it when asked, and on a timer only when the server collects for itself.
    await post(`/api/machines/${checked.find(p => p.machine.collector === "wsl")?.machine.id}/quit`, { app: "(the dev backend asks for the T3 service's PID)", where: "wsl", force: false })
    replaying = false
  }

  async function restart(ms: number, build?: string) {
    if (restarting || closed) return
    restarting = true
    try {
      await stopApp(); await wait(ms)
      if (closed) return
      if (build) writeDist(build)
      await open(); await replay(true); feedAll()
      log("dev backend: the Dashboard is back")
    } catch (error) { console.error("dev backend: restart failed:", error) } finally { restarting = false }
  }

  async function close() {
    closed = true
    clearInterval(interval); fleet.close()
    for (const timer of delays) clearTimeout(timer)
    await restartRun
    await stopApp()
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    writeDist(options.build ?? process.env.MOCK_BUILD ?? "2fc68d8")
    fleet.writeT3Db(paths.t3Db)
    seedHistory(paths.db, fleet, now, lastSeen)
    await open()
    await replay(false)
    feedAll()
    interval = setInterval(feedAll, reportMs)
  } catch (error) { await close(); throw error }
  log(`mock dashboard server on ${url()}${script.extra ? " (with --extra Machines)" : ""}${script.calm ? " (--calm)" : ""}`)
  for (const line of fleet.demoPids()) log(line)
  log(fleet.demo)
  log(`  database: ${paths.db} (temporary)`)

  return {
    url: url(),
    port,
    /** The temporary database file (the Dashboard's own is never touched). */
    dbPath: paths.db,
    close,
  }
}
export type DevBackend = Awaited<ReturnType<typeof startDevBackend>>
