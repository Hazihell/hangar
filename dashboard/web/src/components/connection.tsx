import type { Connection } from "@/hooks/use-dashboard"
import { cn } from "@/lib/utils"

const LABELS: Record<Connection, string> = {
  loading: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  unreachable: "Not connected",
}

/** Whether the page is receiving updates. Quiet when live. */
export function ConnectionState({ connection }: { connection: Connection }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          connection === "live" && "bg-online",
          connection === "reconnecting" && "bg-high",
          connection === "loading" && "bg-muted-foreground/50",
          connection === "unreachable" && "border-[1.5px] border-muted-foreground"
        )}
      />
      {LABELS[connection]}
    </p>
  )
}
