import { useRef, useState } from "react"

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
import { useMachineCommand } from "@/hooks/use-machine-command"
import type { Machine, Vpn, VpnAction, VpnStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { sendVpnCommand, targetOf } from "@/lib/vpn"

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

/** Tracks one VPN command until its Machine event shows pending, success or failure. */
function useVpnCommand(machine: Machine, vpn: Vpn) {
  const [last, setLast] = useState<VpnAction | null>(null)
  const command = useMachineCommand({
    send: (action: VpnAction) => sendVpnCommand(machine.id, vpn.name, action),
    seen: (action) => vpn.pending?.action === action || vpn.status === targetOf(action),
    errorAt: vpn.error?.at,
    fallback: "The command couldn’t be sent.",
    optimisticMs: machine.limits?.vpnMs ?? null,
  })
  const message = command.refusal?.message ?? vpn.error?.message ?? null
  return {
    pending: vpn.pending?.action ?? command.pending,
    error: message && { lead: last ? `Couldn’t ${last}.` : "The last command failed.", message },
    run: (action: VpnAction) => { setLast(action); return command.run(action) },
  }
}

function VpnRow({ machine, vpn, muted, locked }: { machine: Machine; vpn: Vpn; muted: boolean; locked: string | null }) {
  const { pending, error: lastError, run } = useVpnCommand(machine, vpn)
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
