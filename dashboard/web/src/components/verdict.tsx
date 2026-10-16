import { PenMark } from "@/components/status"
import { formatPercent, levelOf, percent } from "@/lib/format"
import type { Machine } from "@/lib/types"
import { cn } from "@/lib/utils"

type Issue = {
  machineId: string
  kind: "offline" | "full" | "stopped"
  text: React.ReactNode
}

/** What needs attention, most important first. High (80 %+) is not an issue. */
function findIssues(machines: Machine[]): Issue[] {
  const offline: Issue[] = []
  const rest: Issue[] = []
  for (const m of machines) {
    if (!m.online) {
      offline.push({
        machineId: m.id,
        kind: "offline",
        text: m.lastSeen ? `${m.name} is Offline.` : `${m.name} is Offline and has never reported.`,
      })
    }
    const usage = m.usage
    if (!usage) continue
    for (const d of usage.disks) {
      const p = percent(d.used, d.total)
      if (levelOf(p) === "full") {
        rest.push({
          machineId: m.id,
          kind: "full",
          text: (
            <>
              {d.name} on {m.name} is <span className="font-semibold text-full">{formatPercent(p)}</span> full.
            </>
          ),
        })
      }
    }
    const ram = percent(usage.ram.used, usage.ram.total)
    if (m.online && levelOf(ram) === "full") {
      rest.push({
        machineId: m.id,
        kind: "full",
        text: (
          <>
            RAM on {m.name} is <span className="font-semibold text-full">{formatPercent(ram)}</span> used.
          </>
        ),
      })
    }
    if (m.online && usage.services?.t3 === false) {
      rest.push({ machineId: m.id, kind: "stopped", text: `The T3 service on ${m.name} is stopped.` })
    }
  }
  const rank = { full: 0, stopped: 1, offline: 2 } as const
  return [...rest, ...offline].sort((a, b) => rank[a.kind] - rank[b.kind])
}

function allOnline(machines: Machine[]): string {
  const n = machines.length
  return n === 1 ? `${machines[0].name} is Online` : n === 2 ? "Both Machines are Online" : `All ${n} Machines are Online`
}

/**
 * The headline: the worst problem first. An Offline Machine is often just a
 * laptop asleep, so it leads only when nothing worse is going on.
 */
function headline(machines: Machine[], issues: Issue[]): { title: React.ReactNode; rest: Issue[] } {
  if (machines.length === 0) return { title: "No Machines to show.", rest: [] }
  const offline = machines.filter((m) => !m.online)
  const worst = issues[0]
  if (worst && worst.kind !== "offline") return { title: worst.text, rest: issues.slice(1) }
  if (offline.length === 0) return { title: `${allOnline(machines)}. Nothing needs attention.`, rest: [] }
  const n = machines.length
  const title =
    offline.length === n
      ? n === 1
        ? `${machines[0].name} is Offline.`
        : `All ${n} Machines are Offline.`
      : offline.length === 1
        ? `${offline[0].name} is Offline.`
        : offline.length === 2
          ? `${offline[0].name} and ${offline[1].name} are Offline.`
          : `${offline.length} of ${n} Machines are Offline.`
  return { title, rest: [] }
}

/** The answer to "is everything OK?", in one sentence and a short list. */
export function Verdict({ machines, stale = false }: { machines: Machine[]; stale?: boolean }) {
  const issues = findIssues(machines)
  const { title, rest: listed } = headline(machines, issues)

  return (
    <section aria-labelledby="verdict" className={cn("flex flex-col gap-3", stale && "opacity-60")}>
      <h1
        id="verdict"
        className="max-w-[28ch] text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.012em] [word-spacing:0.06em] text-balance sm:text-[2.25rem]"
      >
        {title}
      </h1>
      {listed.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-[1.0625rem]">
          {listed.map((issue, i) => (
            <li key={i} className="flex items-baseline gap-2.5">
              <IssueMark kind={issue.kind} />
              <a
                href={`#${issue.machineId}`}
                className={cn("decoration-border underline-offset-4 hover:underline", issue.kind === "offline" && "text-muted-foreground")}
              >
                {issue.text}
              </a>
            </li>
          ))}
        </ul>
      )}
      {machines.length === 0 && (
        <p className="text-muted-foreground">
          Machines come from <code className="font-mono text-[0.9em]">dashboard/machines.json</code>.
        </p>
      )}
    </section>
  )
}

function IssueMark({ kind }: { kind: Issue["kind"] }) {
  if (kind === "offline") return <PenMark online={false} className="translate-y-[-0.05em]" />
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 translate-y-[-0.05em] rounded-full", kind === "full" ? "bg-full" : "bg-high")}
    />
  )
}
