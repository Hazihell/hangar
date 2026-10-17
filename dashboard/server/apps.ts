import type { Process, Report } from './rules.ts';
import type { Machine } from './store.ts';
export type Protection = { windows?: Set<number>; wsl?: Set<number>; t3?: number };
export type App = { name: string; cpu: number; ram: number; count: number; quit: boolean; processes: { pid: number; name: string; cpu: number; ram: number; started: string; quit: boolean }[]; apps?: App[] };
const windows = new Set('vmmemwsl vmmem wsl wslhost wslservice wslrelay svchost startmenuexperiencehost shellexperiencehost textinputhost searchhost explorer dwm csrss winlogon ctfmon sihost fontdrvhost runtimebroker tailscale-ipn tailscaled'.split(' '));
const mac = new Set('windowserver loginwindow dock finder systemuiserver launchd sshd sshd-session tailscaled mac-reporter.sh'.split(' '));
export const executable = (name: string) => name.toLowerCase().replace(/\.exe$/, '');
export function mayQuit(p: Process, machine: Machine, where: 'wsl' | undefined, protection: Protection = {}, reporterPid?: number) {
  if (!p.own || !p.started) return false;
  const name = executable(p.name);
  if (where === 'wsl') return p.pid !== 1 && !['systemd', 'init', 'sshd', 'sshd-session', 'tailscaled'].includes(name) && !protection.wsl?.has(p.pid) && p.pid !== protection.t3;
  if (machine.collector === 'wsl') return !windows.has(name) && !protection.windows?.has(p.pid);
  return !name.startsWith('sshd') && !mac.has(name) && p.app.toLowerCase() !== 'tailscale' && p.pid !== reporterPid;
}
export function top<T extends { cpu: number; ram: number }>(apps: T[], n: number): T[] {
  const cpu = [...apps].sort((a, b) => b.cpu - a.cpu), ram = [...apps].sort((a, b) => b.ram - a.ram);
  return [...new Set([...cpu.slice(0, n), ...ram.slice(0, n)])];
}
export function allApps(processes: Process[], machine: Machine, where?: 'wsl', protection: Protection = {}, reporterPid?: number): App[] {
  const apps = new Map<string, App>();
  for (const p of processes) {
    if (!where && machine.collector === 'wsl' && executable(p.name) === 'vmmemwsl') continue;
    let app = apps.get(p.app);
    if (!app) { app = { name: p.app, cpu: 0, ram: 0, count: 0, quit: false, processes: [] }; apps.set(p.app, app); }
    const quit = mayQuit(p, machine, where, protection, reporterPid);
    app.cpu += p.cpu; app.ram += p.ram; app.count++; app.quit ||= quit;
    app.processes.push({ pid: p.pid, name: p.name, cpu: p.cpu, ram: p.ram, started: p.started, quit });
  }
  for (const app of apps.values()) app.processes = app.processes.sort((a, b) => b.cpu - a.cpu).slice(0, 20);
  return [...apps.values()];
}
export function buildApps(report: Partial<Report>, machine: Machine, at: string, protection: Protection = {}) {
  if (report.processes === undefined && report.wsl === undefined) return null;
  const list = allApps(report.processes ?? [], machine, undefined, protection, report.reporterPid);
  if (machine.collector === 'wsl') {
    const processes = (report.processes ?? []).filter(p => executable(p.name) === 'vmmemwsl');
    // Windows won't tell a user process vmmemWSL's CPU time, so the WSL App's CPU is at least what its Processes add up to.
    const cpu = Math.min(100, Math.max(processes.reduce((s, p) => s + p.cpu, 0), (report.wsl ?? []).reduce((s, p) => s + p.cpu, 0)));
    if (processes.length || report.wsl !== undefined) list.push({ name: 'WSL', cpu, ram: processes.reduce((s, p) => s + p.ram, 0), count: report.wsl?.length ?? 0, quit: false, processes: [], apps: top(allApps(report.wsl ?? [], machine, 'wsl', protection), 10) });
  }
  return { at, list: top(list, 10) };
}
export function minuteApps(report: Partial<Report>, machine: Machine) {
  return [...allApps(report.processes ?? [], machine).map(a => ({ name: a.name, cpu: a.cpu, ram: a.ram })),
    ...allApps(report.wsl ?? [], machine, 'wsl').map(a => ({ name: a.name, where: 'wsl' as const, cpu: a.cpu, ram: a.ram }))];
}
