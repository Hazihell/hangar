import { useEffect, useState } from "react"

/** The current time, re-read every `everyMs` while the page is in view, shifted by `skew`. */
export function useNow(skew: number, everyMs = 5_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // A hidden page isn't redrawn every few seconds; it catches up when shown.
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now())
    }
    const id = setInterval(tick, everyMs)
    document.addEventListener("visibilitychange", tick)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [everyMs])
  return now + skew
}
