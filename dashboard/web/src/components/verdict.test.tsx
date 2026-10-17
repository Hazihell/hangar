import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Verdict } from "@/components/verdict"
import type { Machine } from "@/lib/types"

afterEach(cleanup)
const machine: Machine = { id: "pc", name: "PC", os: "windows", online: true, lastSeen: null, usage: { at: "now", cpu: 100, ram: { used: 99, total: 100 }, disks: [{ name: "C:", used: 99, total: 100 }], services: { t3: false } }, apps: null, vpns: [], history: [] }

describe("Dashboard attention", () => {
  it("shows the evaluator’s title and explanation even when usage is ordinary", () => {
    render(<Verdict machines={[{ ...machine, usage: null, attention: [{ tag: "vpn:office", title: "Office disconnected", body: "PC lost its VPN connection." }] }]} />)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Office disconnected")
    expect(screen.getByRole("link").textContent).toBe("PC lost its VPN connection.")
  })
  it("does not invent conditions from usage when the evaluator reports none", () => {
    render(<Verdict machines={[{ ...machine, attention: [] }]} />)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("PC is Online. Nothing needs attention.")
  })
  it("does not promise that nothing needs attention before policy arrives", () => {
    render(<Verdict machines={[machine]} />)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("PC is Online.")
  })
})
