import { processKey, type QuitTarget } from "@/lib/quit"
import type { App, AppProcess, Apps, Where } from "@/lib/types"

export type SortBy = "cpu" | "ram"

/** How many Apps a list shows. */
export const SHOWN = 10

/** Every Process in the latest report, by key: what is still running. */
export function indexProcesses(apps: Apps | null): Map<string, { process: AppProcess; where: Where }> {
  const index = new Map<string, { process: AppProcess; where: Where }>()
  const walk = (list: App[], where: Where) => {
    for (const app of list) {
      for (const p of app.processes) index.set(processKey(where, p.pid, p.started), { process: p, where })
      if (app.apps) walk(app.apps, "wsl")
    }
  }
  if (apps) walk(apps.list, undefined)
  return index
}

/** The App called `name`, on the Machine itself or inside WSL. */
export function findApp(apps: Apps | null, name: string, where: Where): App | undefined {
  if (!apps) return undefined
  if (where === "wsl") return apps.list.find((a) => a.apps)?.apps?.find((a) => a.name === name)
  return apps.list.find((a) => a.name === name && !a.apps)
}

/** The Processes of `app` the Dashboard may Quit, as a Quit takes them. */
export function quittable(app: App, where: Where): QuitTarget[] {
  return app.processes.filter((p) => p.quit).map((p) => ({ pid: p.pid, started: p.started, ...(where ? { where } : {}) }))
}

/** The value a list sorts by: CPU percent, or RAM in bytes. */
export const valueOf = (app: { cpu: number; ram: number }, by: SortBy) => (by === "cpu" ? app.cpu : app.ram)

/**
 * A new order for a live list that doesn't shuffle on every report: starting
 * from the order on screen, an App moves above its neighbour only when it
 * clearly overtakes it (15 % more, and by more than noise). New Apps join in
 * sorted place; Apps that left drop out. `frozen` keeps the order as it is.
 */
export function steadyOrder<T extends { name: string }>(
  previous: string[],
  items: T[],
  value: (item: T) => number,
  noise: number,
  frozen: boolean
): string[] {
  const byName = new Map(items.map((i) => [i.name, i]))
  const kept = previous.filter((n) => byName.has(n))
  const keptSet = new Set(kept)
  const added = items.filter((i) => !keptSet.has(i.name)).sort((a, b) => value(b) - value(a))

  if (frozen) return [...kept, ...added.map((i) => i.name)]

  const order = kept.map((n) => byName.get(n)!)
  // Insert newcomers where they belong.
  for (const item of added) {
    const at = order.findIndex((o) => value(item) > value(o))
    if (at === -1) order.push(item)
    else order.splice(at, 0, item)
  }
  // Bubble only clear overtakes; this can't oscillate, so it settles.
  const overtakes = (lower: T, upper: T) => value(lower) > value(upper) * 1.15 + noise
  for (let pass = 0; pass < order.length; pass++) {
    let swapped = false
    for (let i = 0; i < order.length - 1; i++) {
      if (overtakes(order[i + 1], order[i])) {
        ;[order[i], order[i + 1]] = [order[i + 1], order[i]]
        swapped = true
      }
    }
    if (!swapped) break
  }
  return order.map((i) => i.name)
}

/** Plain sorted order, most first. */
export function sortedOrder<T extends { name: string }>(items: T[], value: (item: T) => number): string[] {
  return items
    .slice()
    .sort((a, b) => value(b) - value(a))
    .map((i) => i.name)
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}
