import { Card } from "@/components/ui/card"
import { Meter } from "@/components/ui/meter"
import { Separator } from "@/components/ui/separator"
import { PenMark } from "@/components/status"
import { Trace } from "@/components/trace"
import { VpnList } from "@/components/vpn-list"
import {
  formatAbsolute,
  formatPercent,
  formatRelative,
  formatUsedOfTotal,
  fullestDisk,
  levelOf,
  percent,
  type Level,
} from "@/lib/format"
import { toTrace, type TracePoint } from "@/lib/history"
import type { Channel, Disk, Machine } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useMemo } from "react"

const OS_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" }

/** Said in words as well as color. */
const FLAGS: Record<Level, string | undefined> = { ok: undefined, high: "high", full: "nearly full" }

const LEVEL_TEXT: Record<Level, string> = {
  ok: "",
  high: "text-high",
  full: "text-full",
}

/** One Machine as a recorder sheet: status, three channels, drives, services, VPNs. */
export function MachineSheet({
  machine,
  now,
  heardAt = null,
}: {
  machine: Machine
  now: number
  /** Set while the server can't be reached: when we last heard from it (server clock). */
  heardAt?: number | null
}) {
  const { usage, online } = machine
  const points = useMemo(() => toTrace(machine.history), [machine.history])
  const lastSeen = machine.lastSeen ? Date.parse(machine.lastSeen) : null

  return (
    <Card
      id={machine.id}
      aria-labelledby={`${machine.id}-name`}
      className={cn(
        "scroll-mt-6 gap-0 rounded-xl py-0 text-base ring-1 transition-colors duration-200",
        online
          ? "bg-card ring-border shadow-[0_1px_2px_oklch(0.3_0.02_200/0.06),0_4px_16px_-8px_oklch(0.3_0.02_200/0.12)] dark:shadow-none"
          : "bg-transparent ring-border"
      )}
    >
      <header className="flex flex-col gap-1.5 px-5 pt-5 pb-4 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={`${machine.id}-name`} className="text-xl leading-tight font-semibold tracking-[-0.01em]">
            {machine.name}
          </h2>
          <span className="text-sm text-muted-foreground">{OS_NAMES[machine.os] ?? machine.os}</span>
        </div>
        <p className="flex items-center gap-2 text-[0.9375rem]">
          <PenMark online={online} />
          {online ? (
            <span className="font-medium">
              Online
              {heardAt !== null && (
                <span className="font-normal text-muted-foreground"> · when last heard, {formatRelative(heardAt, now)}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground/80">Offline</span>
              {lastSeen !== null ? (
                <>
                  {" · Last seen "}
                  <time dateTime={machine.lastSeen!} title={formatAbsolute(lastSeen)}>
                    {formatRelative(lastSeen, now)}
                  </time>
                </>
              ) : (
                " · Never reported"
              )}
            </span>
          )}
        </p>
      </header>

      <Separator />

      {usage ? (
        <div className="flex flex-col gap-5 px-5 pt-4 pb-5 sm:px-6">
          <div className={cn("flex flex-col gap-4", !online && "text-muted-foreground")}>
            <ChannelRow
              channel="cpu"
              label="CPU"
              value={usage.cpu}
              level="ok"
              points={points}
              now={now}
              lifted={!online}
            />
            <ChannelRow
              channel="ram"
              label="RAM"
              value={percent(usage.ram.used, usage.ram.total)}
              detail={formatUsedOfTotal(usage.ram.used, usage.ram.total)}
              flag={online ? FLAGS[levelOf(percent(usage.ram.used, usage.ram.total))] : undefined}
              points={points}
              now={now}
              lifted={!online}
            />
            <DiskChannel disks={usage.disks} points={points} now={now} lifted={!online} />
          </div>

          {usage.disks.length > 1 && <DriveList disks={usage.disks} muted={!online} />}

          {(usage.services?.t3 !== undefined || machine.vpns.length > 0) && (
            // What runs on the Machine, under one dashed rule.
            <div className="flex flex-col gap-4 border-t border-dashed pt-4">
              {usage.services?.t3 !== undefined && (
                <ServiceRow name="T3 service" running={usage.services.t3} muted={!online} />
              )}
              <VpnList
                machine={machine}
                muted={!online}
                locked={
                  !online
                    ? `${machine.name} is Offline.`
                    : heardAt !== null
                      ? "The Dashboard can’t reach the server."
                      : null
                }
              />
            </div>
          )}
        </div>
      ) : (
        <NoUsage />
      )}
    </Card>
  )
}

function ChannelRow({
  channel,
  label,
  value,
  level = levelOf(value),
  detail,
  flag,
  points,
  now,
  lifted,
  showTimes = false,
}: {
  channel: Channel
  label: string
  value: number
  level?: Level
  detail?: React.ReactNode
  /** A short red note under the detail, e.g. "nearly full". */
  flag?: string
  points: TracePoint[]
  now: number
  lifted: boolean
  showTimes?: boolean
}) {
  return (
    <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] items-start gap-x-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col">
        <span className="text-[0.8125rem] font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            "readings text-[2rem] leading-[1.05] font-semibold",
            !lifted && LEVEL_TEXT[level]
          )}
        >
          {formatPercent(value)}
        </span>
        {detail && <span className="mt-0.5 truncate text-[0.8125rem] text-muted-foreground tnum">{detail}</span>}
        {flag && <span className={cn("text-[0.8125rem] font-medium", LEVEL_TEXT[level])}>{flag}</span>}
      </div>
      <Trace
        points={points}
        channel={channel}
        now={now}
        level={level}
        lifted={lifted}
        showTimes={showTimes}
      />
    </div>
  )
}

function DiskChannel({
  disks,
  points,
  now,
  lifted,
}: {
  disks: Disk[]
  points: TracePoint[]
  now: number
  lifted: boolean
}) {
  const fullest = fullestDisk(disks)
  const value = fullest ? percent(fullest.used, fullest.total) : 0
  const level = levelOf(value)
  const detail = !fullest
    ? "No drives reported"
    : disks.length === 1
      ? formatUsedOfTotal(fullest.used, fullest.total)
      : `on ${fullest.name}`

  return (
    <ChannelRow
      channel="disk"
      label="Disk"
      value={value}
      level={level}
      detail={detail}
      flag={lifted ? undefined : FLAGS[level]}
      points={points}
      now={now}
      lifted={lifted}
      showTimes
    />
  )
}

const INDICATOR: Record<Level, string> = {
  ok: "[&_[data-slot=meter-indicator]]:bg-ink-disk",
  high: "[&_[data-slot=meter-indicator]]:bg-high",
  full: "[&_[data-slot=meter-indicator]]:bg-full",
}

function DriveList({ disks, muted }: { disks: Disk[]; muted: boolean }) {
  return (
    <ul aria-label="Drives" className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {disks.map((disk) => {
        const value = percent(disk.used, disk.total)
        const level = levelOf(value)
        return (
          <li key={disk.name} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[0.875rem]">
              <span className="font-medium">{disk.name}</span>
              <span className="text-muted-foreground tnum">
                {formatUsedOfTotal(disk.used, disk.total)}
                <span className={cn("ml-2 font-semibold text-foreground", !muted && LEVEL_TEXT[level], muted && "text-muted-foreground")}>
                  {formatPercent(value)}
                </span>
              </span>
            </div>
            <Meter
              value={Math.min(100, value)}
              aria-label={`${disk.name} used`}
              className={cn(
                "[&_[data-slot=meter-track]]:h-1.5 [&_[data-slot=meter-track]]:bg-grid",
                muted ? "[&_[data-slot=meter-indicator]]:bg-muted-foreground/50" : INDICATOR[level]
              )}
            />
          </li>
        )
      })}
    </ul>
  )
}

function ServiceRow({ name, running, muted }: { name: string; running: boolean; muted: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[0.9375rem]">
      <span className="font-medium">{name}</span>
      <span
        className={cn(
          "flex items-center gap-2",
          muted ? "text-muted-foreground" : running ? "text-foreground" : "font-medium text-high"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            muted ? "bg-muted-foreground/60" : running ? "bg-online" : "bg-high"
          )}
        />
        {running ? "Running" : "Stopped"}
      </span>
    </div>
  )
}

function NoUsage() {
  return (
    <div className="px-5 pt-4 pb-5 sm:px-6">
      <div className="rounded-lg bg-[linear-gradient(var(--grid)_1px,transparent_1px),linear-gradient(90deg,var(--grid)_1px,transparent_1px)] bg-size-[2.5rem_1rem] bg-position-[-1px_-1px] px-4 py-6 text-center ring-1 ring-border">
        <p className="inline-block max-w-[90%] rounded-md bg-background px-3 py-1.5 text-[0.9375rem] text-balance text-muted-foreground">
          No Usage yet: this Machine hasn’t reported.
        </p>
      </div>
    </div>
  )
}
