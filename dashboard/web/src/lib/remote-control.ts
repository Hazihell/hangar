import { postCommand } from "@/lib/machine-command"
import type { RemoteControl, RemoteControlFolder } from "@/lib/types"

type Action = "add" | "remove"

const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that folder. Its list may have changed.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "This Machine doesn’t serve folders through Remote Control.",
  409: "Not now: the Machine is Offline, or another change is still running.",
}

/**
 * `POST /api/machines/:id/rc`: serves a folder the server offered
 * (`candidates`), or stops serving one it lists (`folders`). Resolves with
 * the Machine's new `remoteControl` on 202. Throws a MachineCommandError with
 * a sentence to show.
 */
export async function sendRemoteControl(machineId: string, action: Action, path: string): Promise<RemoteControl | null> {
  const res = await postCommand(`/api/machines/${encodeURIComponent(machineId)}/rc`, { action, path }, {
    refusals: REFUSALS, fallback: "The server couldn’t take it",
  })
  return ((await res.json().catch(() => null)) as RemoteControl | null) ?? null
}

/** A leading `/home/<user>` or `/Users/<user>` shown as `~`. */
export function shortenHome(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~")
}

/** A folder's path split for reading: the directory it sits in (muted) and its own name. */
export function folderParts(path: string): { dir: string; name: string } {
  const short = shortenHome(path)
  const cut = short.lastIndexOf("/")
  if (cut < 0 || cut === short.length - 1) return { dir: "", name: short }
  return { dir: short.slice(0, cut + 1), name: short.slice(cut + 1) }
}

/** Failing or stopped: the states that need a look. */
export const needsLook = (f: RemoteControlFolder) => f.state === "failing" || f.state === "stopped"

export const STATE_WORDS: Record<RemoteControlFolder["state"], string> = {
  running: "Running",
  starting: "Starting",
  failing: "Failing",
  stopped: "Stopped",
}

export const MODE_WORDS: Record<RemoteControlFolder["mode"], string> = {
  worktree: "own worktree per session",
  "same-dir": "shared folder",
}

/** What the collapsed row says about the folders, when nothing is under way. */
export function summaryOf(rc: RemoteControl): { text: string; bad: boolean } {
  if (rc.checkedAt === null) return { text: "Not checked yet", bad: false }
  const bad = rc.folders.filter(needsLook).length
  if (bad > 0) return { text: `${bad} not running`, bad: true }
  const n = rc.folders.length
  return { text: n === 0 ? "None" : `${n} ${n === 1 ? "folder" : "folders"}`, bad: false }
}
