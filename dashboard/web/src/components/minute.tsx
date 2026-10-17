import { XIcon } from "lucide-react"
import { useRef, useState } from "react"

import { LABELS, PLOT } from "@/components/trace"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatClock, formatPercent, formatRam, formatRelative } from "@/lib/format"
import { DAY } from "@/lib/history"
import { bucketAt, bucketOf, peakOf, useMinute, type Bucket, type Minute } from "@/lib/minutes"
import type { Channel, MinuteApp } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A minute picked on one of a sheet's traces. */
export type Mark = { minute: Minute; channel: Channel }

/** Where a time sits across a trace's plot, 0 to 1. */
const ratioOf = (t: number, now: number) => Math.min(1, Math.max(0, (t - (now - DAY)) / DAY))

/** CSS left of a time on the trace: the plot runs from PLOT.left to PLOT.right short of the edge. */
const leftOf = (t: number, now: number) =>
  `calc(${PLOT.left}px + ${ratioOf(t, now)} * (100% - ${PLOT.left + PLOT.right}px))`

/**
 * Lies over a trace and turns it into a way to pick a History minute: hover
 * (or drag a finger) to see a minute's time and value, click or tap to open its
 * Top Apps, or focus it and use the arrow keys and Enter. Each 10-minute point
 * stands for its busiest minute in this channel, where a spike's cause is.
 */
export function Scrubber({
  channel,
  buckets,
  now,
  showTimes,
  hover,
  pin,
  hintId,
  onHover,
  onPin,
}: {
  channel: Channel
  buckets: Bucket[]
  now: number
  showTimes: boolean
  hover: Mark | null
  pin: Mark | null
  hintId: string
  onHover: (mark: Mark | null) => void
  onPin: (mark: Mark | null) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [touching, setTouching] = useState(false)
  const label = LABELS[channel]

  const markAt = (clientX: number): Mark | null => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect || buckets.length === 0) return null
    const ratio = (clientX - rect.left - PLOT.left) / (rect.width - PLOT.left - PLOT.right)
    const i = bucketAt(buckets, now - DAY + ratio * DAY)
    return i === -1 ? null : { minute: peakOf(buckets[i], channel), channel }
  }

  const mine = hover?.channel === channel ? hover : null
  const current = mine ?? (pin ? { minute: pin.minute, channel } : null)
  const index = current ? bucketOf(buckets, current.minute) : buckets.length - 1

  const move = (to: number) => {
    const i = Math.max(0, Math.min(buckets.length - 1, to))
    if (buckets[i]) onHover({ minute: peakOf(buckets[i], channel), channel })
  }

  const toggle = (mark: Mark | null) => {
    if (!mark) return
    onPin(pin?.minute.t === mark.minute.t ? null : mark)
  }

  const valueText = current
    ? `${formatClock(current.minute.ms)}, ${label} ${formatPercent(current.minute[channel])}`
    : `${label} History`

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={buckets.length > 0 ? 0 : -1}
      aria-label={`${label} History`}
      aria-describedby={hintId}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, buckets.length - 1)}
      aria-valuenow={Math.max(0, index)}
      aria-valuetext={valueText}
      className={cn(
        "absolute inset-0 cursor-crosshair touch-pan-y rounded-sm outline-offset-2",
        buckets.length === 0 && "pointer-events-none"
      )}
      onPointerMove={(e) => {
        if (e.pointerType === "touch" && !touching) return
        onHover(markAt(e.clientX))
      }}
      onPointerDown={(e) => e.pointerType === "touch" && setTouching(true)}
      onPointerUp={() => setTouching(false)}
      onPointerCancel={() => {
        setTouching(false)
        onHover(null)
      }}
      onPointerLeave={(e) => e.pointerType !== "touch" && onHover(null)}
      onClick={(e) => {
        toggle(markAt(e.clientX))
        if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === "touch") onHover(null)
      }}
      onFocus={(e) => {
        // Keyboard focus starts at the open minute, or the latest one.
        if (e.currentTarget.matches(":focus-visible") && !mine) move(index === -1 ? buckets.length - 1 : index)
      }}
      onBlur={() => mine && onHover(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 6 : 1
        const from = index === -1 ? buckets.length - 1 : index
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") move(from - step)
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") move(from + step)
        else if (e.key === "PageDown") move(from - 6)
        else if (e.key === "PageUp") move(from + 6)
        else if (e.key === "Home") move(0)
        else if (e.key === "End") move(buckets.length - 1)
        else if (e.key === "Enter" || e.key === " ") toggle(current)
        else if (e.key === "Escape" && (pin || mine)) {
          onPin(null)
          onHover(null)
        } else return
        e.preventDefault()
      }}
    >
      {mine && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-10 flex flex-col rounded-md bg-card/95 px-1.5 py-0.5 text-[0.6875rem] leading-tight whitespace-nowrap shadow-[0_1px_3px_oklch(0.3_0.02_200/0.12)] ring-1 ring-border",
            ratioOf(mine.minute.ms, now) > 0.55 ? "-translate-x-[calc(100%+6px)]" : "translate-x-[6px]"
          )}
          style={{ left: leftOf(mine.minute.ms, now), top: showTimes ? 4 : 2 }}
        >
          <span className="tnum">
            <span className="text-muted-foreground">{formatClock(mine.minute.ms)}</span>{" "}
            <span className="font-medium text-foreground">
              {label === "Fullest disk" ? "Disk" : label} {formatPercent(mine.minute[channel])}
            </span>
          </span>
          {pin?.minute.t !== mine.minute.t && <span className="text-muted-foreground">Click for Top Apps</span>}
        </span>
      )}
    </div>
  )
}

/**
 * The Top Apps of a picked minute, under the sheet's traces, with a notch
 * pointing up at the minute. Sorted by the channel it was picked on.
 */
export function MinutePanel({
  machineId,
  pin,
  now,
  latest,
  ramTotal,
  onClose,
}: {
  machineId: string
  pin: Mark
  now: number
  /** The pinned minute is the current one, still filling in. */
  latest: boolean
  ramTotal: number
  onClose: () => void
}) {
  const { minute } = pin
  const { state, retry } = useMinute(machineId, minute.t, latest)
  const by: "cpu" | "ram" = pin.channel === "ram" ? "ram" : "cpu"
  const apps =
    state.status === "ok" ? state.data.apps.slice().sort((a, b) => (by === "cpu" ? b.cpu - a.cpu : b.ram - a.ram)) : []

  return (
    <div
      className="flex flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {/* The notch, over the trace column, at the minute. */}
      <div aria-hidden className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <span />
        <span className="relative h-1.5">
          <span
            className="absolute top-0.5 size-2.5 -translate-x-1/2 rotate-45 border-t border-l bg-background"
            style={{ left: leftOf(minute.ms, now) }}
          />
        </span>
      </div>
      <section
        aria-labelledby={`${machineId}-minute`}
        className="flex flex-col gap-2 rounded-lg bg-background px-3.5 pt-2.5 pb-3 ring-1 ring-border"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <h3 id={`${machineId}-minute`} className="text-[0.9375rem] font-medium">
              Top Apps at <span className="tnum">{formatClock(minute.ms)}</span>
              <span className="font-normal text-muted-foreground"> · {formatRelative(minute.ms, now)}</span>
            </h3>
            <p className="text-[0.8125rem] text-muted-foreground tnum">
              CPU {formatPercent(minute.cpu)} · RAM {formatPercent(minute.ram)} that minute
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Top Apps"
            onClick={onClose}
            className="relative -mt-0.5 -mr-1.5 text-muted-foreground after:absolute after:-inset-2 after:content-['']"
          >
            <XIcon />
          </Button>
        </header>

        <div aria-live="polite" aria-busy={state.status === "loading"}>
          {state.status === "loading" && (
            <div className="flex flex-col gap-2 py-1">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-5" style={{ width: `${88 - i * 14}%` }} />
              ))}
              <span className="sr-only">Loading this minute’s Top Apps…</span>
            </div>
          )}
          {state.status === "missing" && (
            <p className="py-1 text-sm text-muted-foreground">No Top Apps were kept for this minute.</p>
          )}
          {state.status === "error" && (
            <div className="flex items-center justify-between gap-3 py-0.5">
              <p className="text-sm text-muted-foreground">Couldn’t load this minute’s Top Apps.</p>
              <Button variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            </div>
          )}
          {state.status === "ok" &&
            (apps.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">No Apps were recorded in this minute.</p>
            ) : (
              <ul aria-label={`Top Apps at ${formatClock(minute.ms)}`} className="flex flex-col">
                <li aria-hidden className="grid grid-cols-[minmax(0,1fr)_3.25rem_4.5rem] gap-x-3 pb-0.5 text-xs text-muted-foreground">
                  <span />
                  <span className={cn("text-right", by === "cpu" && "font-medium text-foreground")}>CPU</span>
                  <span className={cn("text-right", by === "ram" && "font-medium text-foreground")}>RAM</span>
                </li>
                {apps.map((app) => (
                  <TopAppRow
                    key={`${app.where ?? ""}|${app.name}`}
                    app={app}
                    by={by}
                    whole={by === "cpu" ? minute.cpu : (minute.ram / 100) * ramTotal}
                  />
                ))}
              </ul>
            ))}
        </div>
      </section>
    </div>
  )
}

/** One of a minute's Top Apps, with the same share meter as the Apps list: its part of what the Machine used that minute. */
function TopAppRow({ app, by, whole }: { app: MinuteApp; by: "cpu" | "ram"; whole: number }) {
  const share = whole > 0 ? Math.min(100, ((by === "cpu" ? app.cpu : app.ram) / whole) * 100) : 0
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_3.25rem_4.5rem] items-center gap-x-3 py-1.5">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm">{app.name}</span>
          {app.where === "wsl" && (
            <span className="shrink-0 text-xs text-muted-foreground">
              <span className="sr-only">, </span>in WSL
            </span>
          )}
        </span>
        <span aria-hidden className="h-[3px] max-w-40 rounded-full bg-grid">
          <span
            className={cn("block h-full rounded-full", by === "cpu" ? "bg-ink-cpu" : "bg-ink-ram")}
            style={{ width: `${share}%` }}
          />
        </span>
      </span>
      <span className={cn("text-right text-sm tnum", by === "cpu" ? "text-foreground" : "text-muted-foreground")}>
        {formatPercent(app.cpu)}
      </span>
      <span className={cn("text-right text-sm tnum", by === "ram" ? "text-foreground" : "text-muted-foreground")}>
        {formatRam(app.ram)}
      </span>
    </li>
  )
}
