import { MoonIcon, PowerIcon } from "lucide-react"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useMachineCommand } from "@/hooks/use-machine-command"
import { PENDING_WORDS, sendPower } from "@/lib/power"
import type { Machine, PowerAction } from "@/lib/types"
import { cn } from "@/lib/utils"

const VERBS: Record<PowerAction, string> = { sleep: "put it to sleep", shutdown: "shut it down" }

export type PowerState = {
  /** Going to sleep or shutting down: the server's pending command, or the one we just sent. */
  pending: PowerAction | null
  /** The last command's failure, as a sentence. */
  error: string | null
  run: (action: PowerAction) => Promise<void>
}

/** Tracks Sleep or Shut down until its Machine event shows the command. */
export function usePower(machine: Machine, onSent?: (action: PowerAction) => void): PowerState {
  const power = machine.power
  const command = useMachineCommand({
    send: (action: PowerAction) => sendPower(machine.id, action),
    seen: (action) => power?.pending?.action === action,
    errorAt: power?.error?.at,
    fallback: "The command couldn’t be sent.",
    onSent,
  })
  const pending = power?.pending?.action ?? command.pending
  const failed = command.refusal
    ? `Couldn’t ${VERBS[command.refusal.input]}. ${command.refusal.message}`
    : power?.error ? sentenceAbout(machine.name, power.error.message, lastAction(power.error.message)) : null
  return { pending, error: pending ? null : failed, run: command.run }
}

/** The server's own message names the Machine; a bare one gets a lead. */
function sentenceAbout(name: string, message: string, action: PowerAction | null): string {
  const text = message.trim()
  const said = /[.!?]$/.test(text) ? text : `${text}.`
  if (text.startsWith(name)) return said
  return `${action ? `Couldn’t ${VERBS[action]}.` : "The last power command failed."} ${said}`
}

function lastAction(message: string): PowerAction | null {
  return /shut/i.test(message) ? "shutdown" : /sleep/i.test(message) ? "sleep" : null
}

/**
 * The Power button in a sheet's header: a menu of Sleep and Shut down, each
 * confirmed first, because the Dashboard itself runs on this Machine.
 */
export function PowerMenu({
  machine,
  state,
  locked,
  describedBy,
}: {
  machine: Machine
  state: PowerState
  /** Why commands can't be sent right now (Offline, server unreachable), else null. */
  locked: string | null
  describedBy?: string
}) {
  const [asking, setAsking] = useState<PowerAction | null>(null)
  // Keeps the dialog's words while it animates closed.
  const [shown, setShown] = useState<PowerAction>("sleep")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const actions = machine.power?.actions ?? []
  const busy = state.pending !== null
  const disabled = locked !== null || busy

  // A command started elsewhere makes the question obsolete.
  if (asking && busy) setAsking(null)
  const canConfirm = locked === null && !busy

  const ask = (action: PowerAction) => {
    setShown(action)
    setAsking(action)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={triggerRef}
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              focusableWhenDisabled
              aria-describedby={describedBy}
              className={cn(
                "relative -my-1.5 -mr-1.5 text-muted-foreground hover:text-foreground",
                "after:absolute after:-inset-1.5 after:content-['']",
                "data-disabled:opacity-50"
              )}
            />
          }
        >
          <PowerIcon aria-hidden />
          <span className="sr-only">Sleep or Shut down {machine.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          {actions.includes("sleep") && (
            <DropdownMenuItem className="min-h-10 gap-2.5 px-2.5 text-[0.9375rem]" onClick={() => ask("sleep")}>
              <MoonIcon aria-hidden />
              Sleep
            </DropdownMenuItem>
          )}
          {actions.includes("shutdown") && (
            <DropdownMenuItem className="min-h-10 gap-2.5 px-2.5 text-[0.9375rem]" onClick={() => ask("shutdown")}>
              <PowerIcon aria-hidden />
              Shut down
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent finalFocus={triggerRef}>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="text-lg leading-snug font-semibold tracking-[-0.01em] [word-spacing:0.06em]">
              {shown === "sleep" ? `Put ${machine.name} to sleep?` : `Shut down ${machine.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2 text-[0.9375rem] text-pretty">
              {shown === "sleep" ? (
                <>
                  <span>
                    The Dashboard runs on {machine.name}, so this page goes quiet too. WSL, T3 and the agents pause
                    until it wakes.
                  </span>
                  <span>Wake it with Alexa; this page reconnects on its own.</span>
                </>
              ) : (
                <>
                  <span>
                    The Dashboard runs on {machine.name}, so this page goes away too. WSL, T3 and the agents stop, and
                    whatever they were doing ends. An app with unsaved work can stop Shut down; if one does, it shows
                    here.
                  </span>
                  <span>Turn it back on with Alexa; this page reconnects on its own.</span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {locked !== null && (
            <p role="status" className="-mt-1 text-sm text-muted-foreground">
              {locked} It can’t be {shown === "sleep" ? "put to sleep" : "shut down"} until that changes.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="lg">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="lg"
              disabled={!canConfirm}
              onClick={() => {
                if (!canConfirm || asking === null) return
                const action = asking
                setAsking(null)
                void state.run(action)
              }}
            >
              {shown === "sleep" ? "Sleep" : "Shut down"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Under the sheet's status: "Going to sleep…" while it's under way, or why the last command failed. */
export function PowerLine({ id, state, muted }: { id: string; state: PowerState; muted: boolean }) {
  if (state.pending) {
    return (
      <p id={id} role="status" className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground motion-safe:animate-breathe" />
        {PENDING_WORDS[state.pending]}
      </p>
    )
  }
  if (state.error) {
    return (
      <p id={id} role="status" className={cn("text-[0.8125rem] leading-snug", muted ? "text-muted-foreground" : "text-full")}>
        {state.error}
      </p>
    )
  }
  return null
}
