import type { Machine } from "@/lib/types"
import { cn } from "@/lib/utils"

function statusHeadline(machines: Machine[]): string {
  if (machines.length === 0) return "No Machines to show."
  const offline = machines.filter((m) => !m.online)
  if (offline.length === 0) {
    const online =
      machines.length === 1
        ? `${machines[0].name} is Online`
        : machines.length === 2
          ? "Both Machines are Online"
          : `All ${machines.length} Machines are Online`
    return machines.every((m) => m.attention !== undefined)
      ? `${online}. Nothing needs attention.`
      : `${online}.`
  }
  if (offline.length === 1) return `${offline[0].name} is Offline.`
  if (offline.length === machines.length)
    return `All ${machines.length} Machines are Offline.`
  return `${offline.length} of ${machines.length} Machines are Offline.`
}

/** Active conditions come from the same evaluator that sends Alerts. */
export function Verdict({
  machines,
  stale = false,
}: {
  machines: Machine[]
  stale?: boolean
}) {
  const issues = machines.flatMap((machine) =>
    (machine.attention ?? []).map((issue) => ({
      ...issue,
      machineId: machine.id,
    }))
  )
  const first = issues[0]
  return (
    <section
      aria-labelledby="verdict"
      className={cn("flex flex-col gap-3", stale && "opacity-60")}
    >
      <h1
        id="verdict"
        className="max-w-[28ch] text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.012em] text-balance [word-spacing:0.06em] sm:text-[2.25rem]"
      >
        {first?.title ?? statusHeadline(machines)}
      </h1>
      {first && (
        <p className="text-[1.0625rem]">
          <a
            href={`#${first.machineId}`}
            className="decoration-border underline-offset-4 hover:underline"
          >
            {first.body}
          </a>
        </p>
      )}
      {issues.length > 1 && (
        <ul className="flex flex-col gap-1.5 text-[1.0625rem]">
          {issues.slice(1).map((issue) => (
            <li
              key={`${issue.machineId}-${issue.tag}`}
              className="flex items-baseline gap-2.5"
            >
              <span
                aria-hidden
                className="inline-block size-2.5 shrink-0 translate-y-[-0.05em] rounded-full bg-full"
              />
              <a
                href={`#${issue.machineId}`}
                className="decoration-border underline-offset-4 hover:underline"
              >
                <span className="font-semibold">{issue.title}</span>{" "}
                {issue.body}
              </a>
            </li>
          ))}
        </ul>
      )}
      {machines.length === 0 && (
        <p className="text-muted-foreground">
          Machines come from{" "}
          <code className="font-mono text-[0.9em]">
            dashboard/machines.json
          </code>
          .
        </p>
      )}
    </section>
  )
}
