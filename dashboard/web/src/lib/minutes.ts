import { useEffect, useState } from "react"

import { BUCKET } from "@/lib/history"
import type { Channel, HistoryPoint, MinuteResponse } from "@/lib/types"

/** One History minute, with its start parsed. */
export type Minute = HistoryPoint & { ms: number }

/** The minutes behind one point of a trace. */
export type Bucket = { id: number; minutes: Minute[] }

/** History grouped the way the traces draw it: one bucket per 10 minutes. */
export function bucketsOf(history: HistoryPoint[]): Bucket[] {
  const out: Bucket[] = []
  for (const p of history) {
    const ms = Date.parse(p.t)
    const id = Math.floor(ms / BUCKET)
    const last = out.at(-1)
    if (last?.id === id) last.minutes.push({ ...p, ms })
    else out.push({ id, minutes: [{ ...p, ms }] })
  }
  return out
}

/**
 * The minute a point stands for: the one with the channel's highest value in
 * its bucket. A trace shows 10-minute averages, so this is where a spike's
 * cause is.
 */
export function peakOf(bucket: Bucket, channel: Channel): Minute {
  return bucket.minutes.reduce((best, m) => (m[channel] > best[channel] ? m : best))
}

/** The bucket under a time on the trace, or the nearest within one bucket; -1 over a gap. */
export function bucketAt(buckets: Bucket[], time: number): number {
  const id = Math.floor(time / BUCKET)
  let lo = 0
  let hi = buckets.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (buckets[mid].id < id) lo = mid + 1
    else hi = mid - 1
  }
  // lo: first bucket with id >= the one under the pointer.
  const candidates = [lo - 1, lo].filter((i) => i >= 0 && i < buckets.length)
  let best = -1
  for (const i of candidates) {
    const d = Math.abs(buckets[i].id - id)
    if (d <= 1 && (best === -1 || d < Math.abs(buckets[best].id - id))) best = i
  }
  return best
}

/** The index of the bucket holding a minute. */
export function bucketOf(buckets: Bucket[], minute: Minute): number {
  return bucketAt(buckets, minute.ms)
}

const cache = new Map<string, MinuteResponse>()

export type MinuteState =
  | { status: "loading" }
  | { status: "ok"; data: MinuteResponse }
  | { status: "missing" }
  | { status: "error" }

/**
 * The Top Apps of one History minute (`GET /api/machines/:id/minutes/:t`).
 * Past minutes don't change, so they're kept; the current one isn't.
 */
export function useMinute(machineId: string, t: string, current: boolean) {
  const key = `${machineId}|${t}`
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{ key: string; attempt: number; state: MinuteState } | null>(null)

  useEffect(() => {
    if (cache.has(key)) return
    const controller = new AbortController()
    let closed = false
    const timer = setTimeout(() => controller.abort(), 10_000)
    const settle = (state: MinuteState) => setAnswer({ key, attempt, state })
    fetch(`/api/machines/${encodeURIComponent(machineId)}/minutes/${encodeURIComponent(t)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (res.status === 404) return settle({ status: "missing" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as MinuteResponse
        if (!Array.isArray(data?.apps)) throw new Error("malformed")
        if (!current) cache.set(key, data)
        settle({ status: "ok", data })
      })
      .catch(() => {
        // Superseded (another minute picked, or the panel closed): say nothing.
        if (!closed) settle({ status: "error" })
      })
    return () => {
      closed = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, attempt, machineId, t, current])

  const cached = cache.get(key)
  const state: MinuteState = cached
    ? { status: "ok", data: cached }
    : answer?.key === key && answer.attempt === attempt
      ? answer.state
      : { status: "loading" }
  return { state, retry: () => setAttempt((a) => a + 1) }
}
