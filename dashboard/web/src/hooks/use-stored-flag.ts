import { useCallback, useState } from "react"

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === "1"
  } catch {
    return fallback
  }
}

/** A boolean remembered in localStorage (where storage is available). */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => read(key, fallback))
  const set = useCallback(
    (next: boolean) => {
      setValue(next)
      try {
        localStorage.setItem(key, next ? "1" : "0")
      } catch {
        // Private mode or storage full: it just won't be remembered.
      }
    },
    [key]
  )
  return [value, set]
}
