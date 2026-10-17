import type { Process } from './rules.ts';
import type { Report } from './usage.ts';
import type { Machine } from './store.ts';
import { executable, mayQuit } from './quit.ts';
import type { Protection } from './quit.ts';
import type { App, Apps } from '../contract.ts';
export type { App } from '../contract.ts';
export const PROCESS_LIMIT = 20;
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
  for (const app of apps.values()) app.processes = app.processes.sort((a, b) => b.cpu - a.cpu).slice(0, PROCESS_LIMIT);
  return [...apps.values()];
}
export function buildApps(report: Partial<Report>, machine: Machine, at: string, protection: Protection = {}): Apps | null {
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
