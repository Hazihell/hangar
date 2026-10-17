import { MachineCommandError, postCommand } from "@/lib/machine-command"
import type { Where } from "@/lib/types"

import type {
  QuitResponse,
  QuitSelection as QuitRequest,
  QuitResult,
  QuitTarget,
} from "@/lib/types"

export type {
  QuitTarget,
  QuitResult,
  QuitOutcome,
  QuitSelection as QuitRequest,
} from "@/lib/types"

const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that request.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "The Dashboard has no way to reach this Machine.",
  409: "Not now: the Machine is Offline.",
}

/**
 * Asks the server to Quit (or, with `force`, Force quit) Processes once.
 * Resolves with one result per Process, in order. Throws a MachineCommandError with a
 * sentence to show.
 */
export async function sendQuit(
  machineId: string,
  request: QuitRequest,
  force: boolean
): Promise<QuitResult[]> {
  const res = await postCommand(
    `/api/machines/${encodeURIComponent(machineId)}/quit`,
    { ...request, force },
    {
      refusals: REFUSALS,
      fallback: "The server couldn’t take the request",
      timeout: 15_000,
    }
  )
  const body = (await res.json().catch(() => null)) as QuitResponse | null
  if (Array.isArray(body?.results)) return body.results
  throw new MachineCommandError("The server’s answer couldn’t be read.")
}

/** Identifies one Process across reports: a reused PID gets a new `started`. */
export function processKey(where: Where, pid: number, started: string): string {
  return `${where ?? ""}|${pid}|${started}`
}

export function targetKey(t: QuitTarget): string {
  return processKey(t.where, t.pid, t.started)
}
