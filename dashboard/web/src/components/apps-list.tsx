import { ArrowDownIcon, ChevronRightIcon } from "lucide-react"
import { createContext, use, useEffect, useId, useRef, useState } from "react"

import { QuitDialog } from "@/components/quit-dialog"
import { Button } from "@/components/ui/button"
import { useQuits } from "@/hooks/use-quits"
import { useStoredFlag } from "@/hooks/use-stored-flag"
import {
  quittable,
  sameOrder,
  SHOWN,
  sortedOrder,
  steadyOrder,
  valueOf,
  type SortBy,
} from "@/lib/apps"
import { formatPercent, formatRam } from "@/lib/format"
import { processKey, type QuitTarget } from "@/lib/quit"
import { subjectKey, type Ask, type QuitState, type Subject } from "@/lib/quit-runs"
import type { App, AppProcess, Machine, Where } from "@/lib/types"
import { cn } from "@/lib/utils"

const MiB = 1024 ** 2

type Section = {
  machine: Machine
  /** What the Machine is using: CPU percent and RAM bytes, the whole an App's bar is a share of. */
  inUse: { cpu: number; ram: number }
  muted: boolean
  locked: string | null
  sortBy: SortBy
  frozen: boolean
  expanded: Set<string>
  toggle: (id: string) => void
  ask: (ask: Ask, from: HTMLElement) => void
  quits: ReturnType<typeof useQuits>
}

const SectionContext = createContext<Section | null>(null)
const useSection = () => use(SectionContext)!

const appSubject = (name: string, where: Where): Subject => ({ kind: "app", name, where })

/**
 * A Machine's Apps, collapsed by default (remembered per Machine): the 10
 * using the most CPU or RAM, each expanding to its Processes, with Quit where
 * the Dashboard may. Nothing when the Machine hasn't sent Processes.
 */
export function AppsSection({ machine, muted, locked }: {
  machine: Machine
  /** Offline: last known Apps, greyed. */
  muted: boolean
  /** Why nothing can be quit right now, else null. */
  locked: string | null
}) {
  const apps = machine.apps
  const [open, setOpen] = useStoredFlag(`hangar:apps-open:${machine.id}`, false)
  const [sortBy, setSortBy] = useState<SortBy>("cpu")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [asking, setAsking] = useState<Ask | null>(null)
  const askedFrom = useRef<HTMLElement | null>(null)
  const listId = useId()

  const quits = useQuits(machine.id, apps)

  // The dialog's subject, from the latest report; null closes it.
  const confirmation = asking ? quits.confirm(asking, machine.name) : null
  // Once there is nothing left to ask about, forget the ask for good, so a
  // later report that brings the App back can't reopen the dialog: nothing
  // cancels the retirement once a render has seen it.
  useEffect(() => {
    if (asking && confirmation === null) queueMicrotask(() => setAsking((now) => (now === asking ? null : now)))
  }, [asking, confirmation])

  if (!apps) return null

  const section: Section = {
    machine,
    inUse: { cpu: machine.usage?.cpu ?? 0, ram: machine.usage?.ram.used ?? 0 },
    muted,
    locked,
    sortBy,
    // Rows hold still while you're pointing at, tabbing through or confirming them.
    frozen: pointerIn || focusIn || asking !== null,
    expanded,
    toggle: (id) =>
      setExpanded((s) => {
        const next = new Set(s)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    ask: (a, from) => {
      askedFrom.current = from
      setAsking(a)
    },
    quits,
  }

  const leaders = sortedOrder(apps.list, (a) => a.cpu)
    .slice(0, 2)
    .map((n) => apps.list.find((a) => a.name === n)!)

  return (
    <SectionContext value={section}>
      <section
        aria-label="Apps"
        className={cn("flex flex-col border-t border-dashed pt-2", muted && "text-muted-foreground")}
        onPointerEnter={(e) => e.pointerType === "mouse" && setPointerIn(true)}
        onPointerLeave={() => setPointerIn(false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocusIn(false)}
      >
        <div className={cn("grid items-center gap-x-3", open && COLUMNS)}>
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
            <span className="font-medium">Apps</span>
            {!open && leaders.length > 0 && (
              <span className="ml-auto min-w-0 truncate pl-3 text-sm text-muted-foreground tnum">
                {leaders.map((a, i) => (
                  <span key={a.name}>
                    {i > 0 && ", "}
                    {a.name} {formatPercent(a.cpu)}
                  </span>
                ))}
                <span className="sr-only"> CPU</span>
              </span>
            )}
          </button>
          {open && (
            <>
              <SortButton by="cpu" label="CPU" sortBy={sortBy} onSort={setSortBy} />
              <SortButton by="ram" label="RAM" sortBy={sortBy} onSort={setSortBy} />
            </>
          )}
        </div>

        <div id={listId} hidden={!open}>
          {open && <AppList apps={apps.list} where={undefined} label={`Apps on ${machine.name}`} />}
        </div>

        <QuitDialog
          subject={confirmation}
          locked={locked}
          finalFocus={askedFrom}
          onClose={() => setAsking(null)}
          onConfirm={(s) => {
            if (!asking) return
            setAsking(null)
            void quits.quit(asking.subject, s.request, s.force)
          }}
        />
      </section>
    </SectionContext>
  )
}

/** Name | CPU | RAM, shared by the header and every App row. */
const COLUMNS = "grid-cols-[minmax(0,1fr)_3.25rem_4.5rem]"
/**
 * Process rows: on a phone, name and action, then pid · CPU · RAM beneath;
 * from 40rem, pid and name | CPU | RAM | action.
 */
const PROCESS_COLUMNS = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_3rem_4.25rem_5.5rem]"

function SortButton({ by, label, sortBy, onSort }: { by: SortBy; label: string; sortBy: SortBy; onSort: (by: SortBy) => void }) {
  const active = by === sortBy
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSort(by)}
      className={cn(
        "relative flex min-h-11 items-center justify-end gap-0.5 rounded-md text-[0.8125rem]",
        active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <span className="sr-only">Sort by </span>
      {active && <ArrowDownIcon aria-hidden className="size-3" />}
      {label}
    </button>
  )
}

/** Up to 10 Apps in a steady order: re-sorted only on clear overtakes, and not at all while you're in it. */
function AppList({ apps, where, label }: { apps: App[]; where: Where; label: string }) {
  const { sortBy, frozen } = useSection()
  const value = (a: App) => valueOf(a, sortBy)
  const [order, setOrder] = useState(() => sortedOrder(apps, value))
  const [orderedBy, setOrderedBy] = useState(sortBy)

  const next =
    orderedBy !== sortBy
      ? sortedOrder(apps, value)
      : steadyOrder(order, apps, value, sortBy === "cpu" ? 0.5 : 48 * MiB, frozen)
  if (orderedBy !== sortBy) setOrderedBy(sortBy)
  if (!sameOrder(next, order)) setOrder(next)

  const byName = new Map(apps.map((a) => [a.name, a]))
  const shown = next
    .map((n) => byName.get(n))
    .filter((a): a is App => a !== undefined)
    .slice(0, SHOWN)

  return (
    <ul aria-label={label} className="flex flex-col">
      {shown.map((app) => (
        <AppRow key={app.name} app={app} where={where} />
      ))}
    </ul>
  )
}

function AppRow({ app, where }: { app: App; where: Where }) {
  const { machine, inUse, muted, sortBy, expanded, toggle, quits } = useSection()
  const subject = appSubject(app.name, where)
  const id = subjectKey(subject)
  const open = expanded.has(id)
  const panelId = useId()
  const state = quits.state(subject)
  const whole = sortBy === "cpu" ? inUse.cpu : inUse.ram
  const share = whole > 0 ? Math.min(100, (valueOf(app, sortBy) / whole) * 100) : 0
  const isWsl = app.apps !== undefined

  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => toggle(id)}
        className={cn("group/app -mx-1.5 grid min-h-11 items-center gap-x-3 rounded-md px-1.5 py-1.5 text-left", COLUMNS)}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover/app:text-foreground",
                open && "rotate-90"
              )}
            />
            <span className="truncate text-[0.9375rem]">{app.name}</span>
            {app.count > 1 && <span className="shrink-0 text-[0.8125rem] text-muted-foreground tnum">×{app.count}</span>}
            {state.kind !== "idle" && (
              <span className="shrink-0 truncate text-[0.8125rem] text-muted-foreground">
                {state.kind === "quitting" ? "· quitting…" : "· still running"}
              </span>
            )}
          </span>
          {/* Its share of what the Machine is using, in the sorted channel's ink: a miniature drive meter. */}
          <span aria-hidden className="ml-5 h-[3px] max-w-40 rounded-full bg-grid">
            <span
              className={cn(
                "block h-full rounded-full transition-[width] duration-200",
                muted ? "bg-muted-foreground/40" : sortBy === "cpu" ? "bg-ink-cpu" : "bg-ink-ram"
              )}
              style={{ width: `${share}%` }}
            />
          </span>
        </span>
        <Figure value={formatPercent(app.cpu)} active={sortBy === "cpu"} />
        <Figure value={formatRam(app.ram)} active={sortBy === "ram"} />
        <span className="sr-only">{isWsl ? ", inside: Apps in WSL" : ""}</span>
      </button>

      <div id={panelId} hidden={!open}>
        {open &&
          (isWsl ? (
            <Nested>
              <p className="pt-1 pb-0.5 text-[0.8125rem] text-muted-foreground">Apps inside WSL</p>
              <AppList apps={app.apps ?? []} where="wsl" label={`Apps inside WSL on ${machine.name}`} />
            </Nested>
          ) : (
            <Nested>
              <ProcessList app={app} where={where} state={state} />
            </Nested>
          ))}
      </div>
    </li>
  )
}

function Nested({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 ml-[0.4rem] flex flex-col border-l pl-2.5 sm:pl-3">{children}</div>
}

function Figure({ value, active, suffix, compact = false }: { value: string; active: boolean; suffix?: string; compact?: boolean }) {
  const { muted } = useSection()
  return (
    <span className={cn("text-right tnum", compact ? "text-xs sm:text-sm" : "text-sm", active && !muted ? "text-foreground" : "text-muted-foreground")}>
      {value}
      {suffix && <span className="sm:sr-only">{suffix}</span>}
    </span>
  )
}

function ProcessList({ app, where, state }: { app: App; where: Where; state: QuitState }) {
  const { machine, locked, muted, ask } = useSection()
  const subject = appSubject(app.name, where)
  const more = app.count - app.processes.length
  const canQuit = quittable(app, where).length

  return (
    <>
      <ul aria-label={`${app.name} Processes`} className="flex flex-col">
        {app.processes.map((p) => (
          <ProcessRow key={`${p.pid}|${p.started}`} process={p} where={where} />
        ))}
      </ul>
      {more > 0 && (
        <p className="py-1 text-[0.8125rem] text-muted-foreground">
          and {more} more {more === 1 ? "Process" : "Processes"}, using less
        </p>
      )}

      {app.quit ? (
        <div className="flex flex-col gap-1.5 pt-1.5 pb-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[0.8125rem] text-muted-foreground">
              {app.count === 1
                ? "1 Process"
                : app.count > app.processes.length
                  ? `${app.count} Processes`
                  : canQuit === app.count
                    ? `All ${app.count} Processes`
                    : `${canQuit} of ${app.count} Processes can be quit`}
            </span>
            <QuitControl
              state={state}
              name={app.name}
              disabled={locked !== null}
              muted={muted}
              onQuit={(from) => ask({ subject, force: false }, from)}
              onForce={(targets, from) => ask({ subject, force: true, targets }, from)}
              label={`Quit ${app.name}`}
              size="default"
            />
          </div>
          <NoteLine note={"note" in state ? state.note : null} muted={muted} />
        </div>
      ) : (
        <p className="pt-1 pb-1.5 text-[0.8125rem] text-pretty text-muted-foreground">
          Protected: it isn’t yours, or {machine.name} or the Dashboard depends on it, so it can’t be quit from here.
        </p>
      )}
    </>
  )
}

function ProcessRow({ process: p, where }: { process: AppProcess; where: Where }) {
  const { sortBy, locked, muted, quits, ask } = useSection()
  const key = processKey(where, p.pid, p.started)
  const subject: Subject = { kind: "process", key }
  const state = quits.state(subject)
  const note = "note" in state ? state.note : null

  return (
    <li className={cn("grid min-h-9 items-center gap-x-3 py-1 sm:py-0", PROCESS_COLUMNS)}>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="hidden shrink-0 text-xs text-muted-foreground tnum sm:inline">{p.pid}</span>
        <span className="truncate text-sm" title={p.name}>
          {p.name}
        </span>
      </span>
      <span className="col-span-full row-start-2 flex gap-3 text-xs text-muted-foreground tnum sm:contents">
        <span className="sm:hidden">PID {p.pid}</span>
        <Figure value={formatPercent(p.cpu)} active={sortBy === "cpu"} suffix=" CPU" compact />
        <Figure value={formatRam(p.ram)} active={sortBy === "ram"} compact />
      </span>
      <span className="col-start-2 row-start-1 flex justify-end sm:col-start-auto sm:row-start-auto">
        {p.quit || state.kind !== "idle" ? (
          <QuitControl
            state={state}
            name={`${p.name}, PID ${p.pid}`}
            disabled={locked !== null}
            muted={muted}
            onQuit={(from) => ask({ subject, force: false }, from)}
            onForce={(_targets, from) => ask({ subject, force: true }, from)}
            label="Quit"
            size="sm"
            subtle
          />
        ) : (
          <span
            className="cursor-default text-xs text-muted-foreground/80"
            title="Protected: not yours, or the Machine or the Dashboard depends on it."
          >
            Protected
          </span>
        )}
      </span>
      {note && (
        <span className="col-span-full pb-1">
          <NoteLine note={note} muted={muted} />
        </span>
      )}
    </li>
  )
}

/** Quit, then "Quitting…" while it closes, then Force quit if it doesn't. */
function QuitControl({
  state,
  name,
  disabled,
  muted,
  onQuit,
  onForce,
  label,
  size,
  subtle = false,
}: {
  state: QuitState
  name: string
  disabled: boolean
  muted: boolean
  onQuit: (from: HTMLElement) => void
  onForce: (targets: QuitTarget[], from: HTMLElement) => void
  label: string
  size: "sm" | "default"
  subtle?: boolean
}) {
  if (state.kind === "quitting") {
    return (
      <span role="status" className="flex items-center gap-1.5 text-[0.8125rem] whitespace-nowrap text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground motion-safe:animate-breathe" />
        {state.force ? "Force quitting…" : "Quitting…"}
        <span className="sr-only"> {name}</span>
      </span>
    )
  }
  const force = state.kind === "stuck"
  return (
    <Button
      variant={force || !subtle ? "outline" : "ghost"}
      size={size}
      disabled={disabled}
      focusableWhenDisabled
      onClick={(e) => {
        if (disabled) return
        if (state.kind === "stuck") onForce(state.remaining, e.currentTarget)
        else onQuit(e.currentTarget)
      }}
      className={cn(
        "relative whitespace-nowrap",
        "after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        subtle && !force && "-mr-2 text-muted-foreground hover:text-foreground",
        muted && "text-muted-foreground"
      )}
    >
      {force ? (
        <>
          Force quit<span className="sr-only"> {name}</span>
        </>
      ) : (
        <>
          {label}
          {label === "Quit" && <span className="sr-only"> {name}</span>}
        </>
      )}
    </Button>
  )
}

function NoteLine({ note, muted }: { note: { tone: "error" | "quiet"; text: string } | null; muted: boolean }) {
  if (!note) return null
  return (
    <p
      role="status"
      className={cn(
        "text-[0.8125rem] leading-snug text-pretty",
        note.tone === "error" && !muted ? "text-full" : "text-muted-foreground"
      )}
    >
      {note.text}
    </p>
  )
}
