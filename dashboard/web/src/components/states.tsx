import { RefreshCwIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatRelative } from "@/lib/format"

export function LoadingSheets() {
  return (
    <>
      <section aria-busy className="flex flex-col gap-3">
        <h1 className="sr-only">Reading Machines…</h1>
        <Skeleton className="h-9 w-[min(22rem,80%)] rounded-md" />
      </section>
      <div className="sheets">
        {[0, 1].map((i) => (
          <Card key={i} className="gap-4 rounded-xl bg-card p-5 ring-border sm:p-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-24" />
            {[0, 1, 2].map((j) => (
              <div key={j} className="grid grid-cols-[6.75rem_1fr] gap-4 sm:grid-cols-[8rem_1fr]">
                <Skeleton className="h-12" />
                <Skeleton className="h-14" />
              </div>
            ))}
          </Card>
        ))}
      </div>
    </>
  )
}

/** Nothing loaded yet and the server doesn't answer. */
export function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <section aria-labelledby="verdict" className="flex max-w-xl flex-col gap-4">
      <h1 id="verdict" className="text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.012em] [word-spacing:0.06em] text-balance sm:text-[2.25rem]">
        Can’t reach the Dashboard server.
      </h1>
      <p className="text-[1.0625rem] text-muted-foreground">
        So there’s no word on any Machine yet. The page keeps trying every few seconds; if it stays like this, check that
        Stormtrooper is on and that Tailscale is connected here.
      </p>
      <div>
        <Button variant="outline" size="lg" onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" />
          Try again now
        </Button>
      </div>
    </section>
  )
}

/** Data on screen is from before the connection dropped. */
export function StaleNotice({ heardAt, now, onRetry }: { heardAt: number | null; now: number; onRetry: () => void }) {
  return (
    <Alert className="border-high/40 bg-card">
      <AlertTitle>Can’t reach the Dashboard server</AlertTitle>
      <AlertDescription>
        {heardAt
          ? `What you see is from ${formatRelative(heardAt, now)}. Retrying every few seconds.`
          : "Retrying every few seconds."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  )
}
