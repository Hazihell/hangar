import { useEffect, useMemo, useRef, useState } from "react"

import { useMachineCommands } from "@/hooks/use-machine-command"
import { sendQuit, type QuitRequest } from "@/lib/quit"
import { answered, FORCE_AFTER_MS, quitRuns, subjectKey, type Run, type Subject } from "@/lib/quit-runs"
import type { Apps } from "@/lib/types"

/**
 * Sends Quits for one Machine and reads each row's state from the answers and
 * the reports that follow (see `quitRuns`). Each send is a run with its own
 * id; an answer only counts while its run is the Subject's latest.
 */
export function useQuits(machineId: string, apps: Apps | null) {
  const latest = useRef(apps)
  useEffect(() => {
    latest.current = apps
  }, [apps])

  type Input = { subject: Subject; request: QuitRequest; force: boolean }
  const command = useMachineCommands({
    retain: { settleMs: FORCE_AFTER_MS },
    fallback: "The request couldn’t be sent.",
    send: async ({ request, force }: Input) =>
      answered(request, await sendQuit(machineId, request, force), latest.current, Date.now()),
  })

  const runs = useMemo(
    () =>
      Object.values(command.attempts).map((a): Run => {
        const base = { id: a.id, subject: a.input.subject, force: a.input.force, request: a.input.request }
        if (a.phase === "answered" && a.result) return { ...base, phase: "answered", answer: a.result }
        if (a.phase === "refused") return { ...base, phase: "refused", error: a.error ?? "" }
        return { ...base, phase: "sending" }
      }),
    [command.attempts]
  )

  // The wait for Force quit is over once FORCE_AFTER_MS have passed since the answer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const due = runs.flatMap((r) => (r.phase === "answered" ? [r.answer.at + FORCE_AFTER_MS] : [])).filter((at) => at > now)
    if (due.length === 0) return
    const timer = setTimeout(() => setNow(Math.max(Date.now(), Math.min(...due))), Math.max(0, Math.min(...due) - Date.now()))
    return () => clearTimeout(timer)
  }, [runs, now])

  const view = useMemo(() => quitRuns(runs, apps, now), [runs, apps, now])
  const quit = (subject: Subject, request: QuitRequest, force: boolean) =>
    command.run({ subject, request, force }, subjectKey(subject))

  return { ...view, quit }
}
