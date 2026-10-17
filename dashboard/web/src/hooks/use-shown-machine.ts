import { useEffect, useState } from "react"

const RING_MS = 1_800

/**
 * Brings the Machine named in the URL hash (`/#stormtrooper`) into view and
 * returns its id for a moment so its sheet can ring: on load once the sheets
 * exist, on every hash change, and when the service worker says an Alert about
 * it was clicked.
 */
export function useShownMachine(ready: boolean): string | null {
  const [shown, setShown] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    let timer: ReturnType<typeof setTimeout> | undefined

    const show = (id: string) => {
      const sheet = document.getElementById(id)
      if (!sheet) return
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches
      sheet.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" })
      clearTimeout(timer)
      setShown(id)
      timer = setTimeout(() => setShown(null), RING_MS)
    }
    const fromHash = () => {
      let id: string
      try {
        id = decodeURIComponent(location.hash.slice(1))
      } catch {
        return // A malformed hash (say `#%`) names no Machine.
      }
      if (id) show(id)
    }
    const fromWorker = (event: MessageEvent) => {
      const data = event.data as { type?: string; machine?: unknown } | null
      if (data?.type !== "show-machine" || typeof data.machine !== "string") return
      if (location.hash.slice(1) === data.machine) show(data.machine)
      else location.hash = data.machine
    }

    fromHash()
    window.addEventListener("hashchange", fromHash)
    navigator.serviceWorker?.addEventListener("message", fromWorker)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("hashchange", fromHash)
      navigator.serviceWorker?.removeEventListener("message", fromWorker)
    }
  }, [ready])

  return shown
}
