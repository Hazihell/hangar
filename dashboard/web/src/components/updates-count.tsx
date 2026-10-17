import { ArrowUpCircleIcon } from "lucide-react"

import type { Machine } from "@/lib/types"
import { outOfDate } from "@/lib/updates"

/**
 * How many updates are out across all Machines, quietly in the page header.
 * A link to the first Machine that has some; nothing when there are none.
 */
export function UpdatesCount({ machines }: { machines: Machine[] }) {
  const counts = machines.map((m) => ({ m, n: m.updates?.items.filter(outOfDate).length ?? 0 }))
  const total = counts.reduce((sum, c) => sum + c.n, 0)
  const first = counts.find((c) => c.n > 0)
  if (!first) return null
  const label = `${total} ${total === 1 ? "update" : "updates"}`
  return (
    <a
      href={`#${encodeURIComponent(first.m.id)}`}
      onClick={() => {
        // Same hash again: hashchange won't fire, so ask for the ring ourselves.
        if (location.hash.slice(1) === first.m.id) window.dispatchEvent(new HashChangeEvent("hashchange"))
      }}
      className="relative -my-1 flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground after:absolute after:-inset-y-2 after:inset-x-0 after:content-['']"
    >
      <ArrowUpCircleIcon aria-hidden className="size-4" />
      <span className="tnum">
        {total}
        <span className="max-sm:sr-only"> {total === 1 ? "update" : "updates"}</span>
      </span>
      <span className="sr-only">: {label} available, see {first.m.name}</span>
    </a>
  )
}
