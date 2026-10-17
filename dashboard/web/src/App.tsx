import { useEffect, useState } from "react"

import { AlertsControl } from "@/components/alerts-control"
import { ConnectionState } from "@/components/connection"
import { MachineSheet } from "@/components/machine-sheet"
import { LoadingSheets, PowerAway, StaleNotice, Unreachable } from "@/components/states"
import { Verdict } from "@/components/verdict"
import { useDashboard } from "@/hooks/use-dashboard"
import { useNow } from "@/hooks/use-now"
import { useShownMachine } from "@/hooks/use-shown-machine"
import type { PowerAction } from "@/lib/types"

/**
 * A Sleep or Shut down this page sent, until it's settled: the connection
 * dropped and came back, the server showed it pending and then not, the server
 * reported an error, or SENT_MS passed with none of that.
 */
type Sent = {
  id: string
  action: PowerAction
  /** Our clock. */
  at: number
  errorBefore: string | null
  seenPending: boolean
  dropped: boolean
}

/** A command nothing confirmed is forgotten after this (the server gives up at 2 min). */
const SENT_MS = 3 * 60_000

export default function App() {
  const { connection, machines, skew, lastContact, retry, watchClosely } = useDashboard()
  const now = useNow(skew)
  const shown = useShownMachine(machines !== null)
  const [sent, setSent] = useState<Sent | null>(null)

  // The Dashboard runs on the Machine it puts to sleep: the connection dropping
  // while that's under way (or just sent) means it went, not that something broke.
  const down = connection === "reconnecting" || connection === "unreachable"
  const sentTo = sent ? machines?.find((m) => m.id === sent.id) : undefined
  const sentPending = sentTo?.power?.pending?.action === sent?.action
  if (sent && down && !sent.dropped) setSent({ ...sent, dropped: true })
  else if (sent && !down && sentPending && !sent.seenPending) setSent({ ...sent, seenPending: true })
  else if (
    sent &&
    !down &&
    // Back after the drop; or it slept and woke too briefly for us to notice;
    // or the server said it didn't happen; or nothing ever confirmed it.
    ((sent.dropped && connection === "live") ||
      (sent.seenPending && !sentPending) ||
      (sentTo?.power?.error && sentTo.power.error.at !== sent.errorBefore) ||
      (!sent.dropped && now - skew - sent.at > SENT_MS))
  ) {
    setSent(null)
  }
  const pendingOn = machines?.find((m) => m.power?.pending)
  const watching = pendingOn !== undefined || sent !== null
  useEffect(() => watchClosely(watching), [watchClosely, watching])
  const away = !down
    ? null
    : pendingOn
      ? { id: pendingOn.id, name: pendingOn.name, action: pendingOn.power!.pending!.action }
      : sent && sentTo
        ? { id: sentTo.id, name: sentTo.name, action: sent.action }
        : null

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[78rem] flex-col gap-8 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:gap-10 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.005em]">
          <img src="/icon.svg" alt="" className="size-5 rounded-[5px]" />
          Hangar
        </span>
        <div className="flex items-center gap-3 sm:gap-4">
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
            {away ? (
              <PowerAway name={away.name} action={away.action} heardAt={lastContact === null ? null : lastContact + skew} now={now} />
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
                  away={away?.id === m.id ? away.action : null}
                  onPowerSent={(action) =>
                    setSent({
                      id: m.id,
                      action,
                      at: Date.now(),
                      errorBefore: m.power?.error?.at ?? null,
                      seenPending: false,
                      dropped: false,
                    })
                  }
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
