// Shapes from dashboard/API.md.

export type HistoryPoint = {
  /** Start of the minute, ISO time. */
  t: string
  cpu: number
  ram: number
  /** The fullest disk's percent. */
  disk: number
}

export type Disk = { name: string; used: number; total: number }

export type Usage = {
  at: string
  cpu: number
  ram: { used: number; total: number }
  disks: Disk[]
  services?: { t3?: boolean }
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

export type Machine = {
  id: string
  name: string
  os: string
  online: boolean
  lastSeen: string | null
  usage: Usage | null
  /** From the latest report; `[]` if none. */
  vpns: Vpn[]
  /** `null` until the Machine has sent Processes. */
  apps: Apps | null
  /** Absent unless the Dashboard can put this Machine to Sleep or Shut it down. */
  power?: Power
  history: HistoryPoint[]
}

export type MachinesResponse = { now: string; machines: Machine[] }

/** Data of a `machine` server-sent event. */
export type MachineEvent = Omit<Machine, "history" | "apps"> & {
  /** Absent from an older server's events: keep what we had. */
  apps?: Apps | null
  minute?: HistoryPoint | null
}

export type Channel = "cpu" | "ram" | "disk"
