import { ChevronRightIcon } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useStoredFlag } from "@/hooks/use-stored-flag"
import { formatAbsolute, formatRelative } from "@/lib/format"
import type { Machine, T3Thread, Update, Updates } from "@/lib/types"
import {
  checkNow,
  fetchT3Threads,
  inSendOrder,
  outOfDate,
  runsDashboard,
  sendUpdate,
  UpdateCommandError,
  updatable,
  versions,
} from "@/lib/updates"
import { cn } from "@/lib/utils"

/** After the server takes a command, how long we wait for its event to show it. */
const ACK_GRACE_MS = 5_000
/** How long a refused command's message stays. */
const REFUSAL_MS = 8_000

type Attempt = { id: number; items: string[]; errorBefore: string | null }

/**
 * Sends updates for one Machine and works out what's under way: the server's
 * pending update, or, from the click until the server shows it, ours.
 */
function useUpdateCommand(machine: Machine, updates: Updates, onSent?: (items: string[]) => void) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [refusal, setRefusal] = useState<{ id: number; message: string } | null>(null)
  const nextId = useRef(0)
  const timers = useLater()

  const retired =
    attempt !== null &&
    (updates.pending !== null || (updates.error !== null && updates.error.at !== attempt.errorBefore))
  if (retired) setAttempt(null)

  async function run(items: string[]) {
    const id = ++nextId.current
    setRefusal(null)
    setAttempt({ id, items, errorBefore: updates.error?.at ?? null })
    try {
      await sendUpdate(machine.id, items)
      onSent?.(items)
      timers.later(() => setAttempt((a) => (a?.id === id ? null : a)), ACK_GRACE_MS)
    } catch (error) {
      setAttempt((a) => (a?.id === id ? null : a))
      if (nextId.current !== id) return
      setRefusal({ id, message: error instanceof UpdateCommandError ? error.message : "The update couldn’t be sent." })
      timers.later(() => setRefusal((r) => (r?.id === id ? null : r)), REFUSAL_MS)
    }
  }

  const pending = updates.pending?.items ?? (retired ? null : (attempt?.items ?? null))
  const error = pending ? null : (refusal?.message ?? updates.error?.message ?? null)
  return { pending, since: updates.pending?.since ?? null, error, run }
}

/** "Check now": checking from the click until the server says it is (or a moment passes). */
function useCheck(machine: Machine, updates: Updates) {
  const [sent, setSent] = useState<number | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const nextId = useRef(0)
  const timers = useLater()
  if (sent !== null && updates.checking) setSent(null)

  async function run() {
    const id = ++nextId.current
    setRefusal(null)
    setSent(id)
    try {
      await checkNow(machine.id)
      timers.later(() => setSent((s) => (s === id ? null : s)), ACK_GRACE_MS)
    } catch (error) {
      setSent((s) => (s === id ? null : s))
      setRefusal(error instanceof UpdateCommandError ? error.message : "The check couldn’t be started.")
      timers.later(() => setRefusal(null), REFUSAL_MS)
    }
  }
  return { checking: updates.checking || sent !== null, refusal, run }
}

function useLater() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const t = timers.current
    return () => t.forEach(clearTimeout)
  }, [])
  return {
    later(fn: () => void, ms: number) {
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        fn()
      }, ms)
      timers.current.add(timer)
    },
  }
}

/**
 * A Machine's Updates: a disclosure row saying how many tools are out of
 * date, opening to each one's current and latest version, with Update, Update
 * all and Check now. Every update asks first.
 */
export function UpdatesSection({
  machine,
  now,
  muted,
  locked,
  onSent,
}: {
  machine: Machine
  now: number
  muted: boolean
  /** Why commands can't be sent right now (Offline, server unreachable), else null. */
  locked: string | null
  /** The server took an update for this Machine. */
  onSent?: (items: string[]) => void
}) {
  const updates = machine.updates
  if (!updates) return null
  return <UpdatesBody machine={machine} updates={updates} now={now} muted={muted} locked={locked} onSent={onSent} />
}

function UpdatesBody({
  machine,
  updates,
  now,
  muted,
  locked,
  onSent,
}: {
  machine: Machine
  updates: Updates
  now: number
  muted: boolean
  locked: string | null
  onSent?: (items: string[]) => void
}) {
  const [open, setOpen] = useStoredFlag(`hangar:updates-open:${machine.id}`, false)
  const command = useUpdateCommand(machine, updates, onSent)
  const check = useCheck(machine, updates)
  const [asking, setAsking] = useState<string[] | null>(null)
  const askedFrom = useRef<HTMLElement | null>(null)
  const listId = useId()

  const items = [...updates.items].sort((a, b) => Number(outOfDate(b)) - Number(outOfDate(a)))
  const count = updates.items.filter(outOfDate).length
  const ready = inSendOrder(updates.items.filter(updatable).map((u) => u.id))
  const busy = command.pending !== null
  const disabled = locked !== null || busy

  // The dialog reads its items fresh; once none can be updated, or an update starts, it closes.
  const asked = asking ? asking.map((id) => updates.items.find((u) => u.id === id)).filter((u) => u && updatable(u)) as Update[] : []
  if (asking && (asked.length === 0 || busy)) setAsking(null)

  const ask = (ids: string[], from: HTMLElement) => {
    askedFrom.current = from
    setAsking(ids)
  }

  const summary = busy ? (
    <BusyText>Updating…</BusyText>
  ) : check.checking ? (
    <BusyText>Checking…</BusyText>
  ) : command.error ? (
    <span className={muted ? "" : "text-full"}>Update failed</span>
  ) : updates.checkedAt === null ? (
    "Not checked yet"
  ) : count > 0 ? (
    `${count} ${count === 1 ? "update" : "updates"}`
  ) : (
    "Up to date"
  )

  return (
    <section aria-label="Updates" className={cn("flex flex-col border-t border-dashed pt-2", muted && "text-muted-foreground")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 flex min-h-11 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[0.9375rem]"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")}
        />
        <span className="font-medium">Updates</span>
        <span
          className={cn(
            "ml-auto min-w-0 truncate pl-3 text-sm",
            count > 0 && !busy && !check.checking && !command.error && !muted ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {summary}
        </span>
      </button>

      <div id={listId} hidden={!open} className="flex flex-col gap-3 pt-1 pb-1">
        {open && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                {check.checking ? (
                  <BusyText>Checking for updates…</BusyText>
                ) : updates.checkedAt ? (
                  <span>
                    Checked{" "}
                    <time dateTime={updates.checkedAt} title={formatAbsolute(Date.parse(updates.checkedAt))}>
                      {formatRelative(Date.parse(updates.checkedAt), now)}
                    </time>
                  </span>
                ) : (
                  <span>Not checked yet</span>
                )}
                <span aria-hidden>·</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked !== null || check.checking}
                  focusableWhenDisabled
                  onClick={() => void check.run()}
                  className="relative -my-1 h-7 px-1.5 text-sm font-normal text-foreground after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] data-disabled:opacity-50"
                >
                  Check now
                </Button>
              </p>
              {ready.length > 1 && (
                <Button
                  variant="outline"
                  size="lg"
                  disabled={disabled}
                  focusableWhenDisabled
                  onClick={(e) => !disabled && ask(ready, e.currentTarget)}
                  className="relative min-w-[8.75rem] px-3 text-sm after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] data-disabled:opacity-50"
                >
                  Update all
                  <span className="sr-only"> on {machine.name}</span>
                </Button>
              )}
            </div>

            {check.refusal && <p role="status" className="text-[0.8125rem] leading-snug text-full">Couldn’t check. {check.refusal}</p>}

            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                Updating {listNames(command.pending!.map((id) => updates.items.find((u) => u.id === id)?.name ?? id))}
                {command.since && <> · started {formatRelative(Date.parse(command.since), now)}</>}. It can take a few
                minutes.
              </p>
            )}
            {command.error && (
              <p role="status" className={cn("text-[0.8125rem] leading-snug", muted ? "text-muted-foreground" : "text-full")}>
                <span className="font-medium">Couldn’t update.</span> {sentence(command.error)}
              </p>
            )}

            <ul aria-label={`Updates on ${machine.name}`} className="flex flex-col">
              {items.map((u) => (
                <UpdateRow
                  key={u.id}
                  update={u}
                  machine={machine}
                  updating={command.pending?.includes(u.id) ?? false}
                  disabled={disabled}
                  muted={muted}
                  onUpdate={(from) => ask([u.id], from)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <UpdateDialog
        machine={machine}
        items={asked}
        open={asking !== null}
        locked={locked}
        finalFocus={askedFrom}
        onClose={() => setAsking(null)}
        onConfirm={(ids) => {
          setAsking(null)
          void command.run(ids)
        }}
      />
    </section>
  )
}

function UpdateRow({
  update: u,
  machine,
  updating,
  disabled,
  muted,
  onUpdate,
}: {
  update: Update
  machine: Machine
  updating: boolean
  disabled: boolean
  muted: boolean
  onUpdate: (from: HTMLElement) => void
}) {
  const v = versions(u)
  return (
    <li className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border/60 py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col">
        <span className={cn("truncate text-[0.9375rem]", u.available ? "font-medium" : "text-muted-foreground")}>{u.name}</span>
        <span className="text-[0.8125rem] text-muted-foreground tnum">
          {u.available ? (
            <>
              {v.from} <span aria-label="to">→</span>{" "}
              <span className={muted ? "" : "text-foreground"}>{v.to ?? "unknown"}</span>
              {v.behind && <> · {v.behind}</>}
            </>
          ) : u.current === null ? (
            "Version unknown"
          ) : (
            <>{v.from} · up to date</>
          )}
        </span>
      </div>
      {updating ? (
        <BusyText className="text-sm">Updating…</BusyText>
      ) : u.available && u.blocked === null ? (
        <Button
          variant="outline"
          disabled={disabled}
          focusableWhenDisabled
          onClick={(e) => !disabled && onUpdate(e.currentTarget)}
          className="relative px-3 text-sm after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] data-disabled:opacity-50"
        >
          Update<span className="sr-only"> {u.name} on {machine.name}</span>
        </Button>
      ) : null}
      {u.available && u.blocked !== null && (
        <p className="col-span-2 text-[0.8125rem] leading-snug text-muted-foreground">
          <span className="sr-only">Can’t update {u.name} from here: </span>
          <Code text={u.blocked} />
        </p>
      )}
    </li>
  )
}

/** A reason with `backticks` shows those parts as code. */
function Code({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded-sm bg-muted px-1 py-px font-mono text-[0.75rem] text-foreground">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function BusyText({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-muted-foreground", className)}>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground motion-safe:animate-breathe" />
      {children}
    </span>
  )
}

type Threads = { state: "loading" } | { state: "done"; threads: T3Thread[] | null }

/**
 * Asks before updating: what changes, and what it disturbs (T3's running
 * threads, the Dashboard restarting, sessions keeping their version).
 */
function UpdateDialog({
  machine,
  items,
  open,
  locked,
  finalFocus,
  onClose,
  onConfirm,
}: {
  machine: Machine
  items: Update[]
  open: boolean
  locked: string | null
  finalFocus: React.RefObject<HTMLElement | null>
  onClose: () => void
  onConfirm: (ids: string[]) => void
}) {
  // Keeps the last words while it animates closed.
  const [shown, setShown] = useState<Update[]>(items)
  if (open && items.length > 0 && items !== shown && !sameIds(items, shown)) setShown(items)
  const list = open && items.length > 0 ? items : shown
  const ids = list.map((u) => u.id)
  const hasT3 = open && ids.includes("t3")

  const [threads, setThreads] = useState<Threads>({ state: "loading" })
  useEffect(() => {
    if (!hasT3) return
    const controller = new AbortController()
    fetchT3Threads(machine.id, controller.signal).then(
      (t) => setThreads({ state: "done", threads: t }),
      () => !controller.signal.aborted && setThreads({ state: "done", threads: null })
    )
    return () => {
      controller.abort()
      setThreads({ state: "loading" })
    }
  }, [hasT3, machine.id])

  const single = list.length === 1
  const has = (id: string) => ids.includes(id)
  const sessions = list.filter((u) => u.id === "claude" || u.id === "codex").map((u) => u.name)

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent
        finalFocus={finalFocus}
        // One column that can't be widened by a long thread title; tall lists scroll.
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md"
      >
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="text-lg leading-snug font-semibold tracking-[-0.01em] [word-spacing:0.06em]">
            {single ? `Update ${list[0]?.name} on ${machine.name}?` : `Install ${list.length} updates on ${machine.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[0.9375rem] text-pretty">
            {single ? (
              <>
                From <span className="tnum">{list[0]?.current ?? "an unknown version"}</span> to{" "}
                <span className="tnum">{list[0]?.latest ?? "the latest"}</span>. It can take a few minutes.
              </>
            ) : (
              "In this order. It can take a few minutes."
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="-mt-1 flex flex-col gap-3 text-[0.9375rem] text-muted-foreground">
          {!single && (
            <ul className="flex flex-col gap-1">
              {inSendOrder(ids).map((id) => {
                const u = list.find((x) => x.id === id)!
                return (
                  <li key={id} className="flex items-baseline justify-between gap-4">
                    <span className="font-medium text-foreground">{u.name}</span>
                    <span className="text-sm tnum">
                      {u.current ?? "?"} → {u.latest ?? "?"}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {has("t3") && <T3Note threads={threads} />}
          {has("hangar") &&
            (runsDashboard(machine) ? (
              <p>
                Updating Hangar restarts the Dashboard on {machine.name}{single ? "" : ", last"}. This page loses its
                connection for a moment and reconnects on its own.
              </p>
            ) : (
              <p>Updating Hangar restarts {machine.name}’s reporter, so its Usage pauses for a moment.</p>
            ))}
          {sessions.length > 0 && (
            <p>
              {listNames(sessions)} sessions already running keep their version until they’re restarted.
            </p>
          )}
          {locked !== null && (
            <p role="status" className="text-sm">
              {locked} Nothing can be updated until that changes.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel size="lg">Cancel</AlertDialogCancel>
          <AlertDialogAction
            size="lg"
            disabled={locked !== null || !open || items.length === 0}
            onClick={() => {
              if (locked !== null || items.length === 0) return
              onConfirm(inSendOrder(items.map((u) => u.id)))
            }}
          >
            {single ? "Update" : "Update all"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function T3Note({ threads }: { threads: Threads }) {
  const lead = "Updating T3 Code restarts the T3 server, which interrupts running agent threads."
  if (threads.state === "loading") {
    return (
      <p>
        {lead} <BusyText>Looking for running threads…</BusyText>
      </p>
    )
  }
  if (threads.threads === null) {
    return <p>{lead} Which ones couldn’t be read, so check T3 first if anything might be running.</p>
  }
  if (threads.threads.length === 0) return <p>{lead} None are running now.</p>
  const n = threads.threads.length
  return (
    <div className="flex flex-col gap-1.5">
      <p>
        {lead} {n === 1 ? "This one is" : `These ${n} are`} running now:
      </p>
      <ul className="flex flex-col gap-2 rounded-md border border-border/70 px-3 py-2">
        {threads.threads.map((t, i) => (
          <li key={i} className="flex min-w-0 flex-col">
            <span className="line-clamp-2 font-medium break-words text-foreground">{t.title || "Untitled thread"}</span>
            <span className="text-sm">{STATUS_WORDS[t.status] ?? t.status}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STATUS_WORDS: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  waiting: "Waiting for an answer",
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

function sameIds(a: Update[], b: Update[]) {
  return a.length === b.length && a.every((u, i) => u.id === b[i].id)
}
