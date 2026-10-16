import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatClock, formatPercent, type Level } from "@/lib/format"
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

const LABELS: Record<Channel, string> = { cpu: "CPU", ram: "RAM", disk: "Fullest disk" }

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
}: {
  points: TracePoint[]
  channel: Channel
  now: number
  level: Level
  lifted: boolean
  showTimes: boolean
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
    <ChartContainer
      config={config}
      className={cn("aspect-auto w-full", showTimes ? "h-[5rem]" : "h-[3.75rem]")}
      initialDimension={{ width: 240, height: 56 }}
    >
      <AreaChart data={points} margin={{ top: 5, right: 5, bottom: 5, left: 1 }} accessibilityLayer={false}>
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
          tick={({ x, y, payload }: { x: number | string; y: number | string; payload: { value: number } }) => {
            const t = payload.value
            const label = t === now ? "now" : new Date(t).getHours() % 6 === 0 && now - t > 2 * HOUR ? formatClock(t) : ""
            return (
              <text x={x} y={y} dy="0.71em" textAnchor={t === now ? "end" : "middle"} className="fill-muted-foreground tnum text-[0.6875rem]">
                {label}
              </text>
            )
          }}
        />
        <YAxis domain={[0, 100]} hide allowDataOverflow />
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "2 2" }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, _name, item) => (
                <div className="flex w-full items-baseline justify-between gap-3">
                  <span className="text-muted-foreground tnum">{formatClock((item.payload as TracePoint).x)}</span>
                  <span className="font-medium tnum">
                    {LABELS[channel]} {formatPercent(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
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
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
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
  )
}
