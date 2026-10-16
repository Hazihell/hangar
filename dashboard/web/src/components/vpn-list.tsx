import { useEffect, useRef, useState } from "react"

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
import type { Machine, Vpn, VpnAction, VpnStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { sendVpnCommand, targetOf, VpnCommandError } from "@/lib/vpn"

const STATUS_WORDS: Record<VpnStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting",
  disconnecting: "Disconnecting",
}

const BUSY_WORDS: Record<VpnAction, string> = {
  connect: "Connecting…",
  disconnect: "Disconnecting…",
}

/** The server forgets a command after 90 s; ours lapses a little later. */
const OPTIMISTIC_MS = 100_000
/** How long a refused command's message stays on the row. */
const REFUSAL_MS = 8_000

/** A Machine's VPNs, each with a Connect or Disconnect button. Nothing when it has none. */
export function VpnList({ machine, muted, locked }: {
  machine: Machine
  /** Offline: last known state, greyed like the rest of its Usage. */
  muted: boolean
  /** Why commands can't be sent right now (Offline, server unreachable), else null. */
  locked: string | null
}) {
  if (machine.vpns.length === 0) return null
  return (
    <ul aria-label="VPNs" className="flex flex-col gap-4">
      {machine.vpns.map((vpn) => (
        <VpnRow key={vpn.name} machine={machine} vpn={vpn} muted={muted} locked={locked} />
      ))}
    </ul>
  )
}

/** A command this page sent, until the server takes it over or it ends. */
type Attempt = { id: number; action: VpnAction; errorBefore: string | null }

/**
 * Sends commands for one VPN and works out what's under way: the server's
 * pending command, or, from the click until the server acknowledges it, the
 * one we just sent (optimistic). Each click is an attempt with its own id;
 * a request's failure or a timer only counts while its attempt is current.
 */
function useVpnCommand(machineId: string, vpn: Vpn) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [refusal, setRefusal] = useState<{ id: number; message: string } | null>(null)
  // The last command sent from this page, to say which one an error is about.
  const [last, setLast] = useState<VpnAction | null>(null)
  const nextId = useRef(0)
  // The attempt whose request may still change the row; null once it's retired.
  const current = useRef<number | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const t = timers.current
    return () => t.forEach(clearTimeout)
  }, [])

  // Retired as soon as the server shows it: its own pending command (from then
  // on the server rules, even if it later forgets the command), the target
  // reached, or a new error.
  const retired =
    attempt !== null &&
    (vpn.pending?.action === attempt.action ||
      vpn.status === targetOf(attempt.action) ||
      (vpn.error !== null && vpn.error.at !== attempt.errorBefore))
  if (retired) setAttempt(null)

  useEffect(() => {
    // An attempt retired (or none sent): late answers to it change nothing.
    if (attempt === null) current.current = null
  }, [attempt])

  const pending: VpnAction | null = vpn.pending?.action ?? (retired ? null : (attempt?.action ?? null))

  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      fn()
    }, ms)
    timers.current.add(timer)
  }

  async function run(action: VpnAction) {
    const id = ++nextId.current
    current.current = id
    setRefusal(null)
    setLast(action)
    setAttempt({ id, action, errorBefore: vpn.error?.at ?? null })
    later(() => setAttempt((a) => (a?.id === id ? null : a)), OPTIMISTIC_MS)
    try {
      await sendVpnCommand(machineId, vpn.name, action)
    } catch (error) {
      // Superseded by a newer click, or already settled by the server: ignore.
      if (current.current !== id) return
      current.current = null
      setAttempt((a) => (a?.id === id ? null : a))
      setRefusal({ id, message: error instanceof VpnCommandError ? error.message : "The command couldn’t be sent." })
      later(() => setRefusal((r) => (r?.id === id ? null : r)), REFUSAL_MS)
    }
  }

  const message = refusal?.message ?? vpn.error?.message ?? null
  const error = message && { lead: last ? `Couldn’t ${last}.` : "The last command failed.", message }
  return { pending, error, run }
}

function VpnRow({ machine, vpn, muted, locked }: { machine: Machine; vpn: Vpn; muted: boolean; locked: string | null }) {
  const { pending, error: lastError, run } = useVpnCommand(machine.id, vpn)
  // A new command supersedes the last one's error.
  const error = pending ? null : lastError
  const [confirming, setConfirming] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // On its way: a command is pending, or the operating system says so by itself.
  const busy: VpnAction | null =
    pending ?? (vpn.status === "connecting" ? "connect" : vpn.status === "disconnecting" ? "disconnect" : null)
  const action: VpnAction = vpn.status === "connected" ? "disconnect" : "connect"
  const disabled = locked !== null || busy !== null

  // The confirmation only stands while there is a connected, idle VPN to disconnect;
  // otherwise it's obsolete and closes. Offline or unreachable just holds it.
  const canConfirm = locked === null && busy === null && vpn.status === "connected"
  if (confirming && (busy !== null || vpn.status !== "connected")) setConfirming(false)
  const label = busy ? BUSY_WORDS[busy] : action === "connect" ? "Connect" : "Disconnect"
  const errorId = `${machine.id}-vpn-${vpn.name}-error`.replace(/\s+/g, "-")

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[0.9375rem] font-medium">
          {vpn.name}
          <span className="font-normal text-muted-foreground"> VPN</span>
        </span>
        <span aria-live="polite" className="flex items-center gap-2 text-sm">
          <StatusDot status={vpn.status} muted={muted} />
          <span
            className={cn(
              muted || vpn.status !== "connected" ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {STATUS_WORDS[vpn.status]}
          </span>
        </span>
      </div>

      <Button
        ref={buttonRef}
        variant="outline"
        size="lg"
        disabled={disabled}
        focusableWhenDisabled
        aria-describedby={error ? errorId : undefined}
        onClick={() => {
          if (disabled) return
          if (action === "disconnect") setConfirming(true)
          else void run("connect")
        }}
        className={cn(
          // A steady width so the label can change without the row jumping.
          "relative min-w-[8.75rem] gap-2 px-3 text-sm",
          // Taller hit area for fingers than the 36px it draws.
          "after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
          "data-disabled:pointer-events-none data-disabled:active:translate-y-0",
          busy
            ? "border-dashed bg-transparent text-muted-foreground dark:bg-transparent"
            : "data-disabled:opacity-50"
        )}
      >
        {busy && <BusyDot action={busy} muted={muted} />}
        {label}
        <span className="sr-only"> {vpn.name}</span>
      </Button>

      {error && (
        <p id={errorId} role="status" className={cn("col-span-2 text-[0.8125rem] leading-snug", muted ? "text-muted-foreground" : "text-full")}>
          <span className="font-medium">{error.lead}</span> {error.message}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent finalFocus={buttonRef}>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="text-lg leading-snug font-semibold tracking-[-0.01em] [word-spacing:0.06em]">
              Disconnect {vpn.name} on {machine.name}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[0.9375rem] text-pretty">
              Anything on {machine.name} that goes through {vpn.name} loses its connection until you connect it
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {locked !== null && (
            <p role="status" className="-mt-1 text-sm text-muted-foreground">
              {locked} {vpn.name} can’t be disconnected until that changes.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="lg">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="lg"
              disabled={!canConfirm}
              onClick={() => {
                if (!canConfirm) return
                setConfirming(false)
                void run("disconnect")
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** Filled when Connected, a hollow ring when Disconnected, breathing on its way. */
function StatusDot({ status, muted }: { status: VpnStatus; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "connected" && (muted ? "bg-muted-foreground/60" : "bg-online"),
        status === "disconnected" && "border-[1.5px] border-muted-foreground",
        (status === "connecting" || status === "disconnecting") &&
          "bg-muted-foreground/60 motion-safe:animate-breathe"
      )}
    />
  )
}

/** The pen working: breathes in the ink of where the VPN is heading. */
function BusyDot({ action, muted }: { action: VpnAction; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full motion-safe:animate-breathe",
        action === "connect" && !muted ? "bg-online" : "bg-muted-foreground"
      )}
    />
  )
}
