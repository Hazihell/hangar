import { afterEach, describe, expect, it, vi } from "vitest"

import { MachineCommandError } from "@/lib/machine-command"
import { folderParts, sendRemoteControl, shortenHome, summaryOf } from "@/lib/remote-control"
import type { RemoteControl } from "@/lib/types"

afterEach(() => vi.unstubAllGlobals())

const rc = (over: Partial<RemoteControl> = {}): RemoteControl => ({ folders: [], candidates: [], checkedAt: 1, pending: null, error: null, ...over })
const folder = (path: string, state: "running" | "starting" | "failing" | "stopped" = "running") => ({ path, mode: "worktree" as const, state })

describe("paths", () => {
  it("shortens a leading /home/<user> or /Users/<user> to ~ and nothing else", () => {
    expect(shortenHome("/home/roger/Dev/99x/ola-ui")).toBe("~/Dev/99x/ola-ui")
    expect(shortenHome("/Users/rogerserra/Dev/evidence")).toBe("~/Dev/evidence")
    expect(shortenHome("/home/roger")).toBe("~")
    expect(shortenHome("/srv/home/roger/Dev")).toBe("/srv/home/roger/Dev")
    expect(shortenHome("/home")).toBe("/home")
    expect(shortenHome("/homework/roger/x")).toBe("/homework/roger/x")
  })

  it("splits the directory from the folder's own name", () => {
    expect(folderParts("/home/roger/Dev/99x/ola-ui")).toEqual({ dir: "~/Dev/99x/", name: "ola-ui" })
    expect(folderParts("/home/roger")).toEqual({ dir: "", name: "~" })
    expect(folderParts("/opt/tools")).toEqual({ dir: "/opt/", name: "tools" })
    expect(folderParts("")).toEqual({ dir: "", name: "" })
  })
})

describe("summaryOf", () => {
  it("says what the collapsed row shows", () => {
    expect(summaryOf(rc({ checkedAt: null }))).toEqual({ text: "Not checked yet", bad: false })
    expect(summaryOf(rc())).toEqual({ text: "None", bad: false })
    expect(summaryOf(rc({ folders: [folder("/a")] }))).toEqual({ text: "1 folder", bad: false })
    expect(summaryOf(rc({ folders: [folder("/a"), folder("/b", "starting")] }))).toEqual({ text: "2 folders", bad: false })
    expect(summaryOf(rc({ folders: [folder("/a"), folder("/b", "failing"), folder("/c", "stopped")] }))).toEqual({ text: "2 not running", bad: true })
  })
})

describe("sendRemoteControl", () => {
  it("posts the action and path as JSON and returns the new state", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(rc({ pending: { action: "add", path: "/a b" } })), { status: 202 }))
    vi.stubGlobal("fetch", fetch)
    const result = await sendRemoteControl("pc/1", "add", "/a b")
    expect(result?.pending).toEqual({ action: "add", path: "/a b" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/machines/pc%2F1/rc")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "content-type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual({ action: "add", path: "/a b" })
  })

  it("turns each refusal into a sentence", async () => {
    for (const [status, text] of [[400, /list may have changed/], [403, /own address/], [404, /doesn’t serve/], [409, /Offline/], [500, /HTTP 500/]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })))
      const error = await sendRemoteControl("pc", "remove", "/a").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MachineCommandError)
      expect((error as Error).message).toMatch(text)
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline") }))
    await expect(sendRemoteControl("pc", "remove", "/a")).rejects.toThrow("Couldn’t reach the server.")
  })
})
