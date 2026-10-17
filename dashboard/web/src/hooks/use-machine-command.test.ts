import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  useMachineCommand,
  useMachineCommands,
} from "@/hooks/use-machine-command"
import { postCommand } from "@/lib/machine-command"
import { sendVpnCommand } from "@/lib/vpn"
import { sendPower } from "@/lib/power"
import { checkNow, sendUpdate } from "@/lib/updates"
import { sendQuit } from "@/lib/quit"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const words = { refusals: { 409: "Try later." }, fallback: "Command refused" }
const send = (action: string) => postCommand("/command", { action }, words)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Machine command lifecycle", () => {
  it("bridges a click to the server event and ignores a refusal after retirement", async () => {
    const reply = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply.promise)
    )
    const { result, rerender } = renderHook(
      ({ seen }) =>
        useMachineCommand({ send, seen: () => seen, fallback: "Failed." }),
      { initialProps: { seen: false } }
    )
    let sending!: Promise<void>
    act(() => {
      sending = result.current.run("sleep")
    })
    expect(result.current.pending).toBe("sleep")
    rerender({ seen: true })
    expect(result.current.pending).toBeNull()
    rerender({ seen: false })
    await act(async () => {
      reply.resolve(new Response("refused", { status: 409 }))
      await sending
    })
    expect(result.current.refusal).toBeNull()
    expect(result.current.pending).toBeNull()
  })

  it("lets a new server error retire an attempt but keeps an older error from doing so", async () => {
    const reply = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply.promise)
    )
    const { result, rerender } = renderHook(
      ({ errorAt }) =>
        useMachineCommand({ send, errorAt, fallback: "Failed." }),
      { initialProps: { errorAt: "old" } }
    )
    act(() => {
      void result.current.run("update")
    })
    rerender({ errorAt: "old" })
    expect(result.current.pending).toBe("update")
    rerender({ errorAt: "new" })
    expect(result.current.pending).toBeNull()
    await act(async () => {
      reply.reject(new Error("offline"))
    })
    expect(result.current.refusal).toBeNull()
  })

  it("expires an accepted stand-in after five seconds when its event is lost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 }))
    )
    const { result } = renderHook(() =>
      useMachineCommand({ send, fallback: "Failed." })
    )
    await act(async () => {
      await result.current.run("check")
    })
    act(() => {
      vi.advanceTimersByTime(4_999)
    })
    expect(result.current.pending).toBe("check")
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.pending).toBeNull()
  })

  it("keeps VPN optimism for 100 seconds, rather than expiring on acknowledgment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 }))
    )
    const { result } = renderHook(() =>
      useMachineCommand({ send, optimisticMs: 100_000, fallback: "Failed." })
    )
    await act(async () => {
      await result.current.run("disconnect")
    })
    act(() => {
      vi.advanceTimersByTime(99_999)
    })
    expect(result.current.pending).toBe("disconnect")
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.pending).toBeNull()
  })

  it("ignores an older refusal when a newer attempt is pending", async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal("fetch", fetch)
    const onSent = vi.fn()
    const { result } = renderHook(() =>
      useMachineCommand({ send, fallback: "Failed.", onSent })
    )
    let old!: Promise<void>
    let fresh!: Promise<void>
    act(() => {
      old = result.current.run("first")
    })
    act(() => {
      fresh = result.current.run("second")
    })
    await act(async () => {
      first.resolve(new Response("old refusal", { status: 409 }))
      await old
    })
    expect(result.current.pending).toBe("second")
    expect(result.current.refusal).toBeNull()
    await act(async () => {
      second.resolve(new Response(null, { status: 202 }))
      await fresh
    })
    expect(onSent).toHaveBeenCalledExactlyOnceWith("second")
  })

  it("an older acknowledgment timer cannot clear a newer pending attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockReturnValueOnce(new Promise(() => {}))
    )
    const { result } = renderHook(() =>
      useMachineCommand({ send, fallback: "Failed." })
    )
    await act(async () => {
      await result.current.run("first")
    })
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    act(() => {
      void result.current.run("second")
    })
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current.pending).toBe("second")
  })

  it("notifies acceptance after event retirement, but never for a superseded answer", async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    )
    const onSent = vi.fn()
    const { result, rerender } = renderHook(
      ({ seen }) =>
        useMachineCommand({
          send,
          onSent,
          seen: () => seen,
          fallback: "Failed.",
        }),
      { initialProps: { seen: false } }
    )
    let old!: Promise<void>
    let fresh!: Promise<void>
    act(() => {
      old = result.current.run("first")
    })
    act(() => {
      fresh = result.current.run("second")
    })
    rerender({ seen: true })
    await act(async () => {
      second.resolve(new Response(null, { status: 202 }))
      await fresh
    })
    expect(onSent).toHaveBeenCalledExactlyOnceWith("second")
    await act(async () => {
      first.resolve(new Response(null, { status: 202 }))
      await old
    })
    expect(onSent).toHaveBeenCalledExactlyOnceWith("second")
    expect(result.current.pending).toBeNull()
  })

  it("a late VPN refusal stays visible for eight seconds across its optimistic deadline", async () => {
    const reply = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply.promise)
    )
    const { result } = renderHook(() =>
      useMachineCommand({ send, optimisticMs: 100_000, fallback: "Failed." })
    )
    let sending!: Promise<void>
    act(() => {
      sending = result.current.run("disconnect")
    })
    act(() => {
      vi.advanceTimersByTime(98_000)
    })
    await act(async () => {
      reply.resolve(new Response("", { status: 409 }))
      await sending
    })
    act(() => {
      vi.advanceTimersByTime(7_999)
    })
    expect(result.current.pending).toBeNull()
    expect(result.current.refusal?.message).toBe("Try later.")
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.refusal).toBeNull()
  })

  it("shows refusals for eight seconds and an older refusal timer cannot clear a newer one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 409 }))
    )
    const { result } = renderHook(() =>
      useMachineCommand({ send, fallback: "Failed." })
    )
    await act(async () => {
      await result.current.run("first")
    })
    expect(result.current.refusal?.message).toBe("Try later.")
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    await act(async () => {
      await result.current.run("second")
    })
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(result.current.refusal?.input).toBe("second")
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(result.current.refusal).toBeNull()
  })

  it("keeps Quit subjects independent and matures only the latest answer for each", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]"))
    )
    const { result } = renderHook(() =>
      useMachineCommands({
        send,
        retain: { settleMs: 10_000 },
        fallback: "Failed.",
      })
    )
    await act(async () => {
      await result.current.run("quit", "app-a")
      await result.current.run("quit", "app-b")
    })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    await act(async () => {
      await result.current.run("force", "app-a")
    })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current.attempts["app-a"].settled).toBe(false)
    expect(result.current.attempts["app-b"].settled).toBe(true)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current.attempts["app-a"].settled).toBe(true)
  })

  it("cancels timers on unmount and ignores replies that arrive afterwards", async () => {
    const reply = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockReturnValueOnce(reply.promise)
    )
    const onSent = vi.fn()
    const { result, unmount } = renderHook(() =>
      useMachineCommand({ send, fallback: "Failed.", onSent })
    )
    await act(async () => {
      await result.current.run("first")
    })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.run("second")
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      reply.reject(new Error("late"))
      await pending
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(onSent).toHaveBeenCalledExactlyOnceWith("first")
  })
})

describe("command HTTP adapter", () => {
  it.each([
    [
      "VPN",
      () => sendVpnCommand("pc /", "Office /", "connect"),
      "/api/machines/pc%20%2F/vpns/Office%20%2F",
      { action: "connect" },
      "This Machine no longer reports that VPN.",
    ],
    [
      "Sleep",
      () => sendPower("pc /", "sleep"),
      "/api/machines/pc%20%2F/power",
      { action: "sleep" },
      "The Dashboard can’t put this Machine to sleep or shut it down.",
    ],
    [
      "Update",
      () => sendUpdate("pc /", ["codex"]),
      "/api/machines/pc%20%2F/updates",
      { items: ["codex"] },
      "The server doesn’t know this Machine.",
    ],
    [
      "Quit",
      () => sendQuit("pc /", { app: "Code" }, false),
      "/api/machines/pc%20%2F/quit",
      { app: "Code", force: false },
      "The Dashboard has no way to reach this Machine.",
    ],
  ])(
    "characterizes the existing %s request and refusal wording",
    async (_name, call, path, body, message) => {
      const fetch = vi.fn(async () => new Response("", { status: 404 }))
      vi.stubGlobal("fetch", fetch)
      await expect(call()).rejects.toThrow(message)
      expect(fetch).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: expect.any(AbortSignal),
        })
      )
    }
  )

  it.each([
    ['{"error":"busy"}', "Busy."],
    ["plain refusal", "Plain refusal."],
    ["<html>bad gateway</html>", "Command refused (HTTP 502)."],
  ])("reads refusal bodies safely: %s", async (body, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 502 }))
    )
    await expect(send("sleep")).rejects.toThrow(message)
  })

  it.each([
    ["Check", () => checkNow("pc"), 10_000],
    ["Quit", () => sendQuit("pc", { app: "Code" }, false), 15_000],
  ])(
    "aborts a stalled %s request at its deadline",
    async (_name, call, deadline) => {
      // Node's native timeout clock is outside Vitest's fake clock. This platform
      // adapter gives AbortSignal.timeout the same clock as the page's timers.
      const NativeSignal = AbortSignal
      vi.stubGlobal(
        "AbortSignal",
        class extends NativeSignal {
          static timeout(ms: number) {
            const controller = new AbortController()
            setTimeout(
              () =>
                controller.abort(new DOMException("Timed out", "TimeoutError")),
              ms
            )
            return controller.signal
          }
        }
      )
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_path, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener(
                "abort",
                () => reject(init.signal!.reason),
                { once: true }
              )
            })
        )
      )
      const failed = vi.fn()
      const sending = call().catch(failed)
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(failed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await sending
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Couldn’t reach the server." })
      )
    }
  )

  it("returns the accepted Power answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"pending":null}')))
    await expect(sendPower("pc", "sleep")).resolves.toEqual({ pending: null })
  })

  it("returns the accepted per-Process Quit results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"results":[{"pid":1,"result":"sent"}]}')))
    await expect(sendQuit("pc", { app: "Code" }, false)).resolves.toEqual([
      { pid: 1, result: "sent" },
    ])
  })

  it("rejects an unreadable Quit answer with a sentence to show", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad json")))
    await expect(sendQuit("pc", { app: "Code" }, false)).rejects.toThrow(
      "The server’s answer couldn’t be read."
    )
  })
})
