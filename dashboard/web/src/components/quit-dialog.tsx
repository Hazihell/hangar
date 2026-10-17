import { useState, type RefObject } from "react"

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
import { formatPercent, formatRam } from "@/lib/format"
import type { Confirmation } from "@/lib/quit-runs"

/**
 * Asks before every Quit and Force quit. The subject is live: when it stops
 * existing (or has nothing left to quit) the parent passes null and the dialog
 * closes; Offline or an unreachable server keeps it open with the button
 * disabled and a line saying why.
 */
export function QuitDialog({
  subject,
  locked,
  onConfirm,
  onClose,
  finalFocus,
}: {
  subject: Confirmation | null
  locked: string | null
  onConfirm: (subject: Confirmation) => void
  onClose: () => void
  finalFocus?: RefObject<HTMLElement | null>
}) {
  // Base UI keeps the popup mounted while it animates out: keep the last words for it.
  const [last, setLast] = useState(subject)
  if (subject !== null && subject !== last) setLast(subject)
  const shown = subject ?? last
  return (
    <AlertDialog open={subject !== null} onOpenChange={(open) => !open && onClose()}>
      {shown && <QuitDialogBody subject={shown} locked={locked} onConfirm={onConfirm} finalFocus={finalFocus} />}
    </AlertDialog>
  )
}

function QuitDialogBody({
  subject,
  locked,
  onConfirm,
  finalFocus,
}: {
  subject: Confirmation
  locked: string | null
  onConfirm: (subject: Confirmation) => void
  finalFocus?: RefObject<HTMLElement | null>
}) {
  const { name, place, force } = subject
  const can = locked === null && subject.asks > 0
  return (
    <AlertDialogContent finalFocus={finalFocus}>
      <AlertDialogHeader className="place-items-start text-left">
        <AlertDialogTitle className="text-lg leading-snug font-semibold tracking-[-0.01em] [word-spacing:0.06em]">
          {force ? "Force quit" : "Quit"} {name} on {place}?
        </AlertDialogTitle>
        <AlertDialogDescription className="text-[0.9375rem] text-pretty">{describe(subject)}</AlertDialogDescription>
      </AlertDialogHeader>
      {locked !== null && (
        <p role="status" className="-mt-1 text-sm text-muted-foreground">
          {locked} Nothing can be quit until that changes.
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel size="lg">Cancel</AlertDialogCancel>
        <AlertDialogAction
          size="lg"
          variant={force ? "destructive" : "default"}
          disabled={!can}
          onClick={() => can && onConfirm(subject)}
        >
          {force ? "Force quit" : "Quit"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

function describe({ name, cpu, ram, count, asks, force }: Confirmation): string {
  const use = `${formatPercent(cpu)} CPU and ${formatRam(ram)}`
  if (force) {
    return asks === 1
      ? `Quit didn’t close it. Force quit ends it at once, without asking: anything unsaved in ${name} is lost.`
      : `Quit didn’t close ${asks} of its Processes. Force quit ends them at once, without asking: anything unsaved in ${name} is lost.`
  }
  if (count <= 1) return `It’s using ${use}. Quit asks it to close cleanly, as closing its window would.`
  return (
    `Its ${count} Processes are using ${use}. ` +
    (asks >= count
      ? "Quit asks each of them to close cleanly, as closing its window would."
      : "Quit asks those it may quit to close cleanly; protected ones stay.")
  )
}
