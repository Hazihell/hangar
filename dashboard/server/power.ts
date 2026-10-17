import type { Machine } from './store.ts';
import type { Exec } from './vpn.ts';

import type { PowerAction as Action, Power } from '../contract.ts';
export const POWER_TIMEOUT = 120_000;
type Command = { machine: Machine; value: Power; timer?: ReturnType<typeof setTimeout> };
const suspend = "Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)) { exit 1 }";

/** Power requests are confirmed by suspension (or forgotten at restart), never by a successful process exit. */
export function createPower(exec: Exec, clock: () => number, emit: (machine: Machine, now: number) => void, observe: () => void, resumed: (now: number) => void) {
  const commands = new Map<string, Command>();
  let closed = false;
  const empty = (): Power => ({ actions: ['sleep', 'shutdown'], pending: null, error: null });
  function clear(command: Command) {
    clearTimeout(command.timer);
    command.value.pending = null;
  }
  function start(machine: Machine, action: Action, now: number) {
    const current: Command = { machine, value: { ...empty(), pending: { action, since: new Date(now).toISOString() } } };
    commands.set(machine.id, current);
    emit(machine, now);
    current.timer = setTimeout(() => {
      if (closed) return;
      observe();
      if (!current.value.pending) return;
      const file = action === 'sleep' ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/mnt/c/Windows/System32/shutdown.exe';
      const args = action === 'sleep' ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(suspend, 'utf16le').toString('base64')] : ['/s', '/t', '0'];
      const done = (error: any, _stdout: string, stderr: string) => {
        if (closed) return;
        observe();
        // SetSuspendState returns true only once the PC is awake again, which is surer than WSL's clock catching up.
        if (!error && action === 'sleep') { if (commands.get(machine.id) === current) resumed(clock()); return; }
        if (!error || !current.value.pending || commands.get(machine.id) !== current) return;
        clear(current);
        // Never expose execFile's error.message: it includes the entire command line.
        const first = String(stderr ?? '').split(/[\r\n]/).map(s => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()).find(Boolean);
        current.value.error = { message: (first || `Power command failed (exit code ${Number.isInteger(error.code) ? error.code : 1})`).slice(0, 160), at: new Date(clock()).toISOString() };
        emit(machine, clock());
      };
      // SetSuspendState returns only after resume; zero disables execFile's timeout.
      try { exec(file, args, { timeout: 0, encoding: 'utf8' }, done); } catch (error) { done(error, '', ''); }
    }, 1500);
  }
  function resume(now: number) {
    for (const command of commands.values()) if (command.value.pending) {
      clear(command); command.value.error = null; emit(command.machine, now);
    }
  }
  function tick(now: number) {
    for (const command of commands.values()) {
      const pending = command.value.pending;
      if (!pending || now - Date.parse(pending.since) < POWER_TIMEOUT) continue;
      clear(command);
      command.value.error = { message: pending.action === 'sleep' ? `${command.machine.name} didn't go to sleep` : `${command.machine.name} didn't shut down — an app may have blocked it`, at: new Date(now).toISOString() };
      emit(command.machine, now);
    }
  }
  return { start, resume, tick, state: (id: string): Power => commands.get(id)?.value ?? empty(), close() { closed = true; for (const command of commands.values()) clear(command); commands.clear(); } };
}
