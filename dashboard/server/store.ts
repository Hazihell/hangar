import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { average, cutoff, minute, online } from './rules.ts';
import type { Report, Point, Vpn } from './rules.ts';
export type Machine = { id: string; name: string; os: string; collector: string; ssh?: string };
export class Store {
  db: DatabaseSync;
  machines: Machine[];
  constructor(path: string, machines: Machine[]) {
    this.machines = machines;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS latest (machine TEXT PRIMARY KEY, at INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (machine TEXT, t INTEGER, cpu REAL, ram REAL, disk REAL, count INTEGER, PRIMARY KEY(machine,t));`);
  }
  prune(now: number) { this.db.prepare('DELETE FROM history WHERE t < ?').run(cutoff(now)); }
  intake(report: Report, now: number) {
    if (report.vpns === undefined) report = { ...report, vpns: this.vpns(report.machine) };
    const t = minute(now);
    const previous = this.db.prepare('SELECT cpu,ram,disk,count FROM history WHERE machine=? AND t=?').get(report.machine, t) as any;
    const p = average(previous, report);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?,?)').run(report.machine, now, JSON.stringify(report));
      this.db.prepare('INSERT OR REPLACE INTO history VALUES (?,?,?,?,?,?)').run(report.machine, t, p.cpu, p.ram, p.disk, p.count);
      this.prune(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  vpns(id: string): Vpn[] {
    const row = this.db.prepare('SELECT report FROM latest WHERE machine=?').get(id) as any;
    return row ? JSON.parse(row.report).vpns ?? [] : [];
  }
  snapshot(machine: Machine, now: number) {
    const latest = this.db.prepare('SELECT at,report FROM latest WHERE machine=?').get(machine.id) as any;
    const { collector, ssh, ...identity } = machine;
    const at = latest ? new Date(latest.at).toISOString() : null;
    const report = latest ? JSON.parse(latest.report) : null;
    const vpns = report?.vpns ?? [];
    if (report) { delete report.machine; delete report.vpns; }
    const history = this.db.prepare('SELECT t,cpu,ram,disk FROM history WHERE machine=? AND t>=? ORDER BY t DESC LIMIT 1440').all(machine.id, cutoff(now)).reverse().map((p: any): Point => ({ ...p, t: new Date(p.t).toISOString() }));
    return { ...identity, online: online(latest?.at ?? null, now), lastSeen: at, usage: report ? { at, ...report } : null, vpns: vpns.map((v: any) => ({ name: v.name, status: v.status, pending: null, error: null })), history };
  }
  event(machine: Machine, now: number) {
    const { history, ...state } = this.snapshot(machine, now);
    return { ...state, minute: history.find(p => p.t === new Date(minute(now)).toISOString()) ?? null };
  }
  close() { this.db.close(); }
}
