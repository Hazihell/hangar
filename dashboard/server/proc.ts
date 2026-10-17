import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { Process } from './rules.ts';

export type Proc = { pid: number; name: string; started: string; uid: number; ppid: number; ticks: number; ram: number };
// Linux/WSL exposes USER_HZ ticks and resident pages; getconf confirms 100 and 4096.
export function readProc(pid: number, read = (path: string) => readFileSync(path, 'utf8')): Proc {
  const stat = read(`/proc/${pid}/stat`);
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('invalid proc stat');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const uid = /^Uid:\s+(\d+)/m.exec(read(`/proc/${pid}/status`));
  if (!uid) throw new Error('missing proc uid');
  const name = read(`/proc/${pid}/comm`).replace(/\n$/, '');
  const resident = read(`/proc/${pid}/statm`).trim().split(/\s+/)[1];
  const result = { pid, name, started: fields[19], uid: Number(uid[1]), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), ram: Number(resident) * 4096 };
  if (!result.name || !result.started || ![result.ppid, result.ticks, result.ram].every(Number.isFinite)) throw new Error('invalid proc stat');
  return result;
}
export function createProcCollector(options: { list?: () => string[]; read?: (pid: number) => Proc; now?: () => number; cpus?: number | (() => number); uid?: number } = {}) {
  const list = options.list ?? (() => readdirSync('/proc'));
  const read = options.read ?? readProc, now = options.now ?? (() => performance.now());
  const cpus = options.cpus ?? availableParallelism(), uid = options.uid ?? process.getuid?.();
  let previous = new Map<string, number>(), last: number | undefined;
  return (): Process[] => {
    const coreCount = typeof cpus === 'function' ? cpus() : cpus;
    const time = now(), elapsed = last === undefined ? 0 : (time - last) / 1000;
    const next = new Map<string, number>(), result: Process[] = [];
    for (const entry of list()) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const proc = read(Number(entry)), key = `${proc.pid}:${proc.started}`, before = previous.get(key);
        next.set(key, proc.ticks);
        result.push({ pid: proc.pid, name: proc.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), app: proc.name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\.exe$/i, ''), started: proc.started, own: proc.uid === uid,
          cpu: before === undefined || elapsed <= 0 ? 0 : Math.min(100, Math.max(0, (proc.ticks - before) / 100 / elapsed / Math.max(1, coreCount) * 100)), ram: proc.ram });
      } catch { /* A Process can exit or become unreadable during a sample. */ }
    }
    previous = next; last = time;
    const retained = new Set([...result.sort((a, b) => b.ram - a.ram).slice(0, 300), ...[...result].sort((a, b) => b.cpu - a.cpu).slice(0, 100)]);
    return [...retained].sort((a, b) => b.ram - a.ram);
  };
}
