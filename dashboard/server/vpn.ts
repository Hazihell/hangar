import { readFileSync } from 'node:fs';
import type { Machine } from './store.ts';
import type { Vpn } from './rules.ts';
import type { VpnAction as Action, Vpn as WireVpn } from '../contract.ts';
export type { VpnAction as Action } from '../contract.ts';
export const VPN_TIMEOUT = 90_000;
export type Exec = (file: string, args: string[], options: { timeout: number; encoding?: 'utf8'; maxBuffer?: number; detached?: boolean }, callback: (error: any, stdout: string, stderr: string) => void) => unknown;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function vpnCommand(machine: Machine, vpn: Vpn, action: Action) {
  if (machine.collector === 'wsl') {
    if (action === 'disconnect') return { file: '/mnt/c/Windows/System32/rasdial.exe', args: [vpn.name, '/disconnect'], timeout: 20_000 };
    const script = readFileSync(new URL('./vpn-windows.ps1', import.meta.url), 'utf8');
    const command = `& {\n${script}\n} -Name ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(vpn.name, 'utf8').toString('base64')}')))`;
    return { file: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], timeout: 80_000 };
  }
  if (!machine.ssh) return null;
  const command = action === 'disconnect' ? '/usr/sbin/scutil --nc stop' : vpn.kind === 'ppp' ? '/usr/sbin/networksetup -connectpppoeservice' : '/usr/sbin/scutil --nc start';
  return { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', machine.ssh, `${command} ${quote(vpn.name)}`], timeout: 30_000 };
}
export function commandError(error: any, stdout: string, stderr: string) {
  const last = (value: string) => {
    const clean = String(value).replace(/\r/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
    return clean.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#<') && !s.startsWith('<Objs')).at(-1);
  };
  return (last(stderr) || last(stdout) || (error.killed ? 'Command timed out' : `exit code ${error.code ?? 1}`)).slice(0, 512);
}

type Command = { machine: Machine; action: Action; pending: { action: Action; since: string } | null; error: { message: string; at: string } | null; timer?: ReturnType<typeof setTimeout> };
type Options = {
  exec: Exec;
  clock: () => number;
  /** The VPNs the Machine last reported. */
  vpns: (id: string) => Vpn[];
  online: (machine: Machine, now: number) => boolean;
  emit: (machine: Machine, now: number) => void;
  /** Called once a command shows `pending`, before it runs: a command that fails at once must not hide a disconnect from the Alerts. */
  started: (now: number) => void;
};
/** A completed disconnect: the report showing the VPN `disconnected` also cleared its `pending`, so the Alerts must be told. */
export type Completed = { machine: string; vpn: string };

/** A VPN command is confirmed by a later report showing the wanted status, or forgotten after 90 s; a successful process exit proves nothing. */
export function createVpn(options: Options) {
  const { exec, clock, emit } = options;
  const commands = new Map<string, Map<string, Command>>();
  let closed = false;
  function clear(command: Command) {
    clearTimeout(command.timer);
    command.pending = null;
  }
  function expire(command: Command, now: number) {
    if (!command.pending || now - Date.parse(command.pending.since) < VPN_TIMEOUT) return false;
    clear(command); command.error = { message: `No change after ${VPN_TIMEOUT / 1000} s`, at: new Date(now).toISOString() };
    return true;
  }
  /** Starts the command; the status is the HTTP answer, 202 once the VPN shows `pending`. */
  function start(machine: Machine, name: string, action: Action): { status: number; message?: string } {
    const vpn = options.vpns(machine.id).find(v => v.name === name);
    if (!vpn) return { status: 404 };
    const command = vpnCommand(machine, vpn, action);
    if (!command) return { status: 404, message: 'no way to reach this Machine' };
    const now = clock();
    if (!options.online(machine, now) || commands.get(machine.id)?.get(name)?.pending) return { status: 409 };
    const current: Command = { machine, action, pending: { action, since: new Date(now).toISOString() }, error: null };
    if (!commands.has(machine.id)) commands.set(machine.id, new Map());
    commands.get(machine.id)!.set(name, current);
    current.timer = setTimeout(() => { if (expire(current, now + VPN_TIMEOUT)) emit(machine, clock()); }, VPN_TIMEOUT);
    emit(machine, now); options.started(now);
    const done = (error: any, stdout: string, stderr: string) => {
      if (closed || commands.get(machine.id)?.get(name) !== current || !current.pending || !error) return;
      clear(current); current.error = { message: commandError(error, stdout, stderr), at: new Date(clock()).toISOString() };
      emit(machine, clock());
    };
    try { exec(command.file, command.args, { timeout: command.timeout, encoding: 'utf8' }, done); } catch (error) { done(error, '', ''); }
    return { status: 202 };
  }
  /**
   * Settles the Machine's commands against a report: a VPN that reached the wanted status, or left the list, is done.
   * `reported` is undefined when the report carries no list, which settles nothing. Returns the disconnects the report completed,
   * which the caller must hand to the Alerts before anything else evaluates them.
   */
  function reconcile(machine: Machine, reported: Vpn[] | undefined): Completed[] {
    const completed: Completed[] = [];
    if (reported === undefined) return completed;
    for (const [name, command] of commands.get(machine.id) ?? []) {
      const vpn = reported.find(v => v.name === name);
      if (!vpn) { clear(command); commands.get(machine.id)!.delete(name); }
      else if (vpn.status === (command.action === 'connect' ? 'connected' : 'disconnected')) {
        if (command.action === 'disconnect' && command.pending) completed.push({ machine: machine.id, vpn: name });
        clear(command); command.error = null;
      }
    }
    return completed;
  }
  function tick(now: number) {
    for (const byName of commands.values()) {
      const expired = [...byName.values()].filter(command => expire(command, now));
      if (expired.length) emit(expired[0].machine, now);
    }
  }
  /** The Machine's VPNs with the state of their commands. */
  const state = (id: string, vpns: WireVpn[]): WireVpn[] => vpns.map(vpn => {
    const command = commands.get(id)?.get(vpn.name);
    return command ? { ...vpn, pending: command.pending, error: command.error } : vpn;
  });
  return { start, reconcile, tick, state, close() { closed = true; for (const byName of commands.values()) for (const command of byName.values()) clear(command); commands.clear(); } };
}
