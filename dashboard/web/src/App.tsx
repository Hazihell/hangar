import { useEffect, useState } from "react"

import { AlertsControl } from "@/components/alerts-control"
import { ConnectionState } from "@/components/connection"
import { MachineSheet } from "@/components/machine-sheet"
import { LoadingSheets, PowerAway, Restarting, StaleNotice, Unreachable } from "@/components/states"
import { UpdatesCount } from "@/components/updates-count"
import { Verdict } from "@/components/verdict"
import { useDashboard } from "@/hooks/use-dashboard"
import { useNow } from "@/hooks/use-now"
import { useShownMachine } from "@/hooks/use-shown-machine"
import type { Machine, PowerAction } from "@/lib/types"
import { runsDashboard } from "@/lib/updates"

/**
 * What can take the Dashboard away with it: a Sleep or Shut down of the
 * Machine it runs on, or a Hangar update there (which restarts it).
 */
type Going = PowerAction | "restart"

/**
 * One of those this page sent, until it's settled: the connection dropped and
 * came back, the server showed it pending and then not, the server reported
 * an error, or `limit` passed with none of that.
 */
type Sent = {
  id: string
  going: Going
  /** Our clock. */
  at: number
  errorBefore: string | null
  seenPending: boolean
  dropped: boolean
}

/** A command nothing confirmed is forgotten after this (the server gives up at 2 min, or 15 for an update). */
const LIMIT_MS: Record<Going, number> = { sleep: 3 * 60_000, shutdown: 3 * 60_000, restart: 17 * 60_000 }

/** Whether the server shows it under way on that Machine. */
function pendingOf(m: Machine | undefined, going: Going): boolean {
  if (!m) return false
  if (going === "restart") return m.updates?.pending?.items.includes("hangar") ?? false
  return m.power?.pending?.action === going
}

const errorOf = (m: Machine | undefined, going: Going) =>
  (going === "restart" ? m?.updates?.error?.at : m?.power?.error?.at) ?? null

export default function App() {
  const { connection, machines, skew, lastContact, build, retry, watchClosely } = useDashboard()
  const now = useNow(skew)
  const shown = useShownMachine(machines !== null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [reload, setReload] = useState(false)

  // The Dashboard runs on the PC: the connection dropping while it's going to
  // sleep, shutting down or restarting after an update (or one was just sent)
  // means it went, not that something broke.
  const down = connection === "reconnecting" || connection === "unreachable"
  const sentTo = sent ? machines?.find((m) => m.id === sent.id) : undefined
  const sentPending = sent !== null && pendingOf(sentTo, sent.going)
  if (sent && down && !sent.dropped) setSent({ ...sent, dropped: true })
  else if (sent && !down && sentPending && !sent.seenPending) setSent({ ...sent, seenPending: true })
  else if (
    sent &&
    !down &&
    // Back after the drop; or it went and came back too briefly for us to
    // notice; or the server said it failed; or nothing ever confirmed it.
    ((sent.dropped && connection === "live") ||
      (sent.seenPending && !sentPending) ||
      (errorOf(sentTo, sent.going) !== null && errorOf(sentTo, sent.going) !== sent.errorBefore) ||
      (!sent.dropped && now - skew - sent.at > LIMIT_MS[sent.going]))
  ) {
    setSent(null)
    // Back from restarting after an update: load the new Dashboard. A server
    // that names its build does this for every tab (useDashboard); this is for one that doesn't.
    if (sent.going === "restart" && sent.dropped && connection === "live" && build === null) setReload(true)
  }
  useEffect(() => {
    if (reload) window.location.reload()
  }, [reload])

  const powerOn = machines?.find((m) => m.power?.pending)
  const restartOn = machines?.find((m) => runsDashboard(m) && pendingOf(m, "restart"))
  const watching = powerOn !== undefined || restartOn !== undefined || sent !== null
  useEffect(() => watchClosely(watching), [watchClosely, watching])
  const away: { id: string; name: string; going: Going } | null = !down
    ? null
    : powerOn
      ? { id: powerOn.id, name: powerOn.name, going: powerOn.power!.pending!.action }
      : restartOn
        ? { id: restartOn.id, name: restartOn.name, going: "restart" }
        : sent && sentTo
          ? { id: sentTo.id, name: sentTo.name, going: sent.going }
          : null
  const send = (m: Machine, going: Going) =>
    setSent({ id: m.id, going, at: now - skew, errorBefore: errorOf(m, going), seenPending: false, dropped: false })

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[78rem] flex-col gap-8 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:gap-10 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.005em]">
          <img src="/icon.svg" alt="" className="size-5 rounded-[5px]" />
          Hangar
        </span>
        <div className="flex items-center gap-3 sm:gap-4">
          {machines && <UpdatesCount machines={machines} />}
          <AlertsControl />
          <ConnectionState connection={connection} />
        </div>
      </header>

      <main className="flex flex-col gap-8 sm:gap-10">
        {machines === null ? (
          connection === "unreachable" ? (
            <Unreachable onRetry={retry} />
          ) : (
            <LoadingSheets />
          )
        ) : (
          <>
            {away?.going === "restart" ? (
              <Restarting name={away.name} heardAt={lastContact === null ? null : lastContact + skew} now={now} />
            ) : away ? (
              <PowerAway name={away.name} action={away.going} heardAt={lastContact === null ? null : lastContact + skew} now={now} />
            ) : (
              <>
                {connection === "unreachable" && (
                  <StaleNotice heardAt={lastContact === null ? null : lastContact + skew} now={now} onRetry={retry} />
                )}
                <Verdict machines={machines} stale={connection === "unreachable"} />
              </>
            )}
            <div className="sheets">
              {machines.map((m) => (
                <MachineSheet
                  key={m.id}
                  machine={m}
                  now={now}
                  heardAt={connection === "unreachable" && lastContact !== null ? lastContact + skew : null}
                  highlighted={shown === m.id}
                  away={away?.id === m.id && away.going !== "restart" ? away.going : null}
                  onPowerSent={(action) => send(m, action)}
                  onUpdateSent={(items) => {
                    if (items.includes("hangar") && runsDashboard(m)) send(m, "restart")
                  }}
                />
              ))}
            </div>
          </>
        )}
      </main>

      <footer className="mt-auto text-[0.8125rem] text-muted-foreground">
        Online means the Machine reported in the last 30 seconds. History covers the last 24 hours; the grid marks every 3 hours
        and every 25 %. Tap or click a trace to see that minute’s Top Apps.
      </footer>
    </div>
  )
}
