import { useCallback, useEffect, useRef, useState } from "react"

import { mergeEvent } from "@/lib/history"
import type { Machine, MachineEvent, MachinesResponse } from "@/lib/types"

/**
 * - loading: first fetch in flight
 * - live: the event stream is open
 * - reconnecting: the stream dropped and the browser is retrying
 * - unreachable: the server didn't answer; we keep retrying
 */
export type Connection = "loading" | "live" | "reconnecting" | "unreachable"

export type DashboardState = {
  connection: Connection
  machines: Machine[] | null
  /** Server clock minus ours, in ms; relative times use the server's clock. */
  skew: number
  /** When we last heard from the server, by our clock. */
  lastContact: number | null
}

const RETRY_MS = 5_000
/** A stream that stays down this long counts as unreachable. */
const GIVE_UP_MS = 15_000
/**
 * Silence longer than this gets checked with a fetch: a proxy in between can
 * keep the stream open after the server behind it has gone.
 */
const QUIET_MS = 40_000
/** A fetch that takes longer than this has failed. */
const FETCH_MS = 10_000

export function useDashboard() {
  const [state, setState] = useState<DashboardState>({
    connection: "loading",
    machines: null,
    skew: 0,
    lastContact: null,
  })
  const reconnectRef = useRef<() => void>(() => {})

  useEffect(() => {
    let disposed = false
    let source: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined
    // Events that arrive while a snapshot is in flight, replayed onto it.
    let pending: MachineEvent[] | null = null
    let loadId = 0
    let lastHeard = Date.now()
    // Server clock minus ours, as of the last snapshot.
    let skew = 0
    const inflight = new Set<AbortController>()

    const update = (fn: (s: DashboardState) => DashboardState) => {
      if (!disposed) setState(fn)
    }

    const unreachable = () =>
      update((s) => ({ ...s, connection: "unreachable" }))

    /** The snapshot, with a deadline over the whole request, body included. */
    async function fetchMachines() {
      const controller = new AbortController()
      inflight.add(controller)
      const timer = setTimeout(() => controller.abort(), FETCH_MS)
      try {
        const res = await fetch("/api/machines", { cache: "no-store", signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as MachinesResponse
      } finally {
        clearTimeout(timer)
        inflight.delete(controller)
      }
    }

    async function load() {
      const id = ++loadId
      pending = []
      try {
        const body = await fetchMachines()
        if (disposed || id !== loadId) return
        const offset = Date.parse(body.now) - Date.now()
        skew = Number.isFinite(offset) ? offset : 0
        let machines = body.machines
        for (const event of pending ?? []) machines = mergeEvent(machines, event, Date.now() + skew)
        pending = null
        lastHeard = Date.now()
        update(() => ({
          connection: source?.readyState === EventSource.OPEN ? "live" : "reconnecting",
          machines,
          skew,
          lastContact: Date.now(),
        }))
      } catch {
        if (disposed || id !== loadId) return
        pending = null
        unreachable()
      }
    }

    function connect() {
      if (disposed) return
      clearTimeout(retryTimer)
      source?.close()
      const es = new EventSource("/api/events")
      source = es

      es.onopen = () => {
        clearTimeout(giveUpTimer)
        giveUpTimer = undefined
        // First open and every reconnect: take a fresh snapshot.
        void load()
      }

      es.addEventListener("machine", (message) => {
        let event: MachineEvent
        try {
          event = JSON.parse((message as MessageEvent<string>).data)
        } catch {
          return
        }
        pending?.push(event)
        lastHeard = Date.now()
        update((s) => ({
          ...s,
          connection: "live",
          lastContact: Date.now(),
          machines: s.machines ? mergeEvent(s.machines, event, Date.now() + skew) : s.machines,
        }))
      })

      es.onerror = () => {
        if (es !== source) return
        if (es.readyState === EventSource.CLOSED) {
          // The browser gave up (e.g. an HTTP error from a proxy); retry ourselves.
          retryTimer = setTimeout(connect, RETRY_MS)
        }
        update((s) => ({
          ...s,
          connection: s.machines && s.connection !== "unreachable" ? "reconnecting" : "unreachable",
        }))
        giveUpTimer ??= setTimeout(unreachable, GIVE_UP_MS)
      }
    }

    // Watchdog for a stream that is open but silent.
    const watchdog = setInterval(async () => {
      if (Date.now() - lastHeard < QUIET_MS || pending) return
      try {
        await fetchMachines()
        if (disposed) return
        lastHeard = Date.now()
        // The server is there but the stream may be stale: reopen it.
        connect()
      } catch {
        if (disposed) return
        unreachable()
        connect()
      }
    }, QUIET_MS / 4)

    const wake = () => {
      if (document.visibilityState !== "visible") return
      if (!source || source.readyState === EventSource.CLOSED) connect()
    }

    reconnectRef.current = () => {
      clearTimeout(giveUpTimer)
      giveUpTimer = undefined
      update((s) => ({ ...s, connection: s.machines ? "reconnecting" : "loading" }))
      connect()
    }

    connect()
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)

    return () => {
      disposed = true
      for (const controller of inflight) controller.abort()
      clearInterval(watchdog)
      clearTimeout(retryTimer)
      clearTimeout(giveUpTimer)
      source?.close()
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
    }
  }, [])

  const retry = useCallback(() => reconnectRef.current(), [])
  return { ...state, retry }
}
