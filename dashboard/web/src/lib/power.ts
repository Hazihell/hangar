import { JSON_HEADERS, readMessage } from "@/lib/http"
import type { Power, PowerAction } from "@/lib/types"

/** A power command the server refused, or that never reached it. */
export class PowerCommandError extends Error {}

/** Said when the server's answer carries no message of its own. */
const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that command.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "The Dashboard can’t put this Machine to sleep or shut it down.",
  409: "Not now: the Machine is Offline, or it’s already going to sleep or shutting down.",
}

const SEND_MS = 10_000

/**
 * Asks the server to put a Machine to Sleep or Shut it down (API.md:
 * `POST /api/machines/:id/power`). Resolves with the Machine's new `power` on
 * 202. Throws a PowerCommandError with a sentence to show.
 */
export async function sendPower(machineId: string, action: PowerAction): Promise<Power | null> {
  let res: Response
  try {
    res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/power`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(SEND_MS),
    })
  } catch {
    throw new PowerCommandError("Couldn’t reach the server.")
  }
  if (res.ok) return ((await res.json().catch(() => null)) as Power | null) ?? null
  const said = await res.text().then(readMessage, () => null)
  throw new PowerCommandError(said ?? REFUSALS[res.status] ?? `The server couldn’t take the command (HTTP ${res.status}).`)
}

export const PENDING_WORDS: Record<PowerAction, string> = {
  sleep: "Going to sleep…",
  shutdown: "Shutting down…",
}
