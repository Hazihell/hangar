// The Dashboard's past: 24 h of History and Top Apps, written by the real Usage module from the fleet's reports, one per
// minute, as if the Dashboard had been running all that time.
import { DatabaseSync } from "node:sqlite"
import { Usage } from "../../../server/usage.ts"
import { DAY, MINUTE, minuteStart } from "./fixtures.ts"
import type { Fleet } from "./fleet.ts"

/** Seeds every Machine's History through the minute before `until(machine)`; the caller says when each one last reported. */
export function seedHistory(dbPath: string, fleet: Fleet, now: number, until: (id: string) => number) {
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF") // a throwaway database: no need to wait for the disk
  const usage = new Usage(db, fleet.machines)
  for (const p of fleet.personas.values()) {
    if (!p.history) continue
    const end = minuteStart(until(p.machine.id))
    for (let t = minuteStart(now - DAY) + MINUTE; t < end; t += MINUTE) {
      if (p.missRate && p.rand() < p.missRate) continue
      if (p.silent && t > now - p.silent[1] * 60 * MINUTE && t < now - p.silent[0] * 60 * MINUTE) continue
      const result = usage.intake(fleet.report(p.machine.id, t, false), t)
      if (result.status !== 204) throw new Error(`seeding ${p.machine.id} at ${new Date(t).toISOString()}: HTTP ${result.status}`)
    }
  }
  db.close()
}
