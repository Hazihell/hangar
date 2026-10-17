import { postCommand } from "@/lib/machine-command"
import type { Machine, T3Thread, Update, Updates } from "@/lib/types"

const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that list.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "The server doesn’t know this Machine.",
  409: "Not now: the Machine is Offline, something is already updating, or the item can’t be updated from here.",
}

/** `POST /api/machines/:id/updates`: updates those items, in that order. */
export async function sendUpdate(machineId: string, items: string[]): Promise<Updates | null> {
  const res = await postCommand(`/api/machines/${encodeURIComponent(machineId)}/updates`, { items }, { refusals: REFUSALS, fallback: "The server couldn’t take it" })
  return ((await res.json().catch(() => null)) as Updates | null) ?? null
}

/** `POST /api/machines/:id/updates/check`: checks now. */
export async function checkNow(machineId: string): Promise<void> {
  await postCommand(`/api/machines/${encodeURIComponent(machineId)}/updates/check`, {}, {
    refusals: { ...REFUSALS, 409: "Not now: a check is already running, or the Machine is Offline." },
    fallback: "The server couldn’t take it",
  })
}

/**
 * `GET /api/machines/:id/t3-threads`: the T3 threads an update would
 * interrupt. `null` when T3 couldn't say (the server couldn't read them).
 */
export async function fetchT3Threads(machineId: string, signal: AbortSignal): Promise<T3Thread[] | null> {
  const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/t3-threads`, { cache: "no-store", signal })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { threads?: T3Thread[] | null } | null
  return Array.isArray(body?.threads) ? body.threads : null
}

/** What the Dashboard can update right now: available and not blocked. */
export const updatable = (u: Update) => u.available && u.blocked === null

/** Out of date, whether or not it can be updated from here (what the counts count). */
export const outOfDate = (u: Update) => u.available

/**
 * The Machine the Dashboard runs on (the PC): updating `hangar` there
 * restarts the Dashboard itself.
 */
export const runsDashboard = (m: Machine) => m.os === "windows"

/**
 * The order to send items in: `hangar` last, since on the PC it restarts the
 * server; `t3` just before it, since it restarts T3.
 */
export function inSendOrder(ids: string[]): string[] {
  const rank = (id: string) => (id === "hangar" ? 2 : id === "t3" ? 1 : 0)
  return [...ids].sort((a, b) => rank(a) - rank(b))
}

/** "2.1.302 → 2.1.310", or for Hangar, commits: "2fc68d8 → 7a1c9e0 (2 behind)". */
export function versions(u: Update): { from: string; to: string | null; behind: string | null } {
  return {
    from: u.current ?? "unknown",
    to: u.available ? (u.latest ?? null) : null,
    behind: u.available && u.behind ? `${u.behind} ${u.behind === 1 ? "commit" : "commits"} behind` : null,
  }
}
