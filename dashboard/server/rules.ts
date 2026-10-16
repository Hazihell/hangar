export type Report = { machine: string; cpu: number; ram: { used: number; total: number }; disks: { name: string; used: number; total: number }[]; services?: Record<string, boolean> };
export type Point = { t: string; cpu: number; ram: number; disk: number };
export const minute = (now: number) => Math.floor(now / 60_000) * 60_000;
export const cutoff = (now: number) => now - 86_400_000;
export const online = (at: number | null, now: number) => at !== null && now - at < 30_000;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bytes = (v: unknown) => object(v) && finite(v.used) && finite(v.total) && v.total > 0 && v.used >= 0 && v.used <= v.total;
export function validReport(v: unknown): v is Report {
  return object(v) && typeof v.machine === 'string' && v.machine.length > 0 && finite(v.cpu) && v.cpu >= 0 && v.cpu <= 100 &&
    bytes(v.ram) && Array.isArray(v.disks) && v.disks.every(d => bytes(d) && typeof d.name === 'string' && d.name.length > 0) &&
    (v.services === undefined || (object(v.services) && Object.values(v.services).every(x => typeof x === 'boolean')));
}
export function percentages(report: Report) {
  return { cpu: report.cpu, ram: report.ram.used / report.ram.total * 100, disk: Math.max(0, ...report.disks.map(d => d.used / d.total * 100)) };
}
export function average(previous: { cpu: number; ram: number; disk: number; count: number } | undefined, report: Report) {
  const p = percentages(report), n = previous?.count ?? 0;
  return { cpu: ((previous?.cpu ?? 0) * n + p.cpu) / (n + 1), ram: ((previous?.ram ?? 0) * n + p.ram) / (n + 1), disk: ((previous?.disk ?? 0) * n + p.disk) / (n + 1), count: n + 1 };
}
