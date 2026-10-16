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

export type Machine = {
  id: string
  name: string
  os: string
  online: boolean
  lastSeen: string | null
  usage: Usage | null
  history: HistoryPoint[]
}

export type MachinesResponse = { now: string; machines: Machine[] }

/** Data of a `machine` server-sent event. */
export type MachineEvent = Omit<Machine, "history"> & {
  minute?: HistoryPoint | null
}

export type Channel = "cpu" | "ram" | "disk"
