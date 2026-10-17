import { describe, expect, it } from "vitest"

import { processKey, type QuitRequest, type QuitResult } from "@/lib/quit"
import {
  answered,
  FORCE_AFTER_MS,
  quitRuns as readQuitRuns,
  type Ask,
  type Run,
  type Subject,
} from "@/lib/quit-runs"
import type { App, AppProcess, Apps } from "@/lib/types"

// A server policy fixture; deliberately different from the production cap.
const withPolicy: typeof readQuitRuns = (runs, report, now, maxTargets = 11) =>
  readQuitRuns(runs, report, now, maxTargets)

const proc = (pid: number, started = "t0", quit = true): AppProcess => ({
  pid,
  name: `proc${pid}`,
  cpu: 1,
  ram: 1,
  started,
  quit,
})
const app = (
  name: string,
  processes: AppProcess[],
  count = processes.length
): App => ({
  name,
  cpu: 1,
  ram: 1,
  count,
  quit: processes.some((p) => p.quit),
  processes,
})
const report = (at: string, ...list: App[]): Apps => ({ at, list })

const chrome = app("Chrome", [proc(10), proc(11)])
const pKey = (pid: number, started = "t0") =>
  processKey(undefined, pid, started)
const process = (pid: number, started = "t0"): Subject => ({
  kind: "process",
  key: pKey(pid, started),
})
const chromeSubject: Subject = { kind: "app", name: "Chrome", where: undefined }

const sent = (pid: number, started = "t0"): QuitResult => ({
  pid,
  result: "sent",
  started,
})

/** A run as the page sees it once the server has answered. */
function answeredRun(
  id: number,
  subject: Subject,
  request: QuitRequest,
  answers: QuitResult[],
  at: Apps | null,
  options: { force?: boolean; answerAt?: number } = {}
): Run {
  return {
    id,
    subject,
    force: options.force ?? false,
    request,
    phase: "answered",
    answer: answered(request, answers, at, options.answerAt ?? 0),
  }
}

const quitChrome = (at: Apps | null) =>
  answeredRun(1, chromeSubject, { app: "Chrome" }, [sent(10), sent(11)], at)

describe("the Quit run lifecycle", () => {
  it("reads idle until something is sent", () => {
    const view = withPolicy([], report("1", chrome), 0)
    expect(view.state(chromeSubject)).toEqual({ kind: "idle", note: null })
    expect(view.state(process(10))).toEqual({ kind: "idle", note: null })
  })

  it("reads quitting while sending, on the App and on a Process of it", () => {
    const run: Run = {
      id: 1,
      subject: chromeSubject,
      force: false,
      request: { app: "Chrome" },
      phase: "sending",
    }
    const view = withPolicy([run], report("1", chrome), 0)
    expect(view.state(chromeSubject)).toEqual({
      kind: "quitting",
      force: false,
    })
    // An App quit by name doesn't know its Processes until the answer.
    expect(view.state(process(10))).toEqual({ kind: "idle", note: null })

    const byPid: Run = {
      id: 2,
      subject: process(10),
      force: true,
      request: { targets: [{ pid: 10, started: "t0" }] },
      phase: "sending",
    }
    expect(
      withPolicy([byPid], report("1", chrome), 0).state(process(10))
    ).toEqual({ kind: "quitting", force: true })
  })

  it("shows the refusal as a note, with nothing to force", () => {
    const run: Run = {
      id: 1,
      subject: chromeSubject,
      force: false,
      request: { app: "Chrome" },
      phase: "refused",
      error: "Not now: the Machine is Offline.",
    }
    expect(
      withPolicy([run], report("1", chrome), 0).state(chromeSubject)
    ).toEqual({
      kind: "idle",
      note: {
        tone: "error",
        text: "Couldn’t quit. Not now: the Machine is Offline.",
      },
    })
  })

  it("goes quitting → idle when the reports stop listing the Processes", () => {
    const run = quitChrome(report("1", chrome))
    expect(
      withPolicy([run], report("2", chrome), 1_000).state(chromeSubject)
    ).toEqual({ kind: "quitting", force: false })
    expect(
      withPolicy([run], report("3", app("Firefox", [proc(20)])), 2_000).state(
        chromeSubject
      )
    ).toEqual({ kind: "idle", note: null })
  })

  it("goes quitting → stuck once a report after the wait still lists a Process", () => {
    const run = quitChrome(report("1", chrome))
    const later = FORCE_AFTER_MS
    // Time is up but no newer report has come: still waiting.
    expect(
      withPolicy([run], report("1", chrome), later).state(chromeSubject)
    ).toEqual({ kind: "quitting", force: false })
    const stuck = withPolicy([run], report("2", chrome), later).state(
      chromeSubject
    )
    expect(stuck).toEqual({
      kind: "stuck",
      force: false,
      remaining: [
        { pid: 10, started: "t0" },
        { pid: 11, started: "t0" },
      ],
      note: null,
    })
    // Not stuck before the wait is over, however many reports came.
    expect(
      withPolicy([run], report("2", chrome), later - 1).state(chromeSubject)
        .kind
    ).toBe("quitting")
  })

  it("offers Force quit only for what is still listed", () => {
    const run = quitChrome(report("1", chrome))
    const left = report("2", app("Chrome", [proc(11)]))
    expect(
      withPolicy([run], left, FORCE_AFTER_MS).state(chromeSubject)
    ).toMatchObject({
      kind: "stuck",
      remaining: [{ pid: 11, started: "t0" }],
    })
  })

  it("says so when a Process is still running after Force quit", () => {
    const run = answeredRun(
      2,
      chromeSubject,
      { targets: [{ pid: 10, started: "t0" }] },
      [sent(10)],
      report("1", chrome),
      { force: true }
    )
    expect(
      withPolicy([run], report("2", chrome), FORCE_AFTER_MS).state(
        chromeSubject
      )
    ).toMatchObject({
      kind: "stuck",
      force: true,
      note: {
        tone: "quiet",
        text: "Chrome is still running after Force quit.",
      },
    })
  })

  it("reads a Process whose Quit failed as stuck at once, with the Machine's words", () => {
    const run = answeredRun(
      1,
      process(10),
      { targets: [{ pid: 10, started: "t0" }] },
      [{ pid: 10, result: "failed", started: "t0", message: "Access denied" }],
      report("1", chrome)
    )
    expect(
      withPolicy([run], report("1", chrome), 0).state(process(10))
    ).toEqual({
      kind: "stuck",
      force: false,
      remaining: [{ pid: 10, started: "t0" }],
      note: { tone: "error", text: "Couldn’t quit. Access denied." },
    })
  })

  it("notes Processes that changed or are protected", () => {
    const run = answeredRun(
      1,
      process(10),
      { targets: [{ pid: 10, started: "t0" }] },
      [{ pid: 10, result: "changed", started: "t0" }],
      report("1", chrome)
    )
    expect(
      withPolicy([run], report("1", chrome), 0).state(process(10))
    ).toEqual({
      kind: "idle",
      note: {
        tone: "quiet",
        text: "Not quit: PID 10 now belongs to another Process.",
      },
    })
  })

  it("lets only the latest run for a Process speak: an App run it was in, or its own, whichever is newer", () => {
    const viaApp = quitChrome(report("1", chrome))
    const own = answeredRun(
      2,
      process(10),
      { targets: [{ pid: 10, started: "t0" }] },
      [{ pid: 10, result: "protected", started: "t0" }],
      report("1", chrome)
    )
    const view = withPolicy([viaApp, own], report("2", chrome), 1_000)
    expect(view.state(process(10))).toMatchObject({
      kind: "idle",
      note: { text: "Not quit: it’s protected." },
    })
    // The other Process is only in the App run: quitting, with no note on the row.
    expect(view.state(process(11))).toEqual({ kind: "quitting", force: false })

    const olderOwn = { ...own, id: 0 }
    expect(
      withPolicy([viaApp, olderOwn], report("2", chrome), 1_000).state(
        process(10)
      )
    ).toEqual({ kind: "quitting", force: false })
  })
})

describe("Processes past the 20-row cap", () => {
  // The report lists 20 of Slack's 30 Processes; the server answers for all 30.
  const listed = Array.from({ length: 20 }, (_, i) => proc(100 + i))
  const slack = app("Slack", listed, 30)
  const slackSubject: Subject = { kind: "app", name: "Slack", where: undefined }
  const answers = Array.from({ length: 30 }, (_, i) => sent(100 + i))
  const run = answeredRun(
    1,
    slackSubject,
    { app: "Slack" },
    answers,
    report("1", slack)
  )

  it("keeps waiting out unlisted Processes after the listed ones leave", () => {
    const gone = report("2", app("Slack", [], 10))
    expect(withPolicy([run], gone, 1_000).state(slackSubject)).toEqual({
      kind: "quitting",
      force: false,
    })
  })

  it("counts them as still running after the wait, if the App is still listed with Processes to quit", () => {
    const left = report("2", app("Slack", [proc(130)], 10))
    const state = withPolicy([run], left, FORCE_AFTER_MS).state(slackSubject)
    expect(state.kind).toBe("stuck")
    // Force quit may send every identity the server answered with, listed or not.
    const remaining = state.kind === "stuck" ? state.remaining : []
    expect(remaining.map((t) => t.pid)).toEqual(
      Array.from({ length: 10 }, (_, i) => 120 + i)
    )
    expect(
      withPolicy([run], left, FORCE_AFTER_MS).confirm(
        { subject: slackSubject, force: true, targets: remaining },
        "PC"
      )
    ).toMatchObject({
      asks: 10,
      request: { targets: remaining },
    })
  })

  it("lets the App go idle when it is gone from the reports by then", () => {
    expect(
      withPolicy([run], report("2"), FORCE_AFTER_MS).state(slackSubject)
    ).toEqual({ kind: "idle", note: null })
  })

  it("reads a Process quit on its own as gone once the reports stop listing it", () => {
    const byPid = answeredRun(
      1,
      process(999),
      { targets: [{ pid: 999, started: "t0" }] },
      [sent(999)],
      report("1", slack)
    )
    expect(
      withPolicy([byPid], report("2", slack), 1_000).state(process(999))
    ).toEqual({ kind: "idle", note: null })
  })
})

describe("an App whose name contains a pipe", () => {
  const name = "a|b|wsl|c"
  const piped = app(name, [proc(7)])
  const subject: Subject = { kind: "app", name, where: undefined }
  const insideWsl: Subject = { kind: "app", name, where: "wsl" }

  it("keeps its identity: state and confirmation find exactly that App", () => {
    const run = answeredRun(
      1,
      subject,
      { app: name },
      [sent(7)],
      report("1", piped)
    )
    const view = withPolicy([run], report("2", piped), 1_000)
    expect(view.state(subject)).toEqual({ kind: "quitting", force: false })
    expect(view.state(insideWsl)).toEqual({ kind: "idle", note: null })
    expect(view.state({ kind: "app", name: "a", where: undefined })).toEqual({
      kind: "idle",
      note: null,
    })

    expect(view.confirm({ subject, force: false }, "Mac")).toMatchObject({
      name,
      place: "Mac",
      request: { app: name },
      asks: 1,
    })
    expect(view.confirm({ subject: insideWsl, force: false }, "Mac")).toBeNull()
  })

  it("sends the whole name for a WSL App", () => {
    const wslApp = { ...app("WSL", [], 1), apps: [piped] }
    const view = withPolicy([], report("1", wslApp), 0)
    expect(
      view.confirm({ subject: insideWsl, force: false }, "PC")
    ).toMatchObject({
      name,
      place: "PC (WSL)",
      request: { app: name, where: "wsl" },
    })
  })
})

describe("a Process that restarts with a new pid", () => {
  it("reads the old Process as gone, and its new self as idle", () => {
    const run = answeredRun(
      1,
      process(10),
      { targets: [{ pid: 10, started: "t0" }] },
      [sent(10)],
      report("1", app("Editor", [proc(10)]))
    )
    const restarted = report("2", app("Editor", [proc(42, "t1")]))
    const view = withPolicy([run], restarted, FORCE_AFTER_MS)
    expect(view.state(process(10))).toEqual({ kind: "idle", note: null })
    expect(view.state(process(42, "t1"))).toEqual({ kind: "idle", note: null })
    expect(
      view.confirm({ subject: process(10), force: false }, "Mac")
    ).toBeNull()
    expect(
      view.confirm({ subject: process(42, "t1"), force: false }, "Mac")
    ).toMatchObject({ request: { targets: [{ pid: 42, started: "t1" }] } })
  })

  it("is not mistaken for the Process when the pid is reused", () => {
    const run = answeredRun(
      1,
      process(10),
      { targets: [{ pid: 10, started: "t0" }] },
      [sent(10)],
      report("1", app("Editor", [proc(10)]))
    )
    const reused = report("2", app("Other", [proc(10, "t9")]))
    expect(
      withPolicy([run], reused, FORCE_AFTER_MS).state(process(10))
    ).toEqual({ kind: "idle", note: null })
  })

  it("reads an App Process that came back under the same pid with a new start as gone", () => {
    const run = answeredRun(
      1,
      chromeSubject,
      { app: "Chrome" },
      [sent(10)],
      report("1", chrome)
    )
    // Chrome's pid 10 restarted: it is a different Process now, and nothing to force.
    const after = report("2", app("Chrome", [proc(10, "t5")]))
    const view = withPolicy([run], after, FORCE_AFTER_MS)
    expect(view.state(chromeSubject)).toEqual({ kind: "idle", note: null })
  })
})

describe("the Quit confirmation", () => {
  const ask = (
    subject: Subject,
    force = false,
    targets?: Ask["targets"]
  ): Ask => ({ subject, force, targets })

  it("describes an App from the latest report", () => {
    const view = withPolicy([], report("1", chrome), 0)
    expect(view.confirm(ask(chromeSubject), "Mac")).toMatchObject({
      name: "Chrome",
      place: "Mac",
      count: 2,
      asks: 2,
      request: { app: "Chrome" },
      force: false,
    })
  })

  it("closes when the App or Process leaves, or can no longer be quit", () => {
    expect(
      withPolicy([], report("2"), 0).confirm(ask(chromeSubject), "Mac")
    ).toBeNull()
    const protectedApp = report("1", app("Chrome", [proc(10, "t0", false)]))
    expect(
      withPolicy([], protectedApp, 0).confirm(ask(chromeSubject), "Mac")
    ).toBeNull()
    expect(
      withPolicy([], protectedApp, 0).confirm(ask(process(10)), "Mac")
    ).toBeNull()
  })

  it("asks only for the quittable Processes it can see when some are protected", () => {
    const mixed = report("1", app("Chrome", [proc(10), proc(11, "t0", false)]))
    expect(
      withPolicy([], mixed, 0).confirm(ask(chromeSubject), "Mac")
    ).toMatchObject({ asks: 1 })
  })

  it("offers Force quit only while the row is stuck, for what the row offered", () => {
    const run = quitChrome(report("1", chrome))
    const offered = [{ pid: 11, started: "t0" }]
    const stuck = withPolicy([run], report("2", chrome), FORCE_AFTER_MS)
    expect(
      stuck.confirm(ask(chromeSubject, true, offered), "Mac")
    ).toMatchObject({
      force: true,
      asks: 1,
      request: { targets: offered },
    })
    // Quitting still, or Processes gone: nothing to force.
    expect(
      withPolicy([run], report("2", chrome), 1_000).confirm(
        ask(chromeSubject, true, offered),
        "Mac"
      )
    ).toBeNull()
    expect(
      stuck.confirm(
        ask(chromeSubject, true, [{ pid: 99, started: "t0" }]),
        "Mac"
      )
    ).toBeNull()
  })

  it("never offers more than the server takes in one Quit", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      pid: 1000 + i,
      started: "t0",
    }))
    const big = report("1", app("Big", [proc(1000)], 250))
    const run = answeredRun(
      1,
      { kind: "app", name: "Big", where: undefined },
      { app: "Big" },
      many.map((t) => sent(t.pid)),
      big
    )
    const stuck = withPolicy(
      [run],
      report("2", app("Big", [proc(1000)], 250)),
      FORCE_AFTER_MS,
      7
    )
    const confirmation = stuck.confirm(
      ask({ kind: "app", name: "Big", where: undefined }, true, many),
      "Mac"
    )
    expect(confirmation?.asks).toBe(7)
  })
  it("waits for server policy before offering Force quit", () => {
    const run = quitChrome(report("1", chrome))
    const view = readQuitRuns([run], report("2", chrome), FORCE_AFTER_MS)
    expect(
      view.confirm(
        ask(chromeSubject, true, [{ pid: 10, started: "t0" }]),
        "Mac"
      )
    ).toBeNull()
  })
})
