import { ChevronRightIcon, PlusIcon } from "lucide-react"
import { useId, useRef, useState } from "react"

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
import { useStoredFlag } from "@/hooks/use-stored-flag"
import {
  folderParts,
  MODE_WORDS,
  needsLook,
  sendRemoteControl,
  STATE_WORDS,
  summaryOf,
} from "@/lib/remote-control"
import type { Machine, RemoteControl, RemoteControlFolder } from "@/lib/types"
import { cn } from "@/lib/utils"

type Change = { action: "add" | "remove"; path: string }

/** Stands in for the pending add or remove until its Machine event arrives. */
function useRemoteControlCommand(machine: Machine, rc: RemoteControl) {
  const [last, setLast] = useState<Change["action"] | null>(null)
  const command = useMachineCommand({
    send: (change: Change) => sendRemoteControl(machine.id, change.action, change.path),
    seen: (change) => rc.pending?.action === change.action && rc.pending.path === change.path,
    fallback: "The change couldn’t be sent.",
  })
  const pending = rc.pending ?? command.pending
  const message = command.refusal?.message ?? rc.error
  return {
    pending,
    error: pending || !message ? null : { lead: last ? `Couldn’t ${last} the folder.` : "The last change failed.", message },
    run: (change: Change) => {
      setLast(change.action)
      return command.run(change)
    },
  }
}

/**
 * The folders Claude's Remote Control serves on a Machine, so the Claude app
 * can start sessions there: a disclosure row saying how many, opening to each
 * folder with Remove (which always asks) and an Add folder menu of the
 * repositories on offer.
 */
export function RemoteControlSection({
  machine,
  muted,
  locked,
}: {
  machine: Machine
  muted: boolean
  /** Why commands can't be sent right now (Offline, server unreachable), else null. */
  locked: string | null
}) {
  const rc = machine.remoteControl
  if (!rc) return null
  return <RemoteControlBody machine={machine} rc={rc} muted={muted} locked={locked} />
}

function RemoteControlBody({ machine, rc, muted, locked }: { machine: Machine; rc: RemoteControl; muted: boolean; locked: string | null }) {
  const [open, setOpen] = useStoredFlag(`hangar:rc-open:${machine.id}`, false)
  const command = useRemoteControlCommand(machine, rc)
  const [asking, setAsking] = useState<string | null>(null)
  // Keeps the dialog's words while it animates closed.
  const [shown, setShown] = useState("")
  const askedFrom = useRef<HTMLElement | null>(null)
  const listId = useId()

  const busy = command.pending !== null
  const disabled = locked !== null || busy
  const summary = summaryOf(rc)

  // Once the folder is gone, or something else is under way, the question is obsolete.
  const asked = asking !== null && rc.folders.some((f) => f.path === asking)
  if (asking !== null && (!asked || busy)) setAsking(null)

  const ask = (path: string, from: HTMLElement) => {
    askedFrom.current = from
    setShown(path)
    setAsking(path)
  }

  const words = busy ? (
    <BusyText>{command.pending!.action === "add" ? "Adding…" : "Removing…"}</BusyText>
  ) : command.error ? (
    <span className={muted ? "" : "text-full"}>Change failed</span>
  ) : (
    <span className={summary.bad && !muted ? "text-full" : ""}>{summary.text}</span>
  )

  const addingPath = command.pending?.action === "add" ? command.pending.path : null
  const removingPath = command.pending?.action === "remove" ? command.pending.path : null

  return (
    <section aria-label="Remote Control" className={cn("flex flex-col border-t border-dashed pt-2", muted && "text-muted-foreground")}>
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
        <span className="font-medium">Remote Control</span>
        <span
          className={cn(
            "ml-auto min-w-0 truncate pl-3 text-sm",
            summary.bad && !busy && !command.error && !muted ? "" : "text-muted-foreground"
          )}
        >
          {words}
        </span>
      </button>

      <div id={listId} hidden={!open} className="flex flex-col gap-3 pt-1 pb-1">
        {open && (
          <>
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {addingPath ? "Adding" : "Removing"} {folderParts(command.pending!.path).name}. It can take a few seconds.
              </p>
            )}
            {command.error && (
              <p role="status" className={cn("text-[0.8125rem] leading-snug", muted ? "text-muted-foreground" : "text-full")}>
                <span className="font-medium">{command.error.lead}</span> {sentence(command.error.message)}
              </p>
            )}

            {rc.checkedAt === null ? (
              <p className="text-sm text-muted-foreground">Not checked yet: the server hasn’t read this Machine’s folders.</p>
            ) : rc.folders.length === 0 && addingPath === null ? (
              <p className="text-sm text-muted-foreground">No folders yet. Add one to start Claude sessions there from the app.</p>
            ) : (
              <ul aria-label={`Remote Control folders on ${machine.name}`} className="flex flex-col">
                {rc.folders.map((folder) => (
                  <FolderRow
                    key={folder.path}
                    folder={folder}
                    machine={machine}
                    removing={removingPath === folder.path}
                    disabled={disabled}
                    muted={muted}
                    onRemove={(from) => ask(folder.path, from)}
                  />
                ))}
                {addingPath !== null && !rc.folders.some((f) => f.path === addingPath) && (
                  <li className="grid min-h-12 grid-cols-[minmax(0,1fr)] items-center border-t border-border/60 py-2 first:border-t-0">
                    <PathText path={addingPath} />
                    <BusyText className="text-[0.8125rem]">Adding…</BusyText>
                  </li>
                )}
              </ul>
            )}

            {rc.checkedAt !== null && (
              <AddFolder
                machine={machine}
                candidates={rc.candidates.filter((p) => !rc.folders.some((f) => f.path === p))}
                disabled={disabled}
                adding={addingPath !== null}
                onAdd={(path) => void command.run({ action: "add", path })}
              />
            )}
          </>
        )}
      </div>

      <AlertDialog open={asking !== null} onOpenChange={(next) => !next && setAsking(null)}>
        <AlertDialogContent finalFocus={askedFrom}>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="text-lg leading-snug font-semibold tracking-[-0.01em] [word-spacing:0.06em]">
              Remove {folderParts(shown).name} from Remote Control?
            </AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2 text-[0.9375rem] text-pretty">
              <span className="font-medium break-words [overflow-wrap:anywhere] text-foreground">{folderParts(shown).dir}{folderParts(shown).name}</span>
              <span>
                Claude sessions running there on {machine.name} will stop responding. Claude can bring them back for about
                four hours if you add the folder again.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {locked !== null && (
            <p role="status" className="-mt-1 text-sm text-muted-foreground">
              {locked} Nothing can be removed until that changes.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="lg">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="lg"
              disabled={locked !== null || busy || asking === null}
              onClick={() => {
                if (locked !== null || busy || asking === null) return
                const path = asking
                setAsking(null)
                void command.run({ action: "remove", path })
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function FolderRow({
  folder,
  machine,
  removing,
  disabled,
  muted,
  onRemove,
}: {
  folder: RemoteControlFolder
  machine: Machine
  removing: boolean
  disabled: boolean
  muted: boolean
  onRemove: (from: HTMLElement) => void
}) {
  const look = needsLook(folder) && !muted
  return (
    <li className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border/60 py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col">
        <PathText path={folder.path} />
        <span className="flex flex-wrap items-center gap-x-3 text-[0.8125rem] text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1.5", look && "font-medium text-full")}>
            <StateDot state={folder.state} muted={muted} />
            {STATE_WORDS[folder.state]}
          </span>
          <span>{MODE_WORDS[folder.mode]}</span>
        </span>
      </div>
      {removing ? (
        <BusyText className="text-sm">Removing…</BusyText>
      ) : (
        <Button
          variant="outline"
          disabled={disabled}
          focusableWhenDisabled
          onClick={(e) => !disabled && onRemove(e.currentTarget)}
          className="relative px-3 text-sm after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] data-disabled:opacity-50"
        >
          Remove<span className="sr-only"> {folderParts(folder.path).name} on {machine.name}</span>
        </Button>
      )}
    </li>
  )
}

/** The directory muted, the folder's own name as the thing to read. */
function PathText({ path }: { path: string }) {
  const { dir, name } = folderParts(path)
  return (
    <span className="text-[0.9375rem] [overflow-wrap:anywhere]" title={path}>
      <span className="text-muted-foreground">{dir}</span>
      <span className="font-medium">{name}</span>
    </span>
  )
}

/** The repositories the server offers, in a menu; picking one adds it without asking. */
function AddFolder({
  machine,
  candidates,
  disabled,
  adding,
  onAdd,
}: {
  machine: Machine
  candidates: string[]
  disabled: boolean
  adding: boolean
  onAdd: (path: string) => void
}) {
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">No other repositories to add.</p>
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="lg"
            disabled={disabled}
            focusableWhenDisabled
            className="relative w-fit min-w-[8.75rem] gap-2 px-3 text-sm after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] data-disabled:opacity-50"
          />
        }
      >
        <PlusIcon aria-hidden />
        {adding ? "Adding…" : "Add folder"}
        <span className="sr-only"> on {machine.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--available-height))] w-auto max-w-[calc(100vw-2rem)] min-w-64">
        {candidates.map((path) => (
          <DropdownMenuItem key={path} className="min-h-10 px-2.5 text-[0.9375rem]" onClick={() => onAdd(path)}>
            <PathText path={path} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Filled green when running, breathing while starting, the bad-state colour otherwise. */
function StateDot({ state, muted }: { state: RemoteControlFolder["state"]; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "running" && (muted ? "bg-muted-foreground/60" : "bg-online"),
        state === "starting" && "bg-muted-foreground/60 motion-safe:animate-breathe",
        (state === "failing" || state === "stopped") && (muted ? "border-[1.5px] border-muted-foreground" : "bg-full")
      )}
    />
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

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}
