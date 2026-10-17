import { postCommand } from "@/lib/machine-command"
import type { VpnAction, VpnStatus } from "@/lib/types"

/** Said when the server's answer carries no message of its own. */
const REFUSALS: Record<number, string> = {
  400: "The server didn’t accept that command.",
  403: "The server only takes this from the Dashboard’s own address.",
  404: "This Machine no longer reports that VPN.",
  409: "Not now: the Machine is Offline, or a command is already under way.",
}

/**
 * Asks the server to connect or disconnect one VPN, once (API.md:
 * `POST /api/machines/:id/vpns/:name`). Resolves on 202; the outcome arrives
 * later as `machine` events. Throws a MachineCommandError with a sentence to show.
 */
export async function sendVpnCommand(machineId: string, name: string, action: VpnAction): Promise<void> {
  const url = `/api/machines/${encodeURIComponent(machineId)}/vpns/${encodeURIComponent(name)}`
  await postCommand(url, { action }, { refusals: REFUSALS, fallback: "The server couldn’t take the command" })
}

/** The status a command ends in. */
export function targetOf(action: VpnAction): VpnStatus {
  return action === "connect" ? "connected" : "disconnected"
}
