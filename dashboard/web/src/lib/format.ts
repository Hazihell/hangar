import type { Disk } from "@/lib/types"

/** Narrow no-break space, between a number and its unit. */
export const NNBSP = " "

const GiB = 1024 ** 3
const TiB = 1024 ** 4

/** Bytes in binary units, labelled GB/TB as the operating systems do. */
export function formatBytes(bytes: number, { unit = true } = {}): string {
  const [value, label] = bytes >= TiB ? [bytes / TiB, "TB"] : [bytes / GiB, "GB"]
  const digits = value >= 100 ? 0 : 1
  const n = value.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: digits })
  return unit ? `${n}${NNBSP}${label}` : n
}

const MiB = 1024 ** 2

/** An App's or Process's RAM: MB below a gigabyte, otherwise like formatBytes. */
export function formatRam(bytes: number): string {
  const mb = bytes / MiB
  if (mb >= 999.5) return formatBytes(bytes)
  if (mb < 1) return `<1${NNBSP}MB`
  return `${Math.round(mb)}${NNBSP}MB`
}

/** "used of total", sharing the unit when both fall in the same one. */
export function formatUsedOfTotal(used: number, total: number): string {
  const sameUnit = (used >= TiB) === (total >= TiB)
  return `${formatBytes(used, { unit: !sameUnit })} of ${formatBytes(total)}`
}

export function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 1) return `<1${NNBSP}%`
  return `${Math.round(value)}${NNBSP}%`
}

/** How full a percent reads: ordinary, high (80 %+) or nearly full (90 %+). */
export type Level = "ok" | "high" | "full"

export function levelOf(value: number): Level {
  // Classify what formatPercent shows, so 89.6 reads "90 %" and "full".
  const shown = Math.round(value)
  if (shown >= 90) return "full"
  if (shown >= 80) return "high"
  return "ok"
}

export function fullestDisk(disks: Disk[]): Disk | undefined {
  return disks.reduce<Disk | undefined>(
    (best, d) => (!best || percent(d.used, d.total) > percent(best.used, best.total) ? d : best),
    undefined
  )
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/** "40 seconds ago", "2 hours ago", "yesterday". */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return rtf.format(-seconds, "second")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return rtf.format(-minutes, "minute")
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return rtf.format(-hours, "hour")
  return rtf.format(-Math.floor(hours / 24), "day")
}

const absolute = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
})

export function formatAbsolute(at: number): string {
  return absolute.format(at)
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

export function formatClock(at: number): string {
  return clock.format(at)
}
