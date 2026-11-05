import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDashboard } from "@/hooks/use-dashboard"

/** A stand-in for the browser's EventSource that the test opens and closes by hand. */
class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static all: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeEventSource.all.push(this)
  }
  private listeners: ((message: MessageEvent<string>) => void)[] = []
  addEventListener(_type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.push(listener)
  }
  /** A Machine event from the server. */
  emit(data: object) {
    for (const listener of this.listeners) listener(new MessageEvent("machine", { data: JSON.stringify(data) }))
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
}

const streams = () => FakeEventSource.all
const live = () => streams().filter((s) => s.readyState !== FakeEventSource.CLOSED)

let visibility: DocumentVisibilityState = "visible"
function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event("visibilitychange"))
}

/** The server's answer to /api/machines, naming the Machines it reports. */
const snapshot = (...ids: string[]) =>
  new Response(
    JSON.stringify({ now: new Date().toISOString(), machines: ids.map((id) => ({ id, name: id })) }),
    { status: 200 }
  )

beforeEach(() => {
  FakeEventSource.all = []
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", vi.fn(async () => snapshot("pc")))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useDashboard while the page is hidden", () => {
  it("closes the stream when hidden and shows a fresh snapshot when shown again", async () => {
    const { result } = renderHook(() => useDashboard())
    await act(async () => streams()[0].open())
    expect(result.current.machines?.map((m) => m.id)).toEqual(["pc"])

    act(() => setVisibility("hidden"))
    expect(live()).toHaveLength(0)

    vi.mocked(fetch).mockImplementation(async () => snapshot("pc", "mac"))
    act(() => setVisibility("visible"))
    await act(async () => live()[0].open())
    expect(result.current.machines?.map((m) => m.id)).toEqual(["pc", "mac"])
  })

  it("never reads as the server going away, which a pending Sleep or Shut down watches for", async () => {
    const seen = new Set<string>()
    const { result } = renderHook(() => {
      const state = useDashboard()
      seen.add(state.connection)
      return state
    })
    await act(async () => streams()[0].open())
    seen.clear()

    act(() => setVisibility("hidden"))
    act(() => setVisibility("visible"))
    await act(async () => live()[0].open())
    expect([...seen]).toEqual(["live"])
    expect(result.current.connection).toBe("live")
  })

  it("never lets a snapshot that was loading when the page was hidden overwrite the fresh one", async () => {
    let answerOld!: (r: Response) => void
    let oldSignal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      oldSignal = init?.signal ?? undefined
      return new Promise<Response>((resolve) => (answerOld = resolve))
    })
    const { result } = renderHook(() => useDashboard())
    act(() => streams()[0].open())

    act(() => setVisibility("hidden"))
    expect(oldSignal?.aborted).toBe(true) // Nothing more is transferred while hidden.

    act(() => setVisibility("visible"))
    await act(async () => live()[0].open())
    expect(result.current.machines?.map((m) => m.id)).toEqual(["pc"])
    await act(async () => answerOld(snapshot("old")))
    expect(result.current.machines?.map((m) => m.id)).toEqual(["pc"])
  })

  it("keeps the stream for two minutes after hiding during a close watch, then closes it", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDashboard())
    await act(async () => streams()[0].open())
    act(() => result.current.watchClosely(true))

    act(() => setVisibility("hidden"))
    act(() => vi.advanceTimersByTime(119_000))
    expect(live()).toHaveLength(1)

    act(() => vi.advanceTimersByTime(1_000))
    expect(live()).toHaveLength(0)
    vi.useRealTimers()
  })

  it("doesn't read as the server going away when the hold ends with a probe still out", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDashboard())
    await act(async () => streams()[0].open())
    act(() => result.current.watchClosely(true))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    act(() => setVisibility("hidden")) // The hold ends 120 s from here.
    // The server answers every probe, but the one sent just before the hold ends is still out when it does.
    const holdEnds = Date.now() + 120_000
    vi.mocked(fetch).mockImplementation((_url, init) =>
      holdEnds - Date.now() < 3_000
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          )
        : Promise.resolve(snapshot("pc"))
    )

    // Events keep arriving, as from a live server, until the hold ends.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 4_000) {
      act(() => live()[0]?.emit({ id: "pc", name: "pc" }))
      await act(async () => vi.advanceTimersByTimeAsync(4_000))
    }
    expect(live()).toHaveLength(0)
    expect(result.current.connection).toBe("live")

    // And after it, nothing: no requests, no streams.
    const fetches = vi.mocked(fetch).mock.calls.length
    const opened = streams().length
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000))
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetches)
    expect(streams().length).toBe(opened)
    expect(result.current.connection).toBe("live")
  })

  it("closes the stream as soon as a close watch ends while hidden", async () => {
    const { result } = renderHook(() => useDashboard())
    await act(async () => streams()[0].open())
    act(() => result.current.watchClosely(true))
    act(() => setVisibility("hidden"))
    expect(live()).toHaveLength(1)

    act(() => result.current.watchClosely(false))
    expect(live()).toHaveLength(0)
  })

  it("opens no stream for a page loaded in the background until it is shown", () => {
    visibility = "hidden"
    renderHook(() => useDashboard())
    expect(streams()).toHaveLength(0)

    act(() => setVisibility("visible"))
    expect(live()).toHaveLength(1)
  })
})
