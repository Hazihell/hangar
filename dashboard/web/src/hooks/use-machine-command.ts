import { useEffect, useRef, useState } from "react"

import { MachineCommandError } from "@/lib/machine-command"

/** How long acceptance may bridge a missing Machine event. */
const ACK_GRACE_MS = 5_000
/** How long a refused command’s message stays visible. */
const REFUSAL_MS = 8_000
const SOLO = "command"

export type CommandAttempt<Input, Result> = {
  id: number
  input: Input
  phase: "sending" | "answered" | "refused"
  result: Result | null
  error: string | null
  errorBefore: string | null
  settled: boolean
}

type Options<Input, Result> = {
  send: (input: Input) => Promise<Result>
  seen?: (input: Input) => boolean
  errorAt?: string | null
  fallback: string
  onSent?: (input: Input) => void
  /** VPN commands outlive the HTTP acknowledgment; others only bridge its event. */
  optimisticMs?: number
  /** Quit keeps its answer for row-state interpretation and a delayed Force quit. */
  retain?: { settleMs: number }
}

/** Owns attempts, retirement, stale replies, refusal lifetime and all command timers. */
export function useMachineCommands<Input, Result>(
  options: Options<Input, Result>
) {
  const [attempts, setAttempts] = useState<
    Record<string, CommandAttempt<Input, Result>>
  >({})
  const current = useRef(new Map<string, CommandAttempt<Input, Result>>())
  const nextId = useRef(0)
  const latest = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    const active = current.current
    return () => {
      mounted.current = false
      pending.forEach(clearTimeout)
      pending.clear()
      active.clear()
    }
  }, [])

  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      fn()
    }, ms)
    timers.current.add(timer)
  }

  function publish() {
    if (mounted.current) setAttempts(Object.fromEntries(current.current))
  }

  // Retire during render, before a late HTTP answer can override the event.
  const retired = Object.entries(attempts).filter(
    ([, a]) =>
      a.phase !== "refused" &&
      !options.retain &&
      (options.seen?.(a.input) ||
        (options.errorAt != null && options.errorAt !== a.errorBefore))
  )
  if (retired.length) {
    for (const [key, a] of retired) {
      if (current.current.get(key)?.id === a.id) current.current.delete(key)
    }
    publish()
  }

  async function run(input: Input, key = SOLO) {
    const id = ++nextId.current
    const attempt: CommandAttempt<Input, Result> = {
      id,
      input,
      phase: "sending",
      result: null,
      error: null,
      errorBefore: options.errorAt ?? null,
      settled: false,
    }
    latest.current.set(key, id)
    current.current.set(key, attempt)
    publish()
    const patch = (
      fn: (
        a: CommandAttempt<Input, Result>
      ) => CommandAttempt<Input, Result> | null
    ) => {
      const a = current.current.get(key)
      if (!mounted.current || a?.id !== id) return
      const updated = fn(a)
      if (updated) current.current.set(key, updated)
      else current.current.delete(key)
      publish()
    }
    if (options.optimisticMs !== undefined)
      later(
        () => patch((a) => (a.phase === "refused" ? a : null)),
        options.optimisticMs
      )
    try {
      const result = await options.send(input)
      if (!mounted.current || latest.current.get(key) !== id) return
      // An older acceptance must not overwrite a newer command’s App tracking.
      options.onSent?.(input)
      if (current.current.get(key)?.id !== id) return
      patch((a) => ({ ...a, phase: "answered", result }))
      if (options.retain) {
        later(
          () => patch((a) => ({ ...a, settled: true })),
          options.retain.settleMs
        )
      } else if (options.optimisticMs === undefined) {
        later(() => patch(() => null), ACK_GRACE_MS)
      }
    } catch (error) {
      if (!mounted.current || current.current.get(key)?.id !== id) return
      patch((a) => ({
        ...a,
        phase: "refused",
        error:
          error instanceof MachineCommandError
            ? error.message
            : options.fallback,
      }))
      if (!options.retain) later(() => patch(() => null), REFUSAL_MS)
    }
  }

  return { attempts, run }
}

/** The common single-command view; keyed attempts are used by Quit rows. */
export function useMachineCommand<Input, Result>(
  options: Options<Input, Result>
) {
  const { attempts, run } = useMachineCommands(options)
  const attempt = attempts[SOLO]
  return {
    pending: attempt && attempt.phase !== "refused" ? attempt.input : null,
    refusal:
      attempt?.phase === "refused"
        ? { input: attempt.input, message: attempt.error! }
        : null,
    run,
  }
}
