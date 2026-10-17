import { findApp, indexProcesses, quittable } from "@/lib/apps"
import { targetKey, type QuitRequest, type QuitResult, type QuitTarget } from "@/lib/quit"
import type { Apps, Where } from "@/lib/types"

/** A Process still listed this long after Quit was sent is offered Force quit. */
export const FORCE_AFTER_MS = 10_000

/** The server takes at most this many `targets` in one Quit. */
const MAX_TARGETS = 200

/**
 * What a Quit is about: an App (by name, on the Machine itself or inside WSL)
 * or one Process (by its key, which a reused PID doesn't share).
 */
export type Subject = { kind: "app"; name: string; where: Where } | { kind: "process"; key: string }

/** Identifies a Subject among runs and rows. Opaque: only equality is meant. */
export function subjectKey(subject: Subject): string {
  return JSON.stringify(subject.kind === "app" ? ["app", subject.where ?? "", subject.name] : ["process", subject.key])
}

/** What the server answered, with what the page saw as it came. */
export type Answer = {
  /**
   * What was sent; for an App quit by name, the Processes the server answered
   * for, each with the `pid`, `started` and `where` it gave. These identities,
   * and only these, are what Force quit may send.
   */
  targets: QuitTarget[]
  /** By target key. */
  results: Record<string, QuitResult>
  /** Target keys the report didn't list when the answer came (beyond the 20-row cap). */
  unlisted: Set<string>
  /** The `at` of the latest report when the answer came. */
  reportAt: string | null
  /** When the answer came, in ms. */
  at: number
}

/** One Quit (or Force quit) this page sent, for one Subject; the latest per Subject counts. */
export type Run = {
  id: number
  subject: Subject
  force: boolean
  request: QuitRequest
} & (
  | { phase: "sending" }
  | { phase: "refused"; error: string }
  | { phase: "answered"; answer: Answer }
)

export type Note = { tone: "error" | "quiet"; text: string }

/**
 * Where a Quit stands, for a row:
 * - idle: nothing under way (maybe with a note about the last one)
 * - quitting: sent, waiting for the Process to leave the reports
 * - stuck: still listed FORCE_AFTER_MS later; `remaining` may be Force quit
 */
export type QuitState =
  | { kind: "idle"; note: Note | null }
  | { kind: "quitting"; force: boolean }
  | { kind: "stuck"; force: boolean; remaining: QuitTarget[]; note: Note | null }

/** A confirmation the user is being asked for. */
export type Ask = {
  subject: Subject
  force: boolean
  /** For Force quit of an App: the Processes the row offered. */
  targets?: QuitTarget[]
}

/** What a confirmation is about, read fresh from the latest report. */
export type Confirmation = {
  /** The App's or Process's name. */
  name: string
  /** "Stormtrooper" or "Stormtrooper (WSL)". */
  place: string
  cpu: number
  ram: number
  /** Processes in the App (1 for a Process). */
  count: number
  /** What would be sent. */
  request: QuitRequest
  /** How many Processes it would ask, as far as the page can see. */
  asks: number
  force: boolean
}

export type QuitRuns = {
  /** The state of a row. */
  state(subject: Subject): QuitState
  /** The confirmation for `ask`; null once there is nothing left to ask about. */
  confirm(ask: Ask, machineName: string): Confirmation | null
}

const IDLE: QuitState = { kind: "idle", note: null }

/** The request an `answers` list answers, as the Processes it was about. */
export function answered(request: QuitRequest, answers: QuitResult[], report: Apps | null, at: number): Answer {
  // Processes: one result per target, in order. An App: the server says
  // which Processes it tried, each by the identity it checked; a report
  // that arrived meanwhile may list another Process under the same PID,
  // so nothing here is looked up again.
  const targets: QuitTarget[] =
    "targets" in request
      ? request.targets
      : answers.map((r) => {
          const where = r.where ?? request.where
          return { pid: r.pid, started: r.started ?? "", ...(where ? { where } : {}) }
        })
  const results: Record<string, QuitResult> = {}
  targets.forEach((t, i) => {
    const r = answers[i]
    if (r) results[targetKey(t)] = r
  })
  const index = indexProcesses(report)
  const unlisted = new Set(targets.map(targetKey).filter((key) => !index.has(key)))
  return { targets, results, unlisted, reportAt: report?.at ?? null, at }
}

/**
 * Reads the runs against the latest report, at time `now` (ms): a Process
 * answered `sent` is quitting until a report stops listing it, and stuck if one
 * that came after FORCE_AFTER_MS still lists it. An answer only counts while
 * its run is the Subject's latest.
 */
export function quitRuns(runs: Run[], report: Apps | null, now: number): QuitRuns {
  const index = indexProcesses(report)
  const present = (key: string) => index.has(key)
  const runOf = (subject: Subject) => runs.find((r) => subjectKey(r.subject) === subjectKey(subject))
  const targetsOf = (run: Run): QuitTarget[] =>
    run.phase === "answered" ? run.answer.targets : "targets" in run.request ? run.request.targets : []

  /** The wait is over: FORCE_AFTER_MS have passed and a newer report came. */
  const waited = (answer: Answer) => now - answer.at >= FORCE_AFTER_MS && report?.at !== answer.reportAt
  /** Still listed in a report that came after the wait. */
  const lingering = (answer: Answer, key: string) => waited(answer) && present(key)

  /** The state of one Subject's latest run (an App, or a Process quit on its own). */
  function ownState(run: Run, label: { one: string; many: string }): QuitState {
    if (run.phase === "sending") return { kind: "quitting", force: run.force }
    if (run.phase === "refused") return { kind: "idle", note: { tone: "error", text: `Couldn’t quit. ${run.error}` } }

    const { answer } = run
    const byName = "app" in run.request ? run.request : null
    const total = answer.targets.length
    const resultOf = (t: QuitTarget) => answer.results[targetKey(t)]
    const sent = answer.targets.filter((t) => resultOf(t)?.result === "sent")
    const failed = answer.targets.map(resultOf).filter((r) => r?.result === "failed")
    const skipped = answer.targets.filter((t) => {
      const r = resultOf(t)?.result
      return r === "changed" || r === "protected"
    })

    let note: Note | null = null
    if (failed.length > 0) {
      const which = total === 1 ? "" : failed.length === total ? ` ${label.many}` : ` ${failed.length} of ${total} Processes`
      const message = failed.find((r) => r?.message)?.message
      note = { tone: "error", text: `Couldn’t quit${which}.${message ? ` ${sentence(message)}` : ""}` }
    } else if (skipped.length > 0) {
      const r = resultOf(skipped[0])?.result
      note = {
        tone: "quiet",
        text:
          total === 1
            ? r === "changed"
              ? `Not quit: PID ${skipped[0].pid} now belongs to another Process.`
              : "Not quit: it’s protected."
            : `${skipped.length} of ${total} Processes weren’t quit: they had changed or are protected.`,
      }
    }

    // Quit hasn't worked: it was refused (`failed`), or the Process is still listed after the wait.
    const refused = answer.targets.filter((t) => resultOf(t)?.result === "failed" && present(targetKey(t)))
    const still = sent.filter((t) => present(targetKey(t)))
    // An App's Processes beyond the 20 listed can't be watched leaving: wait
    // out the whole FORCE_AFTER_MS, then count them as running if the App is
    // still listed with Processes that may be quit.
    const hidden = byName ? sent.filter((t) => answer.unlisted.has(targetKey(t)) && !present(targetKey(t))) : []
    if (!waited(answer) && (still.length > 0 || hidden.length > 0)) return { kind: "quitting", force: run.force }
    const lingered = still.filter((t) => lingering(answer, targetKey(t)))
    const unseen = hidden.length > 0 && byName && findApp(report, byName.app, byName.where)?.quit ? hidden : []
    if (refused.length + lingered.length + unseen.length === 0) return { kind: "idle", note }
    return {
      kind: "stuck",
      force: run.force,
      remaining: [...lingered, ...unseen, ...refused].filter((t) => t.started !== ""),
      note: run.force && lingered.length + unseen.length > 0 ? { tone: "quiet", text: `${label.one} is still running after Force quit.` } : note,
    }
  }

  /**
   * A Process row: its own run if it was quit on its own, else whatever App
   * run included it (quitting or stuck only; the App row carries the notes).
   */
  function processState(subject: Subject & { kind: "process" }): QuitState {
    const { key } = subject
    const own = runOf(subject)
    const viaApp = runs
      .filter((r) => r !== own && targetsOf(r).some((t) => targetKey(t) === key))
      .sort((a, b) => b.id - a.id)[0]
    if (own && (!viaApp || own.id > viaApp.id)) {
      const name = index.get(key)?.process.name ?? "It"
      return ownState(own, { one: name, many: name })
    }
    if (!viaApp) return IDLE
    if (viaApp.phase === "sending") return { kind: "quitting", force: viaApp.force }
    if (viaApp.phase === "refused") return IDLE
    const { answer } = viaApp
    const result = answer.results[key]?.result
    const target = answer.targets.find((t) => targetKey(t) === key)
    if (!target) return IDLE
    if (result === "failed" && present(key)) return { kind: "stuck", force: viaApp.force, remaining: [target], note: null }
    if (result !== "sent" || !present(key)) return IDLE
    if (!lingering(answer, key)) return { kind: "quitting", force: viaApp.force }
    return { kind: "stuck", force: viaApp.force, remaining: [target], note: null }
  }

  function state(subject: Subject): QuitState {
    if (subject.kind === "process") return processState(subject)
    const run = runOf(subject)
    return run ? ownState(run, { one: subject.name, many: subject.name }) : IDLE
  }

  function confirm(ask: Ask, machineName: string): Confirmation | null {
    const { subject, force } = ask
    if (subject.kind === "app") {
      const app = findApp(report, subject.name, subject.where)
      if (!app) return null
      const place = `${machineName}${subject.where ? " (WSL)" : ""}`
      const common = { name: app.name, place, cpu: app.cpu, ram: app.ram, count: app.count, force }
      if (force) {
        // Force quit only what didn't close, by the identities the server
        // answered with (some may be beyond the 20 listed here).
        const current = state(subject)
        if (current.kind !== "stuck") return null
        const asked = new Set((ask.targets ?? []).map(targetKey))
        const targets = current.remaining.filter((t) => asked.has(targetKey(t))).slice(0, MAX_TARGETS)
        return targets.length === 0 ? null : { ...common, request: { targets }, asks: targets.length }
      }
      if (!app.quit) return null
      // The server finds all of the App's Processes, beyond the 20 listed here.
      const listed = quittable(app, subject.where).length
      const asks = listed === app.processes.length ? app.count : listed
      return { ...common, request: { app: app.name, ...(subject.where ? { where: subject.where } : {}) }, asks }
    }
    const found = index.get(subject.key)
    if (!found || (!force && !found.process.quit)) return null
    const p = found.process
    const target = { pid: p.pid, started: p.started, ...(found.where ? { where: found.where } : {}) }
    const place = `${machineName}${found.where ? " (WSL)" : ""}`
    return { name: p.name, place, cpu: p.cpu, ram: p.ram, count: 1, request: { targets: [target] }, asks: 1, force }
  }

  return { state, confirm }
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}
