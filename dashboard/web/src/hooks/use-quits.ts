import { useCallback, useEffect, useRef, useState } from "react"

import { QuitError, sendQuit, targetKey, type QuitRequest, type QuitResult, type QuitTarget } from "@/lib/quit"
import { findApp } from "@/lib/apps"
import type { Apps, Where } from "@/lib/types"

/** A Process still listed this long after Quit was sent is offered Force quit. */
export const FORCE_AFTER_MS = 10_000

/** One Quit (or Force quit) this page sent, for one App or Process. */
type Run = {
  id: number
  force: boolean
  /**
   * What was sent; for an App quit by name, the Processes the server answered
   * for, each with the `pid`, `started` and `where` it gave (known once it
   * answers). These identities, and only these, are what Force quit may send.
   */
  targets: QuitTarget[]
  /** For an App quit by name: which App, to tell if it's still running. */
  app: { name: string; where: Where } | null
  /** Target keys the reports didn't list when the answer came (beyond the 20-row cap). */
  unlisted: Set<string>
  phase: "sending" | "answered" | "refused"
  /** By target key. */
  results: Record<string, QuitResult>
  /** The `apps.at` of the latest report when the answer came. */
  appsAt: string | null
  /** FORCE_AFTER_MS have passed since the answer. */
  ripe: boolean
  error: string | null
}

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

const IDLE: QuitState = { kind: "idle", note: null }

/**
 * Sends Quits for one Machine and works out each row's state from the server's
 * answers and the reports that follow: a Process answered `sent` is quitting
 * until a report stops listing it, and stuck if one still lists it once
 * FORCE_AFTER_MS have passed. Each send is a run with its own id; an answer
 * only counts while its run is the subject's latest.
 */
export function useQuits(machineId: string, apps: Apps | null, present: (key: string) => boolean) {
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const nextId = useRef(0)
  const appsAt = useRef<string | null>(apps?.at ?? null)
  const listed = useRef(present)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    appsAt.current = apps?.at ?? null
    listed.current = present
  }, [apps, present])

  useEffect(() => {
    const t = timers.current
    return () => t.forEach(clearTimeout)
  }, [])

  const later = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      fn()
    }, ms)
    timers.current.add(timer)
  }, [])

  const quit = useCallback(
    async (subject: string, request: QuitRequest, force: boolean) => {
      const id = ++nextId.current
      const patch = (fn: (run: Run) => Run) =>
        setRuns((all) => (all[subject]?.id === id ? { ...all, [subject]: fn(all[subject]) } : all))
      setRuns((all) => ({
        ...all,
        [subject]: {
          id,
          force,
          targets: "targets" in request ? request.targets : [],
          app: "app" in request ? { name: request.app, where: request.where } : null,
          unlisted: new Set(),
          phase: "sending",
          results: {},
          appsAt: null,
          ripe: false,
          error: null,
        },
      }))
      try {
        const answers = await sendQuit(machineId, request, force)
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
        const unlisted = new Set(targets.map(targetKey).filter((key) => !listed.current(key)))
        patch((run) => ({ ...run, phase: "answered", targets, unlisted, results, appsAt: appsAt.current }))
        later(() => patch((run) => ({ ...run, ripe: true })), FORCE_AFTER_MS)
      } catch (error) {
        const message = error instanceof QuitError ? error.message : "The request couldn’t be sent."
        patch((run) => ({ ...run, phase: "refused", error: message }))
      }
    },
    [machineId, later]
  )

  /** The wait is over: FORCE_AFTER_MS have passed and a newer report came. */
  const waited = (run: Run) => run.ripe && apps?.at !== run.appsAt
  /** Still listed in a report that came after the wait. */
  const lingering = (run: Run, key: string) => waited(run) && present(key)

  /** The state of one subject's latest run (an App, or a Process quit on its own). */
  function stateOf(subject: string, label: { one: string; many: string }): QuitState {
    const run = runs[subject]
    if (!run) return IDLE
    if (run.phase === "sending") return { kind: "quitting", force: run.force }
    if (run.phase === "refused") return { kind: "idle", note: { tone: "error", text: `Couldn’t quit. ${run.error}` } }

    const total = run.targets.length
    const sent = run.targets.filter((t) => run.results[targetKey(t)]?.result === "sent")
    const failed = run.targets.map((t) => run.results[targetKey(t)]).filter((r) => r?.result === "failed")
    const skipped = run.targets.filter((t) => {
      const r = run.results[targetKey(t)]?.result
      return r === "changed" || r === "protected"
    })

    let note: Note | null = null
    if (failed.length > 0) {
      const which = total === 1 ? "" : failed.length === total ? ` ${label.many}` : ` ${failed.length} of ${total} Processes`
      const message = failed.find((r) => r?.message)?.message
      note = { tone: "error", text: `Couldn’t quit${which}.${message ? ` ${sentence(message)}` : ""}` }
    } else if (skipped.length > 0) {
      const r = run.results[targetKey(skipped[0])]?.result
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
    const refused = run.targets.filter((t) => run.results[targetKey(t)]?.result === "failed" && present(targetKey(t)))
    const still = sent.filter((t) => present(targetKey(t)))
    // An App's Processes beyond the 20 listed can't be watched leaving: wait
    // out the whole FORCE_AFTER_MS, then count them as running if the App is
    // still listed with Processes that may be quit.
    const hidden = run.app ? sent.filter((t) => run.unlisted.has(targetKey(t)) && !present(targetKey(t))) : []
    if (!waited(run) && (still.length > 0 || hidden.length > 0)) return { kind: "quitting", force: run.force }
    const lingered = still.filter((t) => lingering(run, targetKey(t)))
    const unseen = hidden.length > 0 && run.app && findApp(apps, run.app.name, run.app.where)?.quit ? hidden : []
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
  function processState(subject: string, key: string, name: string): QuitState {
    const own = runs[subject]
    const viaApp = Object.entries(runs)
      .filter(([s, run]) => s !== subject && run.targets.some((t) => targetKey(t) === key))
      .map(([, run]) => run)
      .sort((a, b) => b.id - a.id)[0]
    if (own && (!viaApp || own.id > viaApp.id)) return stateOf(subject, { one: name, many: name })
    if (!viaApp) return IDLE
    if (viaApp.phase === "sending") return { kind: "quitting", force: viaApp.force }
    const result = viaApp.phase === "answered" ? viaApp.results[key]?.result : undefined
    const target = viaApp.targets.find((t) => targetKey(t) === key)
    if (result === "failed" && target && present(key)) return { kind: "stuck", force: viaApp.force, remaining: [target], note: null }
    if (result !== "sent" || !present(key)) return IDLE
    if (!lingering(viaApp, key)) return { kind: "quitting", force: viaApp.force }
    return { kind: "stuck", force: viaApp.force, remaining: [target!], note: null }
  }

  return { quit, stateOf, processState }
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}
