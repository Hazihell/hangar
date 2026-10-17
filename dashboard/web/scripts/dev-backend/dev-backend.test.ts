// @vitest-environment node
// The dev backend's scenarios, seen through the real server's HTTP interface: each one is a Machine's scripted behaviour
// meeting the server's own policy, so a change to a command's shape or a Quit result that the fakes no longer match fails here.
import { createECDH, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import type { App, Machine, MachinesResponse, QuitResponse } from "../../../contract.ts"
import { startDevBackend } from "./index.ts"
import type { DevBackend } from "./index.ts"

const timing = { vpnMs: 200, asleepMs: 600, powerFailMs: 1500, updateMs: 50, restartMs: 300, checkMs: 50, goneMs: 100, minuteMs: 30, threadsMs: 30 }
const options = { port: 0, quiet: true, reportMs: 100, timing }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > end) return value
    await sleep(40)
  }
}
const client = (backend: () => DevBackend) => {
  const json = { "content-type": "application/json" }
  return {
    get: (path: string) => fetch(backend().url + path),
    post: (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(backend().url + path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) }),
    machines: async () => ((await (await fetch(backend().url + "/api/machines")).json()) as MachinesResponse).machines,
    machine: async (id: string) => (await (await fetch(backend().url + "/api/machines")).json() as MachinesResponse).machines.find((m) => m.id === id) as Machine,
  }
}
const inWsl = (m: Machine) => m.apps?.list.find((a) => a.name === "WSL")?.apps ?? []
const processes = (apps: App[]) => apps.flatMap((a) => a.processes)

beforeAll(() => { vi.spyOn(console, "log").mockImplementation(() => {}) })

// --- The default scene: PC Online, Mac Offline ---------------------------------------------------
{
  let backend: DevBackend
  const api = client(() => backend)
  beforeAll(async () => { backend = await startDevBackend(options) })
  afterAll(async () => { await backend.close() })

  test("starts with 24 h of History, an Offline Mac with its Apps, and Alerts read from the real rules", async () => {
    const [pc, mac] = await api.machines()
    expect(pc.online).toBe(true)
    expect(pc.history.length).toBeGreaterThan(1400)
    expect(Date.parse(pc.history[0].t)).toBeGreaterThan(Date.now() - 24 * 3_600_000 - 60_000)
    expect(mac.online).toBe(false)
    expect(Date.now() - Date.parse(mac.lastSeen!)).toBeGreaterThan(120 * 60_000)
    expect(mac.apps?.list.length).toBeGreaterThan(3)
    expect(mac.history.length).toBeGreaterThan(700) // with a gap where it was asleep
    expect(pc.attention?.map((a) => a.title)).toEqual(["D: on Stormtrooper nearly full"])
    expect(pc.power).toBeDefined()
    expect(mac.power).toBeUndefined()
    expect(pc.updates?.checkedAt && Date.now() - Date.parse(pc.updates.checkedAt)).toBeGreaterThan(110 * 60_000)
  })

  test("the Top Apps of a History minute follow its CPU spike", async () => {
    const pc = await api.machine("stormtrooper")
    const spike = pc.history.reduce((a, b) => (b.cpu > a.cpu ? b : a)), quiet = pc.history.reduce((a, b) => (b.cpu < a.cpu ? b : a))
    const minute = async (t: string) => ((await (await api.get(`/api/machines/stormtrooper/minutes/${encodeURIComponent(t)}`)).json()) as { apps: { name: string; cpu: number }[] }).apps
    const leader = (apps: { name: string; cpu: number }[]) => { const top = [...apps].sort((a, b) => b.cpu - a.cpu)[0]; return { name: top.name, share: top.cpu / apps.reduce((n, a) => n + a.cpu, 0) } }
    const [hot, calm] = [leader(await minute(spike.t)), leader(await minute(quiet.t))]
    expect(["node", "claude", "chrome-headless-shell", "chrome"]).toContain(hot.name)
    expect(hot.share).toBeGreaterThan(calm.share + 0.1) // a spike is mostly one App
    expect((await api.get("/api/machines/rogers-macbook-air/minutes/" + encodeURIComponent((await api.machine("rogers-macbook-air")).history[100].t))).status).toBe(200) // the Offline Mac too
  })

  test("the T3 service's main process is protected from the first view, not only after a Quit", async () => {
    const t3 = processes(inWsl(await api.machine("stormtrooper"))).find((p) => p.pid === 4802)
    expect(t3?.quit).toBe(false)
  })

  test("Quit: the stuck WSL node ignores a plain quit, Code.exe needs force, the T3 service is protected", async () => {
    const stuck = () => api.machine("stormtrooper").then((m) => processes(inWsl(m)).find((p) => p.pid === 5121))
    const started = (await until(stuck, Boolean))!.started
    const quit = async (body: unknown) => (await (await api.post("/api/machines/stormtrooper/quit", body)).json()) as QuitResponse

    expect((await quit({ targets: [{ pid: 5121, started, where: "wsl" }], force: false })).results[0].result).toBe("sent")
    await sleep(timing.goneMs * 3 + 300) // long enough to have left, and be missing from a report
    expect(await stuck()).toBeDefined()
    expect((await quit({ targets: [{ pid: 4802, started: processes(inWsl(await api.machine("stormtrooper"))).find((p) => p.pid === 4802)!.started, where: "wsl" }], force: false })).results[0].result).toBe("protected")
    expect((await quit({ targets: [{ pid: 5121, started, where: "wsl" }], force: true })).results[0].result).toBe("sent")
    expect(await until(stuck, (p) => p === undefined)).toBeUndefined()

    const code = processes((await api.machine("stormtrooper")).apps!.list).find((p) => p.pid === 14608)!
    const target = { pid: 14608, started: code.started }
    const refused = (await quit({ targets: [target], force: false })).results[0]
    expect(refused.result).toBe("failed")
    expect(refused.message).toMatch(/can only be terminated forcefully/)
    expect((await quit({ targets: [target], force: true })).results[0].result).toBe("sent")
    expect((await quit({ targets: [{ pid: 999999, started: "1" }], force: false })).results[0].result).toBe("gone")
    expect((await quit({ targets: [{ pid: 14600, started: "reused" }], force: false })).results[0].result).toBe("changed")
  })

  test("an App is quit by name, and the Offline Mac answers 409", async () => {
    const result = (await (await api.post("/api/machines/stormtrooper/quit", { app: "Discord", force: false })).json()) as QuitResponse
    expect(result.results.length).toBeGreaterThan(1)
    expect(new Set(result.results.map((r) => r.result))).toEqual(new Set(["sent"]))
    expect((await api.post("/api/machines/rogers-macbook-air/quit", { app: "Slack", force: false })).status).toBe(409)
  })

  test("only requests from the Dashboard's own origin change anything", async () => {
    expect((await api.post("/api/machines/stormtrooper/vpns/Steeprock", { action: "disconnect" }, { origin: "https://evil.example" })).status).toBe(403)
  })

  test("a PC VPN disconnects through the Machine's next report; the Offline Mac's VPNs answer 409", async () => {
    expect((await api.post("/api/machines/stormtrooper/vpns/Steeprock", { action: "disconnect" })).status).toBe(202)
    const vpn = await until(async () => (await api.machine("stormtrooper")).vpns[0], (v) => v.status === "disconnected" && v.pending === null)
    expect(vpn).toMatchObject({ status: "disconnected", pending: null, error: null })
    expect((await api.post("/api/machines/rogers-macbook-air/vpns/Office", { action: "connect" })).status).toBe(409)
  })

  test("Updates: gh is blocked, Check now rechecks, a failing Codex ends the run with the error, T3's threads are listed", async () => {
    expect((await api.post("/api/machines/stormtrooper/updates", { items: ["gh"] })).status).toBe(409)
    const checkedBefore = (await api.machine("stormtrooper")).updates!.checkedAt
    expect((await api.post("/api/machines/stormtrooper/updates/check")).status).toBe(202)
    const rechecked = await until(async () => (await api.machine("stormtrooper")).updates!, (u) => !u.checking && u.checkedAt !== checkedBefore)
    expect(Date.parse(rechecked.checkedAt!)).toBeGreaterThan(Date.parse(checkedBefore!) + 60 * 60_000)

    expect((await api.post("/api/machines/stormtrooper/updates", { items: ["claude", "codex"] })).status).toBe(202)
    const failed = await until(async () => (await api.machine("stormtrooper")).updates!, (u) => u.pending === null && u.error !== null)
    expect(failed.error?.message).toMatch(/EACCES/)
    const items = (await until(async () => (await api.machine("stormtrooper")).updates!, (u) => !u.checking)).items
    expect(items.find((i) => i.id === "claude")?.available).toBe(false) // done before Codex failed
    expect(items.find((i) => i.id === "codex")?.available).toBe(true)

    expect(await (await api.get("/api/machines/stormtrooper/t3-threads")).json()).toEqual({ threads: [{ title: "Fix the flaky reporter test on the Mac", status: "running" }, { title: "Dashboard: Updates row and confirmations", status: "waiting" }] })
  })

  test("Shut down is refused as blocked by an app, then Sleep takes the Dashboard away and brings it back", async () => {
    expect((await api.post("/api/machines/stormtrooper/power", { action: "shutdown" })).status).toBe(202)
    const refused = await until(async () => (await api.machine("stormtrooper")).power!, (p) => p.error !== null, 5000)
    expect(refused.error?.message).toMatch(/didn't shut down/)

    expect((await api.post("/api/machines/stormtrooper/power", { action: "sleep" })).status).toBe(202)
    await sleep(1800)
    await expect(api.get("/api/machines")).rejects.toThrow() // refused while asleep
    const power = await until(async () => (await api.machine("stormtrooper").catch(() => null))?.power, (p) => p?.pending === null && p?.error === null, 5000)
    expect(power).toMatchObject({ pending: null, error: null })
  })

  test("Hangar updating itself on the PC restarts the Dashboard: it comes back with a new build and the update done", async () => {
    const before = ((await (await api.get("/api/machines")).json()) as MachinesResponse).build
    const closedMinute = (await api.machine("stormtrooper")).history[100]
    const mac = await api.machine("rogers-macbook-air")
    const macMinute = mac.history.at(-1)!
    const macTopApps = async () => (await api.get(`/api/machines/rogers-macbook-air/minutes/${encodeURIComponent(macMinute.t)}`)).json()
    const macApps = await macTopApps()
    // Minutes later, as when the Dashboard has been up a while: a restart must not put the Offline Mac's past into later minutes.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 3 * 60_000)
    await sleep(300) // the PC reports again
    expect((await api.post("/api/machines/stormtrooper/updates", { items: ["hangar"] })).status).toBe(202)
    await sleep(150)
    const after = await until(async () => (await api.get("/api/machines").then((r) => r.json(), () => null)) as MachinesResponse | null, (r) => !!r && r.build !== before, 6000)
    expect(after!.build).not.toBe(before)
    const pc = await until(() => api.machine("stormtrooper"), (m) => m.updates?.checkedAt != null && m.online)
    expect(pc.updates!.pending).toBeNull()
    expect(pc.updates!.items.find((i) => i.id === "hangar")?.available).toBe(false)
    expect(pc.history.find((p) => p.t === closedMinute.t)).toEqual(closedMinute) // the restart rewrote no minute that had closed
    const macAfter = await api.machine("rogers-macbook-air")
    expect(macAfter.lastSeen).toBe(mac.lastSeen)
    expect(macAfter.history.find((p) => p.t === macMinute.t)).toEqual(macMinute)
    expect(await macTopApps()).toEqual(macApps)
    expect(macAfter.apps?.list.length).toBeGreaterThan(3) // and it still has its Apps
    vi.useRealTimers()
  })

  test("keeps its database in a temporary directory", () => {
    expect(backend.dbPath.startsWith(tmpdir())).toBe(true)
  })
}

// --- Calm: both Machines Online ----------------------------------------------------------------
{
  let backend: DevBackend
  const api = client(() => backend)
  beforeAll(async () => { backend = await startDevBackend({ ...options, calm: true, t3Threads: "null", pushStatus: 403 }) })
  afterAll(async () => { await backend.close() })

  test("both Machines are Online and nothing needs attention", async () => {
    const machines = await until(api.machines, (ms) => ms.every((m) => m.online))
    expect(machines.map((m) => m.online)).toEqual([true, true])
    expect(machines.flatMap((m) => m.attention ?? [])).toEqual([])
  })

  test("connecting Office always fails, with the Machine's own message", async () => {
    expect((await api.post("/api/machines/rogers-macbook-air/vpns/Office", { action: "connect" })).status).toBe(202)
    const office = await until(async () => (await api.machine("rogers-macbook-air")).vpns.find((v) => v.name === "Office")!, (v) => v.pending === null && v.error !== null)
    expect(office).toMatchObject({ status: "disconnected", error: { message: "L2TP: incorrect user shared secret found." } })
    expect((await api.post("/api/machines/rogers-macbook-air/vpns/Steeprock", { action: "disconnect" })).status).toBe(202)
    expect((await until(async () => (await api.machine("rogers-macbook-air")).vpns[0], (v) => v.status === "disconnected" && v.pending === null)).error).toBeNull()
  })

  test("the Mac quits by SSH script, with Quit policy from the real module", async () => {
    const mac = await until(() => api.machine("rogers-macbook-air"), (m) => !!m.apps && m.online)
    const slack = mac.apps!.list.find((a) => a.name === "Slack")!.processes[0]
    const quit = async (body: unknown) => (await (await api.post("/api/machines/rogers-macbook-air/quit", body)).json()) as QuitResponse
    expect((await quit({ targets: [{ pid: slack.pid, started: slack.started }], force: false })).results[0].result).toBe("sent")
    const finder = mac.apps!.list.find((a) => a.name === "Finder")!.processes[0]
    expect((await quit({ targets: [{ pid: finder.pid, started: finder.started }], force: false })).results[0].result).toBe("protected")
    const listed = () => api.machine("rogers-macbook-air").then((m) => m.apps!.list.flatMap((a) => a.processes).some((p) => p.pid === slack.pid))
    expect(await until(listed, (still) => !still)).toBe(false)
  })

  test("Alerts: a key, a subscription, and a push service that refuses answers 502", async () => {
    const key = ((await (await api.get("/api/alerts/key")).json()) as { publicKey: string }).publicKey
    expect(Buffer.from(key, "base64url")).toHaveLength(65)
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys()
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/dev", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }
    expect((await api.post("/api/alerts/subscriptions", subscription)).status).toBe(201)
    expect((await api.post("/api/alerts/test", { endpoint: subscription.endpoint })).status).toBe(502)
    expect((await api.post("/api/alerts/test", { endpoint: "https://fcm.googleapis.com/fcm/send/other" })).status).toBe(404)
  })

  test("an unreadable T3 database gives no threads", async () => {
    expect(await (await api.get("/api/machines/stormtrooper/t3-threads")).json()).toEqual({ threads: null })
  })

  test("closing removes the temporary database", async () => {
    const other = await startDevBackend(options)
    const path = other.dbPath
    expect(existsSync(path)).toBe(true)
    await other.close()
    expect(existsSync(path)).toBe(false)
  })
}

// --- Extra: the edge-state Machines -----------------------------------------------------------
{
  let backend: DevBackend
  const api = client(() => backend)
  beforeAll(async () => { backend = await startDevBackend({ ...options, extra: true }) })
  afterAll(async () => { await backend.close() })

  test("one Machine never reported; the other lists no Processes and has a hot CPU the Alerts already know of", async () => {
    const machines = await api.machines()
    const lab = machines.find((m) => m.id === "lab-mini")!, render = machines.find((m) => m.id === "render-box")!
    expect(lab).toMatchObject({ online: false, lastSeen: null, usage: null, history: [], apps: null })
    expect(render.apps).toBeNull()
    expect(render.usage?.disks).toHaveLength(5)
    expect(render.attention?.map((a) => a.title)).toContain("Render Station CPU hot")
  })
}

// --- Lifecycle ---------------------------------------------------------------------------------
test("closing while the PC sleeps leaves nothing listening", async () => {
  const backend = await startDevBackend({ ...options, timing: { ...timing, asleepMs: 800 } })
  expect((await client(() => backend).post("/api/machines/stormtrooper/power", { action: "sleep" })).status).toBe(202)
  await sleep(1700) // asleep now
  await backend.close()
  await sleep(1000) // past the wake
  await expect(fetch(backend.url + "/api/machines")).rejects.toThrow()
})

test("the PC waking from Sleep while the Dashboard restarts for an update leaves one Dashboard serving", async () => {
  const backend = await startDevBackend({ ...options, timing: { ...timing, asleepMs: 800, updateMs: 300, restartMs: 2000 } })
  const api = client(() => backend)
  expect((await api.post("/api/machines/stormtrooper/power", { action: "sleep" })).status).toBe(202)
  await sleep(1400)
  expect((await api.post("/api/machines/stormtrooper/updates", { items: ["hangar"] })).status).toBe(202) // restarts while the PC sleeps
  await sleep(3500)
  expect((await api.get("/api/machines")).status).toBe(200)
  await backend.close()
}, 15_000)

test("a start on a taken port fails, and leaves the running one alone", async () => {
  const backend = await startDevBackend(options)
  await expect(startDevBackend({ ...options, port: backend.port })).rejects.toThrow(/EADDRINUSE/)
  expect((await fetch(backend.url + "/api/machines")).status).toBe(200)
  await backend.close()
})
