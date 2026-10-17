import { buildApps, minuteApps, top } from './apps.ts';
import type { Protection } from './quit.ts';
import type { DatabaseSync } from 'node:sqlite';
import { cutoff, finite, minute, object, online, pid, text, token } from './rules.ts';
import type { Process, Vpn } from './rules.ts';
import type { Machine } from './store.ts';
import type { Temps, Report, ReportVpn, HistoryPoint as Point, Machine as WireMachine, MachineEvent, MinuteResponse } from '../contract.ts';
export type { Temps, Report, ReportVpn, HistoryPoint as Point } from '../contract.ts';
/** `status` is the HTTP answer; an accepted report comes back as the Machine and the normalised report that was recorded. */
export type Intake = { status: 204; machine: Machine; report: Report } | { status: 400 | 404 | 500 };
const bytes = (v: unknown) => object(v) && finite(v.used) && finite(v.total) && v.total > 0 && v.used >= 0 && v.used <= v.total;
const processRow = (p: unknown): p is Process => object(p) && pid(p.pid) && text(p.name) && text(p.app) && finite(p.cpu) && p.cpu >= 0 && p.cpu <= 100 && finite(p.ram) && p.ram >= 0 && token(p.started) && typeof p.own === 'boolean';
const temp = (v: unknown): v is number => finite(v) && v >= -20 && v <= 150;
const processes = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 2000);
/**
 * A new Report from a Machine's reported Usage, or null if it is malformed. Nothing is carried over that this doesn't name, and `value` is left alone.
 * What can go wrong in one part is dropped alone: a malformed Process row, or a Temperature reading out of range.
 */
export function acceptReport(value: unknown): Report | null {
  const v = value;
  if (!(object(v) && typeof v.machine === 'string' && v.machine.length > 0 && finite(v.cpu) && v.cpu >= 0 && v.cpu <= 100 &&
    processes(v.processes) && processes(v.wsl) && (v.reporterPid === undefined || pid(v.reporterPid)) && (v.temps === undefined || object(v.temps)) &&
    bytes(v.ram) && Array.isArray(v.disks) && v.disks.every(d => bytes(d) && typeof d.name === 'string' && d.name.length > 0) &&
    (v.services === undefined || (object(v.services) && Object.values(v.services).every(x => typeof x === 'boolean'))) &&
    (v.vpns === undefined || (Array.isArray(v.vpns) && v.vpns.every(vpn => object(vpn) && typeof vpn.name === 'string' && vpn.name.length > 0 && vpn.name.length <= 256 && !/^[\/-]|["\x00-\x1f\x7f-\x9f]/.test(vpn.name) && ['connected', 'disconnected', 'connecting', 'disconnecting'].includes(vpn.status) && ['ppp', 'other'].includes(vpn.kind)))))) return null;
  const report: Report = { machine: v.machine, cpu: v.cpu, ram: { used: v.ram.used, total: v.ram.total }, disks: v.disks.map(d => ({ name: d.name, used: d.used, total: d.total })) };
  if (v.services !== undefined) report.services = { ...v.services };
  if (v.vpns !== undefined) report.vpns = v.vpns.map((x: ReportVpn) => ({ name: x.name, status: x.status, kind: x.kind }));
  // Preserve healthy Usage when an OS Process disappears or produces a malformed row.
  if (v.processes !== undefined) report.processes = v.processes.filter(processRow);
  if (v.wsl !== undefined) report.wsl = v.wsl.filter(processRow);
  if (v.reporterPid !== undefined) report.reporterPid = v.reporterPid;
  // A reading that is out of range is dropped alone, and a report left with none has no temps.
  if (v.temps !== undefined) {
    const temps: Temps = {};
    if (temp(v.temps.cpu)) temps.cpu = v.temps.cpu;
    if (temp(v.temps.gpu)) temps.gpu = v.temps.gpu;
    if (temps.cpu !== undefined || temps.gpu !== undefined) report.temps = temps;
  }
  return report;
}
function percentages(report: Report) {
  return { cpu: report.cpu, ram: report.ram.used / report.ram.total * 100, disk: Math.max(0, ...report.disks.map(d => d.used / d.total * 100)) };
}
/** `temp` averages only the reports that had a CPU temperature, `tcount` of them. */
function average(previous: { cpu: number; ram: number; disk: number; count: number; temp: number | null; tcount: number } | undefined, report: Report) {
  const p = percentages(report), n = previous?.count ?? 0, k = previous?.tcount ?? 0, t = report.temps?.cpu;
  return { cpu: ((previous?.cpu ?? 0) * n + p.cpu) / (n + 1), ram: ((previous?.ram ?? 0) * n + p.ram) / (n + 1), disk: ((previous?.disk ?? 0) * n + p.disk) / (n + 1), count: n + 1,
    temp: t === undefined ? previous?.temp ?? null : ((previous?.temp ?? 0) * k + t) / (k + 1), tcount: t === undefined ? k : k + 1 };
}
/**
 * Every Machine's Usage: accepts a report, keeps what an omitted field should keep, and records the latest report, its History minute and its Top Apps.
 * Reads of the same come back as `snapshot`, `event` and `topApps`. The tables are this module's own; `db` may be shared with others.
 */
export class Usage {
  private db: DatabaseSync;
  private machines: Machine[];
  private protection: Protection;
  private known = new Map<string, Partial<Report> & { at: string }>();
  private minuteSums = new Map<string, { t: number; sums: Map<string, any> }>();
  constructor(db: DatabaseSync, machines: Machine[], protection: Protection = {}) {
    this.db = db; this.machines = machines; this.protection = protection;
    db.exec(`CREATE TABLE IF NOT EXISTS latest (machine TEXT PRIMARY KEY, at INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (machine TEXT, t INTEGER, cpu REAL, ram REAL, disk REAL, count INTEGER, temp REAL, tcount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(machine,t));
      CREATE TABLE IF NOT EXISTS top_apps (machine TEXT, t INTEGER, sums TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(machine,t));`);
    if (!(db.prepare('PRAGMA table_info(history)').all() as any[]).some(c => c.name === 'temp')) {
      db.exec('ALTER TABLE history ADD COLUMN temp REAL; ALTER TABLE history ADD COLUMN tcount INTEGER NOT NULL DEFAULT 0');
    }
    if (!(db.prepare('PRAGMA table_info(top_apps)').all() as any[]).some(c => c.name === 'samples')) {
      db.exec('ALTER TABLE top_apps ADD COLUMN samples INTEGER NOT NULL DEFAULT 0; UPDATE top_apps SET samples=COALESCE((SELECT count FROM history WHERE history.machine=top_apps.machine AND history.t=top_apps.t),0)');
    }
  }
  /** 400 for a malformed report, 404 for one from an unknown Machine, 500 if it couldn't be recorded. `beforeRecord` runs once the report is known good, before anything is written. */
  intake(value: unknown, now: number, beforeRecord?: () => void): Intake {
    const report = acceptReport(value);
    if (!report) return { status: 400 };
    const machine = this.machines.find(m => m.id === report.machine);
    if (!machine) return { status: 404 };
    beforeRecord?.();
    try { this.record(machine, report, now); } catch (error) { console.error('Dashboard intake:', error); return { status: 500 }; }
    return { status: 204, machine, report };
  }
  private record(machine: Machine, accepted: Report, now: number) {
    // A report that omits its VPNs leaves the known ones standing; an empty list clears them.
    const report = accepted.vpns === undefined ? { ...accepted, vpns: this.vpns(machine.id) } : accepted;
    const t = minute(now);
    const previous = this.db.prepare('SELECT cpu,ram,disk,count,temp,tcount FROM history WHERE machine=? AND t=?').get(machine.id, t) as any;
    const p = average(previous, report);
    const old = this.db.prepare('SELECT sums,samples FROM top_apps WHERE machine=? AND t=?').get(machine.id, t) as any;
    // Only a report that lists Processes is a sample of the minute's Apps; an omitted list is not an empty one.
    const samples = (old?.samples ?? 0) + (report.processes !== undefined || report.wsl !== undefined ? 1 : 0);
    const current = this.minuteSums.get(machine.id);
    const sums = current?.t === t ? new Map(current.sums) : new Map<string, any>(old ? JSON.parse(old.sums).map((a: any) => [JSON.stringify([a.name, a.where]), a]) : []);
    for (const app of minuteApps(report, machine)) {
      const key = JSON.stringify([app.name, 'where' in app ? app.where : undefined]), prior = sums.get(key);
      sums.set(key, { ...app, cpu: (prior?.cpu ?? 0) + app.cpu, ram: (prior?.ram ?? 0) + app.ram });
    }
    const { processes, wsl, reporterPid, ...persisted } = report;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?,?)').run(machine.id, now, JSON.stringify(persisted));
      this.db.prepare('INSERT OR REPLACE INTO history VALUES (?,?,?,?,?,?,?,?)').run(machine.id, t, p.cpu, p.ram, p.disk, p.count, p.temp, p.tcount);
      this.db.prepare('INSERT OR REPLACE INTO top_apps (machine,t,sums,samples) VALUES (?,?,?,?)').run(machine.id, t, JSON.stringify(top([...sums.values()], 15)), samples);
      this.prune(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.minuteSums.set(machine.id, { t, sums });
    const prior = this.known.get(machine.id);
    if (processes !== undefined || wsl !== undefined) this.known.set(machine.id, { ...prior, ...(processes === undefined ? {} : { processes }), ...(wsl === undefined ? {} : { wsl }), ...(reporterPid === undefined ? {} : { reporterPid }), at: new Date(now).toISOString() });
  }
  prune(now: number) { this.db.prepare('DELETE FROM history WHERE t < ?').run(cutoff(now)); this.db.prepare('DELETE FROM top_apps WHERE t < ?').run(cutoff(now)); for (const [id, value] of this.minuteSums) if (value.t < minute(now)) this.minuteSums.delete(id); }
  /** The Processes last reported, kept in memory only: an omitted list leaves the last one in place. */
  processes(id: string) { return this.known.get(id); }
  vpns(id: string): Vpn[] {
    const row = this.db.prepare('SELECT report FROM latest WHERE machine=?').get(id) as any;
    return row ? JSON.parse(row.report).vpns ?? [] : [];
  }
  topApps(id: string, t: string, now: number): MinuteResponse | null {
    const time = Date.parse(t);
    if (!Number.isFinite(time) || time < cutoff(now)) return null;
    const row = this.db.prepare('SELECT a.samples,a.sums FROM history h LEFT JOIN top_apps a ON a.machine=h.machine AND a.t=h.t WHERE h.machine=? AND h.t=?').get(id, time) as any;
    return row ? { t: new Date(time).toISOString(), apps: top((row.sums ? JSON.parse(row.sums) : []).map((a: any) => ({ ...a, cpu: a.cpu / (row.samples || 1), ram: a.ram / (row.samples || 1) })), 5) } : null;
  }
  snapshot(machine: Machine, now: number, withHistory = true): WireMachine {
    const latest = this.db.prepare('SELECT at,report FROM latest WHERE machine=?').get(machine.id) as { at: number; report: string } | undefined;
    const { collector, ssh, ...identity } = machine;
    const at = latest ? new Date(latest.at).toISOString() : null;
    const report: Report | null = latest ? JSON.parse(latest.report) : null;
    const vpns = report?.vpns ?? [];
    const usage = report && at ? { at, cpu: report.cpu, ram: report.ram, disks: report.disks, ...(report.services === undefined ? {} : { services: report.services }), ...(report.temps === undefined ? {} : { temps: report.temps }) } : null;
    const history = !withHistory ? [] : this.db.prepare('SELECT t,cpu,ram,disk,temp FROM history WHERE machine=? AND t>=? ORDER BY t DESC LIMIT 1440').all(machine.id, cutoff(now)).reverse().map((p: any): Point => ({ t: new Date(p.t).toISOString(), cpu: p.cpu, ram: p.ram, disk: p.disk, temp: p.temp }));
    const known = this.known.get(machine.id);
    const apps = known ? buildApps(known, machine, known.at, this.protection) : null;
    return { ...identity, apps, online: online(latest?.at ?? null, now), lastSeen: at, usage, vpns: vpns.map(v => ({ name: v.name, status: v.status, pending: null, error: null })), history };
  }
  event(machine: Machine, now: number): MachineEvent {
    const { history, ...state } = this.snapshot(machine, now);
    return { ...state, minute: history.find(p => p.t === new Date(minute(now)).toISOString()) ?? null };
  }
}
