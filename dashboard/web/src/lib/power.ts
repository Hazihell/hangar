import { postCommand } from "@/lib/machine-command"
import type { Power, PowerAction } from "@/lib/types"

/** Said when the server's answer carries no message of its own. */
const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that command.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "The Dashboard can’t put this Machine to sleep or shut it down.",
  409: "Not now: the Machine is Offline, or it’s already going to sleep or shutting down.",
}

/**
 * Asks the server to put a Machine to Sleep or Shut it down (API.md:
 * `POST /api/machines/:id/power`). Resolves with the Machine's new `power` on
 * 202. Throws a MachineCommandError with a sentence to show.
 */
export async function sendPower(machineId: string, action: PowerAction): Promise<Power | null> {
  const res = await postCommand(`/api/machines/${encodeURIComponent(machineId)}/power`, { action }, {
    refusals: REFUSALS, fallback: "The server couldn’t take the command",
  })
  return ((await res.json().catch(() => null)) as Power | null) ?? null
}

export const PENDING_WORDS: Record<PowerAction, string> = {
  sleep: "Going to sleep…",
  shutdown: "Shutting down…",
}
