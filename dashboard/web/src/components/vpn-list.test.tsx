import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { VpnList } from "@/components/vpn-list"
import type { Machine } from "@/lib/types"

const machine: Machine = { id: "pc", name: "PC", os: "windows", online: true, lastSeen: null, usage: null, apps: null, history: [], vpns: [{ name: "Office", status: "disconnected", pending: null, error: null }] }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it("keeps a VPN command pending for the duration supplied by its Machine", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })))
  const limits: NonNullable<Machine["limits"]> = { vpnMs: 700, powerMs: 800, updateMs: 900, maxTargets: 5, processes: 3, usage: { cpu: { high: 60, hot: 70 }, ram: { high: 60, hot: 70 }, disk: { high: 60, hot: 70 } } }
  render(<VpnList machine={{ ...machine, limits }} muted={false} locked={null} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Connect\s*Office/ })))
  expect(screen.getByRole("button", { name: /Connecting…\s*Office/ })).toBeTruthy()
  act(() => vi.advanceTimersByTime(701))
  expect(screen.getByRole("button", { name: /Connect\s*Office/ })).toBeTruthy()
})

it("keeps a VPN command pending until an event arrives when policy is absent", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })))
  render(<VpnList machine={machine} muted={false} locked={null} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Connect\s*Office/ })))
  act(() => vi.advanceTimersByTime(1_000_000))
  expect(screen.getByRole("button", { name: /Connecting…\s*Office/ })).toBeTruthy()
})
