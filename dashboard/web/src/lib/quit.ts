import { JSON_HEADERS, readMessage } from "@/lib/http"
import type { Where } from "@/lib/types"

/** One Process to Quit, as `POST /api/machines/:id/quit` takes it. */
export type QuitTarget = { pid: number; started: string; where?: "wsl" }

export type QuitOutcome = "sent" | "gone" | "changed" | "protected" | "failed"

export type QuitResult = { pid: number; result: QuitOutcome; message?: string; started?: string; where?: "wsl" }

/**
 * What to Quit: Processes by PID, or an App by name, which the server resolves
 * to all of its Processes that may be quit (the page only sees 20 per App).
 */
export type QuitRequest = { targets: QuitTarget[] } | { app: string; where?: "wsl" }

/** A Quit the server refused, or that never reached it. */
export class QuitError extends Error {}

const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that request.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "The Dashboard has no way to reach this Machine.",
  409: "Not now: the Machine is Offline.",
}

const SEND_MS = 15_000

/**
 * Asks the server to Quit (or, with `force`, Force quit) Processes once.
 * Resolves with one result per Process, in order. Throws a QuitError with a
 * sentence to show.
 */
export async function sendQuit(machineId: string, request: QuitRequest, force: boolean): Promise<QuitResult[]> {
  let res: Response
  try {
    res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/quit`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...request, force }),
      signal: AbortSignal.timeout(SEND_MS),
    })
  } catch {
    throw new QuitError("Couldn’t reach the server.")
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { results?: QuitResult[] } | null
    if (Array.isArray(body?.results)) return body.results
    throw new QuitError("The server’s answer couldn’t be read.")
  }
  const said = await res.text().then(readMessage, () => null)
  throw new QuitError(said ?? REFUSALS[res.status] ?? `The server couldn’t take the request (HTTP ${res.status}).`)
}

/** Identifies one Process across reports: a reused PID gets a new `started`. */
export function processKey(where: Where, pid: number, started: string): string {
  return `${where ?? ""}|${pid}|${started}`
}

export function targetKey(t: QuitTarget): string {
  return processKey(t.where, t.pid, t.started)
}
