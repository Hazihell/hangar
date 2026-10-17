import { BellIcon, BellOffIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import {
  AlertsError,
  currentStatus,
  pushSupport,
  sendTest,
  turnOff,
  turnOn,
  type AlertsStatus,
} from "@/lib/alerts"
import { cn } from "@/lib/utils"

type Busy = "on" | "off" | "test" | null
type Message = { tone: "error" | "quiet"; text: string }

const support = pushSupport()

const said = (error: unknown, fallback: string) => (error instanceof AlertsError ? error.message : fallback)

/**
 * Whether this browser gets Alerts, in the header beside the connection state.
 * "Alerts off" turns them on in one click (the browser asks first); "Alerts on"
 * opens a small popover to send a test or turn them off. Anything that stops
 * Alerts here (no push, not https, notifications blocked, an error) is
 * explained in the same popover.
 */
export function AlertsControl() {
  const [status, setStatus] = useState<AlertsStatus | "checking">(support === "ok" ? "checking" : "off")
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (support !== "ok") return
    let live = true
    currentStatus()
      .then((s) => live && setStatus(s))
      .catch((error) => {
        if (!live) return
        // Not confirmed with the server: say so, and let "Try again" redo it.
        setStatus("off")
        setMessage({ tone: "error", text: said(error, "Alerts couldn’t be renewed, so they may not arrive.") })
      })
    return () => {
      live = false
    }
  }, [])

  async function act(kind: Exclude<Busy, null>, fn: () => Promise<void>, fallback: string) {
    setBusy(kind)
    setMessage(null)
    try {
      await fn()
    } catch (error) {
      setMessage({ tone: "error", text: said(error, fallback) })
      setOpen(true)
    } finally {
      setBusy(null)
    }
  }

  const enable = () =>
    act(
      "on",
      async () => {
        const s = await turnOn()
        setStatus(s)
        if (s === "blocked") setOpen(true)
      },
      "Alerts couldn’t be turned on."
    )

  if (status === "checking") return null

  const on = status === "on"
  const label = busy === "on" ? "Turning on…" : on ? "Alerts on" : status === "blocked" ? "Alerts blocked" : "Alerts off"

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // "Alerts off" with nothing to explain: the click itself turns them on.
        if (next && status === "off" && support === "ok" && !message) {
          void enable()
          return
        }
        setOpen(next)
        if (!next && busy === null) setMessage((m) => (m?.tone === "quiet" ? null : m))
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === "on"}
            className={cn(
              "relative -my-1 gap-1.5 px-2 text-sm font-normal text-muted-foreground hover:text-foreground",
              "after:absolute after:-inset-y-2 after:inset-x-0 after:content-['']",
              on && "text-foreground"
            )}
          />
        }
      >
        {busy === "on" ? (
          <span aria-hidden className="size-2 rounded-full bg-muted-foreground motion-safe:animate-breathe" />
        ) : on ? (
          <BellIcon aria-hidden />
        ) : (
          <BellOffIcon aria-hidden />
        )}
        {label}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] gap-3 rounded-xl p-4 text-[0.9375rem]">
        {support === "insecure" ? (
          <Explain title="Alerts need the https address">
            Browsers only deliver push notifications to secure pages. Open the Dashboard at its https:// address on the
            tailnet to turn Alerts on.
          </Explain>
        ) : support === "unsupported" ? (
          <Explain title="This browser can’t show Alerts">
            It has no Web Push. On an iPhone or iPad, add the Dashboard to the Home Screen and open it from there;
            elsewhere, use Chrome, Edge, Firefox or Safari.
          </Explain>
        ) : status === "blocked" ? (
          <>
            <Explain title="Notifications are blocked">
              This browser blocks notifications from the Dashboard, so Alerts can’t be shown. Allow them in the site’s
              settings (the icon left of the address; on Android, ⋮ › Settings › Site settings › Notifications), then try
              again.
            </Explain>
            <Footer message={message}>
              <Button variant="outline" onClick={() => void enable()} disabled={busy !== null}>
                Try again
              </Button>
            </Footer>
          </>
        ) : on ? (
          <>
            <Explain title="Alerts are on in this browser">
              An Alert comes when a disk is nearly full, CPU or RAM stays high, a VPN drops, the T3 service stops, or a
              Machine stays Offline. When the problem clears, it’s quietly replaced.
            </Explain>
            <Footer message={message}>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "test",
                    async () => {
                      await sendTest()
                      setMessage({ tone: "quiet", text: "Test sent. It should arrive in a few seconds." })
                    },
                    "The test couldn’t be sent."
                  )
                }
              >
                {busy === "test" ? "Sending…" : "Send a test"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "off",
                    async () => {
                      setStatus(await turnOff())
                      setOpen(false)
                    },
                    "Alerts couldn’t be turned off."
                  )
                }
              >
                {busy === "off" ? "Turning off…" : "Turn off"}
              </Button>
            </Footer>
          </>
        ) : (
          <>
            <Explain title="Alerts are off">
              Turn them on to get a notification here when something on a Machine needs attention.
            </Explain>
            <Footer message={message}>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setOpen(false)
                  void enable()
                }}
              >
                Try again
              </Button>
            </Footer>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Explain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <PopoverTitle className="text-[0.9375rem] font-semibold">{title}</PopoverTitle>
      <PopoverDescription className="text-sm text-pretty">{children}</PopoverDescription>
    </div>
  )
}

function Footer({ message, children }: { message: Message | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {message && (
        <p role="status" className={cn("text-sm text-pretty", message.tone === "error" ? "text-full" : "text-muted-foreground")}>
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}
