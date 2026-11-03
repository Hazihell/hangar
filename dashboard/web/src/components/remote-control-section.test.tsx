import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { RemoteControlSection } from "@/components/remote-control-section"
import type { Machine, RemoteControl } from "@/lib/types"

const rc = (over: Partial<RemoteControl> = {}): RemoteControl => ({
  folders: [
    { path: "/home/roger/Dev/99x/ola-ui", mode: "worktree", state: "running" },
    { path: "/home/roger/Dev/notes", mode: "same-dir", state: "failing" },
  ],
  candidates: ["/home/roger/Dev/evidence", "/home/roger/Dev/hangar"],
  checkedAt: 1,
  pending: null,
  error: null,
  ...over,
})
const machine = (remoteControl?: RemoteControl): Machine => ({ id: "pc", name: "Stormtrooper", os: "windows", online: true, lastSeen: null, usage: null, apps: null, history: [], vpns: [], remoteControl })

beforeEach(() => localStorage.setItem("hangar:rc-open:pc", "1"))
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const section = (m: Machine, locked: string | null = null, muted = false) => render(<RemoteControlSection machine={m} muted={muted} locked={locked} />)

it("renders nothing for a Machine without Remote Control", () => {
  const { container } = section(machine())
  expect(container.innerHTML).toBe("")
})

it("lists each folder with ~ for home, its state in words and its mode", () => {
  section(machine(rc()))
  const rows = within(screen.getByRole("list", { name: /Remote Control folders/ })).getAllByRole("listitem")
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain("~/Dev/99x/ola-ui")
  expect(rows[0].textContent).toContain("Running")
  expect(rows[0].textContent).toContain("own worktree per session")
  expect(rows[1].textContent).toContain("Failing")
  expect(rows[1].textContent).toContain("shared folder")
  expect(screen.getByRole("button", { name: /Remote Control/ }).textContent).toContain("1 not running")
})

it("invites adding a folder when there are none, and says so when nothing has been read yet", () => {
  const { unmount } = section(machine(rc({ folders: [] })))
  expect(screen.getByText(/No folders yet/)).toBeTruthy()
  unmount()
  section(machine(rc({ folders: [], candidates: [], checkedAt: null })))
  expect(screen.getByText(/Not checked yet: the server/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Add folder/ })).toBeNull()
})

it("always asks before removing, says sessions will stop, and sends nothing on Cancel", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(rc({ pending: { action: "remove", path: "/home/roger/Dev/99x/ola-ui" } })), { status: 202 }))
  vi.stubGlobal("fetch", fetch)
  section(machine(rc()))
  fireEvent.click(screen.getByRole("button", { name: /Remove\s*ola-ui/ }))
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog.textContent).toMatch(/stop responding/)
  expect(dialog.textContent).toContain("~/Dev/99x/ola-ui")
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: /Remove\s*ola-ui/ }))
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }))
  await act(async () => {})
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe("/api/machines/pc/rc")
  expect(JSON.parse(init.body as string)).toEqual({ action: "remove", path: "/home/roger/Dev/99x/ola-ui" })
  expect(screen.getAllByText("Removing…").length).toBeGreaterThan(0)
})

it("adds the candidate picked from the menu without asking", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(rc()), { status: 202 }))
  vi.stubGlobal("fetch", fetch)
  section(machine(rc()))
  fireEvent.click(screen.getByRole("button", { name: /Add folder/ }))
  const items = await screen.findAllByRole("menuitem")
  expect(items.map((i) => i.textContent)).toEqual(["~/Dev/evidence", "~/Dev/hangar"])
  fireEvent.click(items[1])
  await act(async () => {})
  expect(screen.queryByRole("alertdialog")).toBeNull()
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(init.body as string)).toEqual({ action: "add", path: "/home/roger/Dev/hangar" })
})

it("disables every action while one is pending, and shows the pending folder", () => {
  section(machine(rc({ pending: { action: "add", path: "/home/roger/Dev/evidence" } })))
  for (const button of screen.getAllByRole("button", { name: /^Remove/ })) expect(button.getAttribute("aria-disabled") ?? button.getAttribute("data-disabled")).not.toBeNull()
  expect(screen.getByRole("button", { name: /Adding…\s*on Stormtrooper/ }).getAttribute("data-disabled")).not.toBeNull()
  expect(screen.getAllByText("Adding…").length).toBeGreaterThan(0)
})

it("shows the server's error, and a refusal from the request itself", async () => {
  const { unmount } = section(machine(rc({ error: "/home/roger/Dev/b didn’t start" })))
  expect(screen.getByRole("status").textContent).toContain("didn’t start")
  expect(screen.getByRole("button", { name: /Remote Control/ }).textContent).toContain("Change failed")
  unmount()
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 409 })))
  section(machine(rc()))
  fireEvent.click(screen.getByRole("button", { name: /Add folder/ }))
  fireEvent.click((await screen.findAllByRole("menuitem"))[0])
  await act(async () => {})
  expect(screen.getByRole("status").textContent).toMatch(/Couldn’t add the folder\. Not now/)
})

it("locks every action while the Machine is Offline", () => {
  section(machine(rc()), "Stormtrooper is Offline.", true)
  for (const button of screen.getAllByRole("button", { name: /^Remove/ })) expect(button.getAttribute("data-disabled")).not.toBeNull()
  expect(screen.getByRole("button", { name: /Add folder/ }).getAttribute("data-disabled")).not.toBeNull()
})
