import type { VpnAction, VpnStatus } from "@/lib/types"

/** A VPN command the server refused, or that never reached it. */
export class VpnCommandError extends Error {}

/** Said when the server's answer carries no message of its own. */
const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that command.",
  404: "This Machine no longer reports that VPN.",
  409: "Not now: the Machine is Offline, or a command is already under way.",
}

const SEND_MS = 10_000

/**
 * Asks the server to connect or disconnect one VPN, once (API.md:
 * `POST /api/machines/:id/vpns/:name`). Resolves on 202; the outcome arrives
 * later as `machine` events. Throws a VpnCommandError with a sentence to show.
 */
export async function sendVpnCommand(machineId: string, name: string, action: VpnAction): Promise<void> {
  const url = `/api/machines/${encodeURIComponent(machineId)}/vpns/${encodeURIComponent(name)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(SEND_MS),
    })
  } catch {
    throw new VpnCommandError("Couldn’t reach the server.")
  }
  if (res.status === 202 || res.ok) return

  const said = await res.text().then(readMessage, () => null)
  throw new VpnCommandError(said ?? REFUSALS[res.status] ?? `The server couldn’t take the command (HTTP ${res.status}).`)
}

/** A short message from a response body: plain text, or JSON `error`/`message`. */
function readMessage(body: string): string | null {
  let text = body.trim()
  if (!text) return null
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text)
      text = typeof value?.message === "string" ? value.message : typeof value?.error === "string" ? value.error : ""
    } catch {
      return null
    }
  }
  if (!text || text.length > 200 || text.startsWith("<")) return null
  const sentence = text[0].toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/** The status a command ends in. */
export function targetOf(action: VpnAction): VpnStatus {
  return action === "connect" ? "connected" : "disconnected"
}
