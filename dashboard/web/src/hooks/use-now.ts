import { useEffect, useState } from "react"

/** The current time, re-read every `everyMs`, shifted by `skew`. */
export function useNow(skew: number, everyMs = 5_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now + skew
}
