// The Dashboard wire contract. Type-only: Node runs the server without a build step.

export type HistoryPoint = {
  /** Start of the minute, ISO time. */
  t: string
  cpu: number
  ram: number
  /** The fullest disk's percent. */
  disk: number
  /** The CPU's average Temperature that minute, °C; null (or absent, from an older server) when none was reported. */
  temp?: number | null
}

export type Disk = { name: string; used: number; total: number }

export type Usage = {
  at: string
  cpu: number
  ram: { used: number; total: number }
  disks: Disk[]
  services?: Record<string, boolean>
  /** °C, each only when the Machine could read it. */
  temps?: Temps
}

export type VpnStatus = "connected" | "disconnected" | "connecting" | "disconnecting"

export type VpnAction = "connect" | "disconnect"

export type Vpn = {
  name: string
  /** What the Machine's operating system last reported. */
  status: VpnStatus
  /** A command under way, until a report shows it done, it fails, or 90 s pass. */
  pending: { action: VpnAction; since: string } | null
  /** The last command failed; stays until the next command on this VPN. */
  error: { message: string; at: string } | null
}

/** A Process as the Dashboard lists it under its App. */
export type AppProcess = {
  pid: number
  /** The executable's base name. */
  name: string
  /** Percent of the whole Machine. */
  cpu: number
  /** Bytes resident. */
  ram: number
  /** Opaque; changes if the PID is reused. */
  started: string
  /** Whether the Dashboard may Quit it. */
  quit: boolean
}

/** The Processes of one program, counted together (API.md `apps`). */
export type App = {
  name: string
  cpu: number
  ram: number
  /** Processes in the App; `processes` lists at most 20 of them. */
  count: number
  /** Whether any of its Processes may be quit. */
  quit: boolean
  processes: AppProcess[]
  /** Only on the PC's `WSL` App: the Apps inside WSL. */
  apps?: App[]
}

export type Apps = { at: string; list: App[] }

/** Inside WSL, or on the Machine itself. */
export type Where = "wsl" | undefined

export type MinuteApp = { name: string; where?: "wsl"; cpu: number; ram: number }

export type MinuteResponse = { t: string; apps: MinuteApp[] }

export type PowerAction = "sleep" | "shutdown"

/** Only on a Machine the Dashboard can put to Sleep or Shut down (the PC, where the Dashboard runs). */
export type Power = {
  actions: PowerAction[]
  /** Sent; clears when the server sees it happened (it resumes or restarts). */
  pending: { action: PowerAction; since: string } | null
  /** It failed or didn't happen within 2 minutes; stays until the next power command. */
  error: { message: string; at: string } | null
}

/** One tool Hangar keeps up to date on a Machine (API.md `## Updates`). */
export type Update = {
  /** `t3`, `claude`, `codex`, `gh`, `tea` or `hangar`. */
  id: string
  name: string
  current: string | null
  latest: string | null
  /** Only for `hangar`: how many commits behind `origin/main` it is. */
  behind?: number | null
  available: boolean
  /** Why the Dashboard can't update it, else null. A blocked item still says `available`. */
  blocked: string | null
}

export type Updates = {
  checkedAt: string | null
  checking: boolean
  items: Update[]
  pending: { items: string[]; since: string } | null
  error: { message: string; at: string } | null
}

export type T3Thread = { title: string; status: string }

export type MachineIdentity = { id: string; name: string; os: string }
export type ConfiguredMachine = MachineIdentity & { collector: string; ssh?: string }

export type LevelLimits = { high: number; hot: number }
export type Attention = { tag: string; title: string; body: string }
export type MachineLimits = {
  vpnMs: number
  powerMs: number
  updateMs: number
  processes: number
  maxTargets: number
  usage: Record<"cpu" | "ram" | "disk", LevelLimits>
}

export type Machine = MachineIdentity & {
  limits?: MachineLimits
  /** Active Alert conditions, including those muted by cooldown. */
  attention?: Attention[]
  online: boolean
  lastSeen: string | null
  usage: Usage | null
  /** From the latest report; `[]` if none. */
  vpns: Vpn[]
  /** `null` until the Machine has sent Processes. */
  apps: Apps | null
  /** The CPU Temperature Alert's thresholds, °C: past `high` it reads warm, past `hot` hot. Null when that Alert is off. */
  tempLimits?: LevelLimits | null
  /** Absent unless the Dashboard can put this Machine to Sleep or Shut it down. */
  power?: Power
  /** On every Machine from a server that checks Updates. */
  updates?: Updates
  history: HistoryPoint[]
}

export type MachinesResponse = {
  now: string
  machines: Machine[]
  /** Which Dashboard build the server serves; a new one means this page is out of date. */
  build?: string
}

/** Data of a `machine` server-sent event. */
export type MachineEvent = Omit<Machine, "history" | "apps"> & {
  /** Absent from an older server's events: keep what we had. */
  apps?: Apps | null
  minute?: HistoryPoint | null
}

export type Channel = "cpu" | "temp" | "ram" | "disk"

// Reporter input and command answers share the same wire seam as snapshots.
export type Temps = { cpu?: number; gpu?: number }
export type ReportVpn = { name: string; status: VpnStatus; kind: "ppp" | "other" }
export type Process = { pid: number; name: string; app: string; cpu: number; ram: number; started: string; own: boolean }
export type Report = { machine: string; cpu: number; ram: { used: number; total: number }; disks: Disk[]; services?: Record<string, boolean>; vpns?: ReportVpn[]; processes?: Process[]; wsl?: Process[]; reporterPid?: number; temps?: Temps }
export type QuitTarget = { pid: number; started: string; where?: "wsl" }
export type QuitOutcome = "sent" | "gone" | "changed" | "protected" | "failed"
export type QuitProcessResult = { pid: number; result: QuitOutcome; message?: string }
export type QuitResult = QuitProcessResult & { started: string; where?: "wsl" }
export type QuitSelection = { targets: QuitTarget[]; app?: never; where?: never } | { app: string; where?: "wsl"; targets?: never }
export type QuitRequest = QuitSelection & { force: boolean }
export type QuitResponse = { results: QuitResult[] }
