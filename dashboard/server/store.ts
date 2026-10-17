import { buildApps, minuteApps, top } from './apps.ts';
import type { Protection } from './apps.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { average, cutoff, minute, online } from './rules.ts';
import type { Report, Point, Vpn } from './rules.ts';
export type Machine = { id: string; name: string; os: string; collector: string; ssh?: string };
export class Store {
  db: DatabaseSync;
  machines: Machine[];
  processes = new Map<string, Partial<Report> & { at: string }>();
  protection: Protection = {};
  minuteSums = new Map<string, { t: number; sums: Map<string, any> }>();
  constructor(path: string, machines: Machine[]) {
    this.machines = machines;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS latest (machine TEXT PRIMARY KEY, at INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (machine TEXT, t INTEGER, cpu REAL, ram REAL, disk REAL, count INTEGER, temp REAL, tcount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(machine,t));
      CREATE TABLE IF NOT EXISTS top_apps (machine TEXT, t INTEGER, sums TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(machine,t));`);
    if (!(this.db.prepare('PRAGMA table_info(history)').all() as any[]).some(c => c.name === 'temp')) {
      this.db.exec('ALTER TABLE history ADD COLUMN temp REAL; ALTER TABLE history ADD COLUMN tcount INTEGER NOT NULL DEFAULT 0');
    }
    if (!(this.db.prepare('PRAGMA table_info(top_apps)').all() as any[]).some(c => c.name === 'samples')) {
      this.db.exec('ALTER TABLE top_apps ADD COLUMN samples INTEGER NOT NULL DEFAULT 0; UPDATE top_apps SET samples=COALESCE((SELECT count FROM history WHERE history.machine=top_apps.machine AND history.t=top_apps.t),0)');
    }
  }
  prune(now: number) { this.db.prepare('DELETE FROM history WHERE t < ?').run(cutoff(now)); this.db.prepare('DELETE FROM top_apps WHERE t < ?').run(cutoff(now)); for (const [id, value] of this.minuteSums) if (value.t < minute(now)) this.minuteSums.delete(id); }
  intake(report: Report, now: number) {
    if (report.vpns === undefined) report = { ...report, vpns: this.vpns(report.machine) };
    const t = minute(now);
    const previous = this.db.prepare('SELECT cpu,ram,disk,count,temp,tcount FROM history WHERE machine=? AND t=?').get(report.machine, t) as any;
    const p = average(previous, report);
    const old = this.db.prepare('SELECT sums,samples FROM top_apps WHERE machine=? AND t=?').get(report.machine, t) as any;
    const samples = (old?.samples ?? 0) + (report.processes !== undefined || report.wsl !== undefined ? 1 : 0);
    const current = this.minuteSums.get(report.machine);
    const sums = current?.t === t ? new Map(current.sums) : new Map<string, any>(old ? JSON.parse(old.sums).map((a: any) => [JSON.stringify([a.name, a.where]), a]) : []);
    const machine = this.machines.find(m => m.id === report.machine)!;
    for (const app of minuteApps(report, machine)) {
      const key = JSON.stringify([app.name, 'where' in app ? app.where : undefined]), prior = sums.get(key);
      sums.set(key, { ...app, cpu: (prior?.cpu ?? 0) + app.cpu, ram: (prior?.ram ?? 0) + app.ram });
    }
    const { processes, wsl, reporterPid, ...persisted } = report;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?,?)').run(report.machine, now, JSON.stringify(persisted));
      this.db.prepare('INSERT OR REPLACE INTO history VALUES (?,?,?,?,?,?,?,?)').run(report.machine, t, p.cpu, p.ram, p.disk, p.count, p.temp, p.tcount);
      this.db.prepare('INSERT OR REPLACE INTO top_apps (machine,t,sums,samples) VALUES (?,?,?,?)').run(report.machine, t, JSON.stringify(top([...sums.values()], 15)), samples);
      this.prune(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.minuteSums.set(report.machine, { t, sums });
    const prior = this.processes.get(report.machine);
    if (processes !== undefined || wsl !== undefined) this.processes.set(report.machine, { ...prior, ...(processes === undefined ? {} : { processes }), ...(wsl === undefined ? {} : { wsl }), ...(reporterPid === undefined ? {} : { reporterPid }), at: new Date(now).toISOString() });
  }
  topApps(id: string, t: string, now: number) {
    const time = Date.parse(t);
    if (!Number.isFinite(time) || time < cutoff(now)) return null;
    const row = this.db.prepare('SELECT a.samples,a.sums FROM history h LEFT JOIN top_apps a ON a.machine=h.machine AND a.t=h.t WHERE h.machine=? AND h.t=?').get(id, time) as any;
    return row ? { t: new Date(time).toISOString(), apps: top((row.sums ? JSON.parse(row.sums) : []).map((a: any) => ({ ...a, cpu: a.cpu / (row.samples || 1), ram: a.ram / (row.samples || 1) })), 5) } : null;
  }
  vpns(id: string): Vpn[] {
    const row = this.db.prepare('SELECT report FROM latest WHERE machine=?').get(id) as any;
    return row ? JSON.parse(row.report).vpns ?? [] : [];
  }
  snapshot(machine: Machine, now: number, withHistory = true) {
    const latest = this.db.prepare('SELECT at,report FROM latest WHERE machine=?').get(machine.id) as any;
    const { collector, ssh, ...identity } = machine;
    const at = latest ? new Date(latest.at).toISOString() : null;
    const report = latest ? JSON.parse(latest.report) : null;
    const vpns = report?.vpns ?? [];
    if (report) { delete report.machine; delete report.vpns; }
    const history = !withHistory ? [] : this.db.prepare('SELECT t,cpu,ram,disk,temp FROM history WHERE machine=? AND t>=? ORDER BY t DESC LIMIT 1440').all(machine.id, cutoff(now)).reverse().map((p: any): Point => ({ ...p, t: new Date(p.t).toISOString() }));
    const known = this.processes.get(machine.id);
    const apps = known ? buildApps(known, machine, known.at, this.protection) : null;
    return { ...identity, apps, online: online(latest?.at ?? null, now), lastSeen: at, usage: report ? { at, ...report } : null, vpns: vpns.map((v: any) => ({ name: v.name, status: v.status, pending: null, error: null })), history };
  }
  event(machine: Machine, now: number) {
    const { history, ...state } = this.snapshot(machine, now);
    return { ...state, minute: history.find(p => p.t === new Date(minute(now)).toISOString()) ?? null };
  }
  close() { this.db.close(); }
}
