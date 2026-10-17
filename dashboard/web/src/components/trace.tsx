import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"

import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { formatClock, type Level } from "@/lib/format"
import { DAY, type TracePoint } from "@/lib/history"
import type { Channel } from "@/lib/types"
import { cn } from "@/lib/utils"

const HOUR = 60 * 60 * 1000

/** Whole local hours divisible by 3 within the last 24 h: the paper's columns. */
function gridTicks(now: number): number[] {
  const ticks: number[] = []
  const start = new Date(now - DAY)
  start.setMinutes(0, 0, 0)
  for (let t = start.getTime() + HOUR; t <= now; t += HOUR) {
    if (new Date(t).getHours() % 3 === 0) ticks.push(t)
  }
  return ticks
}

/**
 * Room labels need, in px, at the axis's 11px type: half of "00:00" (centred
 * on its tick), "now" (right-aligned at the end) and a gap between them.
 */
const HALF_CLOCK = 17
const NOW_LABEL = 22
const LABEL_GAP = 8

/** A clock label at `t` neither runs into "now" nor gets clipped at the left edge. */
function clearOfEdges(t: number, now: number, plotWidth: number): boolean {
  if (!(plotWidth > 0)) return now - t > 2 * HOUR && t - (now - DAY) > HOUR
  const px = plotWidth / DAY
  return (now - t) * px >= HALF_CLOCK + LABEL_GAP + NOW_LABEL && (t - (now - DAY)) * px >= HALF_CLOCK
}

export const LABELS: Record<Channel, string> = { cpu: "CPU", temp: "CPU temperature", ram: "RAM", disk: "Fullest disk" }

/** The plot inside a trace, in px from its box: where time runs. */
export const PLOT = { left: 1, right: 5, top: 5, bottom: 5, axis: 20 }

/**
 * One channel of the recorder: the last 24 h of History on chart paper whose
 * grid is the real scale (columns every 3 h, rows every 25 %). The pen rests
 * on the latest point; when the Machine is Offline the pen is lifted.
 */
export function Trace({
  points,
  channel,
  now,
  level,
  lifted,
  showTimes,
  hoverAt = null,
  pinAt = null,
  children,
}: {
  points: TracePoint[]
  channel: Channel
  now: number
  level: Level
  lifted: boolean
  showTimes: boolean
  /** A minute being pointed at (on any of the sheet's traces): a dotted rule. */
  hoverAt?: number | null
  /** The minute whose Top Apps are open: a solid rule. */
  pinAt?: number | null
  /** Drawn over the trace: the scrubber. */
  children?: React.ReactNode
}) {
  const ink = lifted
    ? `var(--ink-${channel})`
    : level === "full"
      ? "var(--full)"
      : level === "high"
        ? "var(--high)"
        : `var(--ink-${channel})`
  const config = { [channel]: { label: LABELS[channel], color: ink } } satisfies ChartConfig
  const last = points.at(-1)
  const ticks = gridTicks(now)

  return (
    <div className="relative min-w-0">
      <ChartContainer
        config={config}
        className={cn("aspect-auto w-full", showTimes ? "h-[5rem]" : "h-[3.75rem]")}
        initialDimension={{ width: 240, height: 56 }}
      >
        <AreaChart data={points} margin={{ top: PLOT.top, right: PLOT.right, bottom: PLOT.bottom, left: PLOT.left }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} horizontal={false} verticalValues={ticks} />
          {[0, 25, 50, 75, 100].map((y) => (
            <ReferenceLine key={y} y={y} stroke="var(--grid)" strokeWidth={1} ifOverflow="extendDomain" />
          ))}
          <XAxis
            dataKey="x"
            type="number"
            scale="time"
            domain={[now - DAY, now]}
            ticks={showTimes ? [...ticks, now] : ticks}
            allowDataOverflow
            hide={!showTimes}
            height={20}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            interval={0}
            tick={({
              x,
              y,
              width,
              payload,
            }: {
              x: number | string
              y: number | string
              width?: number | string
              payload: { value: number }
            }) => {
              const t = payload.value
              const label = t === now ? "now" : new Date(t).getHours() % 6 === 0 && clearOfEdges(t, now, Number(width)) ? formatClock(t) : ""
              return (
                <text x={x} y={y} dy="0.71em" textAnchor={t === now ? "end" : "middle"} className="fill-muted-foreground tnum text-[0.6875rem]">
                  {label}
                </text>
              )
            }}
          />
          <YAxis domain={[0, 100]} hide allowDataOverflow />
          <Area
            dataKey={channel}
            type="monotone"
            stroke={`var(--color-${channel})`}
            strokeWidth={1.5}
            strokeOpacity={lifted ? 0.5 : 1}
            fill={`var(--color-${channel})`}
            fillOpacity={lifted ? 0.05 : channel === "disk" ? 0.05 : 0.09}
            connectNulls={false}
            isAnimationActive={false}
            dot={false}
            activeDot={false}
          />
          {pinAt !== null && (
            <ReferenceLine x={pinAt} stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1} ifOverflow="hidden" />
          )}
          {hoverAt !== null && hoverAt !== pinAt && (
            <ReferenceLine x={hoverAt} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="2 2" ifOverflow="hidden" />
          )}
          {last && last[channel] != null && (
            <ReferenceDot
              x={last.x}
              y={last[channel]}
              r={lifted ? 3 : 3.5}
              fill={lifted ? "var(--card)" : `var(--color-${channel})`}
              stroke={`var(--color-${channel})`}
              strokeOpacity={lifted ? 0.6 : 1}
              strokeWidth={1.5}
              ifOverflow="visible"
            />
          )}
        </AreaChart>
      </ChartContainer>
      {children}
    </div>
  )
}
