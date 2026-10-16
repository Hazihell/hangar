import { ConnectionState } from "@/components/connection"
import { MachineSheet } from "@/components/machine-sheet"
import { LoadingSheets, StaleNotice, Unreachable } from "@/components/states"
import { Verdict } from "@/components/verdict"
import { useDashboard } from "@/hooks/use-dashboard"
import { useNow } from "@/hooks/use-now"

export default function App() {
  const { connection, machines, skew, lastContact, retry } = useDashboard()
  const now = useNow(skew)

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[78rem] flex-col gap-8 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:gap-10 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.005em]">
          <img src="/icon.svg" alt="" className="size-5 rounded-[5px]" />
          Hangar
        </span>
        <ConnectionState connection={connection} />
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
            {connection === "unreachable" && (
              <StaleNotice heardAt={lastContact === null ? null : lastContact + skew} now={now} onRetry={retry} />
            )}
            <Verdict machines={machines} stale={connection === "unreachable"} />
            <div className="sheets">
              {machines.map((m) => (
                <MachineSheet
                  key={m.id}
                  machine={m}
                  now={now}
                  heardAt={connection === "unreachable" && lastContact !== null ? lastContact + skew : null}
                />
              ))}
            </div>
          </>
        )}
      </main>

      <footer className="mt-auto text-[0.8125rem] text-muted-foreground">
        Online means the Machine reported in the last 30 seconds. History covers the last 24 hours; the grid marks every 3 hours
        and every 25 %.
      </footer>
    </div>
  )
}
