import type { HistoryPoint, Machine, MachineEvent } from "@/lib/types"

export const DAY = 24 * 60 * 60 * 1000

/**
 * Folds one `machine` event into the list, as API.md describes: the event's
 * minute replaces the last History point when `t` matches, otherwise it is
 * appended, and points older than 24 h (before `now`, the server's clock) are
 * dropped.
 */
export function mergeEvent(machines: Machine[], event: MachineEvent, now: number): Machine[] {
  const { minute, ...fields } = event
  const index = machines.findIndex((m) => m.id === event.id)
  const current = index === -1 ? undefined : machines[index]

  // An event older than what we already hold (e.g. replayed after a refetch).
  if (
    current?.lastSeen &&
    fields.lastSeen &&
    Date.parse(fields.lastSeen) < Date.parse(current.lastSeen)
  ) {
    return machines
  }

  const next: Machine = {
    ...fields,
    // Events carry the full Machine, VPNs included; one without them (an older
    // server) keeps what we had, while an explicit [] clears them.
    vpns: fields.vpns ?? current?.vpns ?? [],
    history: minute
      ? withMinute(current?.history ?? [], minute, now)
      : (current?.history ?? []),
  }

  if (index === -1) return [...machines, next]
  const copy = machines.slice()
  copy[index] = next
  return copy
}

function withMinute(history: HistoryPoint[], minute: HistoryPoint, now: number) {
  const last = history.at(-1)
  const kept = last?.t === minute.t ? history.slice(0, -1) : history.slice()
  kept.push(minute)
  const cutoff = now - DAY
  return kept.filter((p) => Date.parse(p.t) > cutoff)
}

export type TracePoint = { x: number; cpu: number | null; ram: number | null; disk: number | null }

const BUCKET = 10 * 60 * 1000

/**
 * History thinned for a small trace: 10-minute averages, a break wherever a
 * whole bucket has no reports (the line lifts instead of bridging the gap),
 * and the latest minute kept exact so the pen sits on the current reading.
 */
export function toTrace(history: HistoryPoint[]): TracePoint[] {
  if (history.length === 0) return []
  const out: TracePoint[] = []
  let bucket = -1
  let n = 0
  let sum = { cpu: 0, ram: 0, disk: 0 }

  const flush = () => {
    if (n === 0) return
    out.push({ x: bucket * BUCKET + BUCKET / 2, cpu: sum.cpu / n, ram: sum.ram / n, disk: sum.disk / n })
  }

  for (const p of history.slice(0, -1)) {
    const b = Math.floor(Date.parse(p.t) / BUCKET)
    if (b !== bucket) {
      flush()
      if (bucket !== -1 && b > bucket + 1) {
        out.push({ x: (bucket + 1) * BUCKET + BUCKET / 2, cpu: null, ram: null, disk: null })
      }
      bucket = b
      n = 0
      sum = { cpu: 0, ram: 0, disk: 0 }
    }
    n++
    sum.cpu += p.cpu
    sum.ram += p.ram
    sum.disk += p.disk
  }
  flush()

  const last = history.at(-1)!
  const lastX = Date.parse(last.t)
  const prev = out.at(-1)
  if (prev && lastX - prev.x > BUCKET * 1.5) {
    out.push({ x: prev.x + BUCKET, cpu: null, ram: null, disk: null })
  }
  if (prev && prev.x >= lastX) out.pop()
  out.push({ x: lastX, cpu: last.cpu, ram: last.ram, disk: last.disk })
  return out
}
